// Turn a plain-text study description into candidate communities and keywords.
// A language model proposes; the archive verifies every community (exists,
// size, history) before anything is shown. Keywords are counted later by the
// existing `count` action once the researcher picks a community.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

const ARCTIC_SHIFT = "https://arctic-shift.photon-reddit.com";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://redditscrapersbe.netlify.app";
const MODEL = "claude-opus-5";

const Suggestions = z.object({
  communities: z.array(z.object({
    name: z.string().describe("exact subreddit name without r/"),
    role: z.enum(["core", "adjacent", "contrast"]).describe("core: the phenomenon itself; adjacent: where affected others talk; contrast: comparison population"),
    why: z.string().describe("at most 15 words"),
    confidence: z.enum(["high", "medium", "low"]),
  })).max(12),
  keywords: z.array(z.object({
    query: z.string().describe('archive syntax: plain words (all must occur) and/or "quoted phrases"; "a OR b" means two separate complete searches, so each side must stand alone'),
    why: z.string().describe("at most 15 words"),
  })).max(14),
  exclude_terms: z.array(z.string()).max(8).describe("words that mark obvious false positives; empty if none"),
  caveats: z.array(z.string()).max(4).describe("methodological cautions specific to this study, each one sentence"),
});

const SYSTEM = `You help academic researchers build Reddit corpora from a public archive of all of Reddit (posts and comments since 2005, including banned, quarantined and restricted communities).

Given a study description, propose:
1. Communities (exact subreddit names). Include the core communities where the phenomenon is discussed first-hand, adjacent communities where affected others talk about it (partners, family, professionals), and at most two contrast communities. Only name subreddits you are confident exist; mark confidence honestly. Never invent names.
2. Keyword queries for full-text search of post titles and bodies. The archive matches literally: plain words must all occur, "quoted phrases" must occur verbatim. OR is NOT an operator in the archive: "a OR b" is simply run as two separate searches, "a" and "b". So each side of an OR must be a complete, specific query on its own — never write:  wife OR husband "talks to an AI"  (the archive would run the bare query: wife); write:  wife "talks to an AI" OR husband "talks to an AI"  — or two separate queries. Never let a single generic word stand alone as a query or as an OR alternative. There is no stemming, so add common variants (plural, brand names, abbreviations). Prefer the words people actually use when writing about their own experience over academic terms. Between 8 and 14 queries.
3. Exclude terms that mark obvious false positives, if any.
4. Caveats a methods section should mention for this study.

Keep every "why" under 15 words. Do not write anything except the structured output.`;

async function fetchJSON(url) {
  const resp = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "LemonSqueeze/2.0 (academic research tool)" } });
  try { return await resp.json(); } catch { return null; }
}

// Verify one community against the archive: the subreddit record carries exact totals.
async function verifyCommunity(name) {
  const clean = String(name || "").replace(/^\/?r\//, "").trim();
  if (!/^[A-Za-z0-9_]{1,50}$/.test(clean)) return { name: clean, exists: false };
  const data = await fetchJSON(`${ARCTIC_SHIFT}/api/subreddits/search?subreddit=${encodeURIComponent(clean)}&limit=1`);
  const sub = data?.data?.[0];
  if (!sub) return { name: clean, exists: false };
  const meta = sub._meta || {};
  return {
    name: sub.display_name || clean,
    exists: true,
    subscribers: sub.subscribers || 0,
    archived_posts: meta.num_posts || 0,
    archived_comments: meta.num_comments || 0,
    earliest_post: meta.earliest_post || 0,
    over18: !!(sub.over18 || sub.over_18),
    title: sub.title || "",
  };
}

async function verifyAll(communities) {
  const out = [];
  for (let i = 0; i < communities.length; i += 4) {
    const batch = communities.slice(i, i + 4);
    const results = await Promise.all(batch.map((c) => verifyCommunity(c.name).catch(() => ({ name: c.name, exists: false }))));
    results.forEach((r, j) => out.push({ ...batch[j], ...r }));
    if (i + 4 < communities.length) await new Promise((r) => setTimeout(r, 250));
  }
  return out;
}

export async function handler(event) {
  const headers = {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  let description = "";
  try {
    description = String(JSON.parse(event.body || "{}").description || "").trim();
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
  }
  if (description.length < 20) return { statusCode: 400, headers, body: JSON.stringify({ error: "Describe the study in at least a sentence." }) };
  if (description.length > 3000) return { statusCode: 400, headers, body: JSON.stringify({ error: "Keep the description under 3,000 characters." }) };

  const NOT_ENABLED = "Suggestions are not enabled on this deployment (no valid ANTHROPIC_API_KEY). You can still enter communities and keywords yourself.";
  let client;
  try {
    client = new Anthropic(); // resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or a local `ant auth login` profile
  } catch {
    return { statusCode: 503, headers, body: JSON.stringify({ error: NOT_ENABLED }) };
  }
  let parsed;
  try {
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: "low", format: zodOutputFormat(Suggestions) },
      system: SYSTEM,
      messages: [{ role: "user", content: description }],
    });
    parsed = response.parsed_output;
    if (!parsed) throw new Error("The model returned no structured suggestions");
  } catch (err) {
    const credentialProblem = err?.status === 401 || err?.status === 403
      || /credential|api[_ ]?key|ENOENT|not logged in/i.test(String(err?.message || ""));
    if (credentialProblem) {
      return { statusCode: 503, headers, body: JSON.stringify({ error: NOT_ENABLED }) };
    }
    return { statusCode: 502, headers, body: JSON.stringify({ error: String(err?.message || "Suggestion request failed").slice(0, 300) }) };
  }

  const communities = await verifyAll(parsed.communities || []);
  communities.sort((a, b) => (b.exists - a.exists) || ((b.archived_posts || 0) - (a.archived_posts || 0)));

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      description,
      communities,
      keywords: parsed.keywords || [],
      exclude_terms: parsed.exclude_terms || [],
      caveats: parsed.caveats || [],
      model: MODEL,
      generated_at: new Date().toISOString(),
    }),
  };
}
