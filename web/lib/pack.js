// Methods and ethics pack: a Markdown document generated from the run report(s), so the description of
// the data in a paper says what was actually done. Pure and unit-tested. Nothing here is legal advice;
// the checklist points at the decisions a researcher has to make and document.
const n = (x) => Number(x || 0).toLocaleString("en-US");
const pct = (x) => (x === null || x === undefined ? "n/a" : (x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0) + "%");
const day = (iso) => (iso ? String(iso).slice(0, 10) : "");

export const COLUMN_NOTES = [
  ["post_id", "Reddit base-36 id of the post; join key"],
  ["subreddit", "community, without r/"],
  ["post_title / post_selftext", "title and body as the archive holds them; the body reads [removed] (moderators or Reddit) or [deleted] (author) when it was taken down before the archive's copy"],
  ["post_author / comment_author", "user name, or a salted SHA-256 pseudonym when pseudonymisation was on; [deleted] and AutoModerator are kept literally"],
  ["post_created_utc, …_datetime, …_date, …_day_of_week, …_hour_utc", "creation time, UTC"],
  ["post_score, post_upvote_ratio, comment_score", "SNAPSHOT taken by the archive when it re-visited the item (see …_score_as_of), not the current value"],
  ["post_score_as_of / comment_score_as_of", "when that snapshot was taken"],
  ["post_num_comments", "Reddit's own counter at the snapshot; it counts removed comments the archive may not hold"],
  ["post_comments_complete", "TRUE when the comment tree was walked to its end AND at least 95 % of post_num_comments was retrieved"],
  ["comment_id, comment_parent_id, comment_depth", "reply structure; parent ids start with t3_ (the post) or t1_ (a comment); depth 0 = top level, empty = parent not in the archive"],
  ["comment_is_submitter", "TRUE when the comment was written by the post's author"],
  ["row_type", "comment, or post_only for a post without retrieved comments"],
  ["query", "keyword(s) that found the post, ;-separated; empty when no keyword search was used"],
  ["run_label, run_id", "only in merged files: which run a row came from"],
  ["sample_group, match_post_id, flag_<filter>", "only in runs built in the Design panel: target / control / sample, the target a control was matched to, and one boolean per regex filter"],
  ["post_body_state, comment_body_state", "only with analysis columns on: intact / removed / deleted / empty"],
];

function scopeSentence(m) {
  if (m.scope === "ids") return `a list of ${n(m.counts?.ids_requested)} post ids (${n(m.counts?.ids_not_in_archive)} of them were not in the archive)`;
  if (m.scope === "authors") return `every post made in the community by ${n(m.author_panel?.authors)} accounts (an author panel)`;
  if (m.scope === "count") return `the most recent posts up to the limit set for the run`;
  const w = m.window_utc;
  return w ? `all posts created between ${day(w.from)} and ${day(w.to)} (UTC)` : "all archived posts of the community";
}

function designSentences(d) {
  if (!d) return [];
  const filters = (d.filters || []).map((f) => `${f.name} = /${f.regex}/${d.case_sensitive ? "" : "i"}${f.or && f.or.length ? " OR " + f.or.join(" OR ") : ""}`);
  const out = [];
  if (filters.length) out.push(`Posts were classified offline with regular expressions applied to title and body (Unicode-aware word boundaries): ${filters.join("; ")}.`);
  if (d.kind === "sample") out.push(`A ${d.stratify_by && d.stratify_by.length ? "stratified (" + d.stratify_by.join(" × ") + ", proportional allocation)" : "simple"} random sample of ${n(d.posts)} posts was drawn without replacement from ${d.pool} with seed ${d.seed}.`);
  if (d.kind === "matched_controls") out.push(`Targets were the ${n(d.targets)} posts matching ${d.targets_filter}. For each target, ${d.k} control post(s) not matching ${d.controls_exclude_filter} were drawn without replacement from the same ${(d.match_on || []).join(" × ") || "population"} stratum (quartiles computed within the month's population), seed ${d.seed}; ${n(d.controls)} controls were obtained${d.shortfall ? `; ${n(d.shortfall)} control slots could not be filled because their stratum ran out of eligible posts${d.targets_without_control ? `, leaving ${n(d.targets_without_control)} target(s) without any control` : ""}` : ""}.`);
  if (d.kind === "author_panel") out.push(`Accounts with at least ${d.min_posts} posts in a prior run were selected (${n(d.authors)} accounts) and all their posts in the community were collected.`);
  return out;
}

export function buildMethodsPack(manifests, { pseudonymised = false, generatedAt = new Date().toISOString() } = {}) {
  const ms = manifests.filter(Boolean);
  if (!ms.length) return "# Methods and ethics pack\n\nNo run report available.\n";
  const subs = Array.from(new Set(ms.map((m) => m.subreddit)));
  const posts = ms.reduce((s, m) => s + (m.counts?.posts || 0), 0), comments = ms.reduce((s, m) => s + (m.counts?.comments || 0), 0);
  const incomplete = ms.reduce((s, m) => s + (m.counts?.posts_with_incomplete_comments || 0), 0);
  const withComments = ms.some((m) => m.include_comments);
  const from = ms.map((m) => m.window_utc?.from).filter(Boolean).sort()[0], to = ms.map((m) => m.window_utc?.to).filter(Boolean).sort().slice(-1)[0];
  const collected = [ms.map((m) => m.started_at).filter(Boolean).sort()[0], ms.map((m) => m.finished_at).filter(Boolean).sort().slice(-1)[0]];
  const keywords = Array.from(new Set(ms.flatMap((m) => m.keywords || [])));
  const gaps = ms.flatMap((m) => (m.chunks || []).filter((c) => c.status === "failed").map((c) => `${day(c.from_utc)} to ${day(c.to_utc)} (r/${m.subreddit})`));
  const statuses = Array.from(new Set(ms.map((m) => m.status)));
  const ca = ms.map((m) => m.content_availability).filter(Boolean);
  const intact = ca.length ? ca.reduce((s, c) => s + (c.post_bodies?.intact || 0), 0) / Math.max(1, ca.reduce((s, c) => s + ["intact", "removed", "deleted", "empty"].reduce((t, k) => t + (c.post_bodies?.[k] || 0), 0), 0)) : null;
  const snap = ms.map((m) => m.score_snapshot).filter((s) => s && s.median_hours != null);
  const design = ms.map((m) => m.design).find(Boolean);

  const methods = [];
  methods.push(`Data were collected from ${subs.map((s) => "r/" + s).join(", ")} with LemonSqueeze (web app) ${day(collected[0]) === day(collected[1]) || !collected[1] ? "on " + day(collected[0]) : "between " + day(collected[0]) + " and " + day(collected[1])} (the date the tool ran, not the period the data cover). The source was the Arctic Shift archive of Reddit (https://arctic-shift.photon-reddit.com), not the Reddit API; the archive ingests posts and comments as they appear and re-visits each item once, roughly a day and a half later.`);
  methods.push(ms.length > 1
    ? `The collection consisted of ${ms.length} runs${from ? ` covering ${day(from)} to ${day(to)} (UTC)` : ""}; each run retrieved ${scopeSentence(ms[0]).replace(/between .* \(UTC\)/, "in its time window")}.`
    : `The run retrieved ${scopeSentence(ms[0])}.`);
  if (keywords.length) methods.push(`Posts were found with the archive's full-text search, one pass per keyword (${keywords.map((k) => `"${k}"`).join(", ")}); a post found by several keywords was kept once and the keywords recorded. Full-text search matches title and body as indexed by the archive, so recall should be checked against an unfiltered sample.`);
  else if (ms[0].scope !== "ids" && ms[0].scope !== "authors") methods.push(`No keyword filter was applied at collection: posts were listed newest to oldest and paged to exhaustion, deduplicated on post id.`);
  methods.push(...designSentences(design));
  methods.push(`In total ${n(posts)} posts${withComments ? ` and ${n(comments)} comments` : ""} were retrieved.`);
  if (withComments) methods.push(`Comment trees were retrieved in full from the archive (${ms[0].comment_method || "per-post walks"}). A post's tree counts as complete when the walk reached its end and at least 95 % of Reddit's own comment counter was retrieved; ${n(incomplete)} of ${n(posts)} posts (${pct(posts ? incomplete / posts : 0)}) did not meet this and are flagged in post_comments_complete rather than dropped. Reddit's counter includes removed comments that the archive may never have held, so a share below 100 % is expected.`);
  if (gaps.length) methods.push(`Some time spans could not be retrieved after repeated attempts and are missing from the data: ${gaps.join("; ")}.`);
  if (intact !== null) methods.push(`${pct(intact)} of post bodies were intact in the archive; the remainder had been removed by moderators or Reddit, deleted by their authors, or were empty. Analyses of post text therefore describe the surviving posts.`);
  if (snap.length) methods.push(`Scores are snapshots taken by the archive a median of ${Math.round(snap[0].median_hours)} hours after posting (10th–90th percentile ${Math.round(snap[0].p10_hours)}–${Math.round(snap[0].p90_hours)} h), not current values.`);
  else methods.push(`Scores and upvote ratios are the archive's snapshot from its re-visit (see the …_score_as_of columns), not current values.`);
  methods.push(pseudonymised ? `User names were replaced by salted SHA-256 pseudonyms before analysis; the salt was kept by the research team only.` : `User names were exported as they appear on Reddit. [Decide and state how they are handled: pseudonymised on export, removed, or retained with justification.]`);

  const L = [];
  L.push(`# Methods and ethics pack — ${subs.map((s) => "r/" + s).join(", ")}`, "");
  L.push(`Generated ${day(generatedAt)} by LemonSqueeze from ${ms.length} run report${ms.length > 1 ? "s" : ""} (status: ${statuses.join(", ")}). Edit freely: the numbers come from the run reports, the wording is a starting point.`, "");
  L.push("## 1. Methods paragraph", "", methods.join(" "), "");
  L.push("## 2. Limitations to state", "");
  L.push("- **Archive, not Reddit.** Coverage depends on what the archive ingested. Content removed within seconds of posting may never have been captured; a decline in volume can mean less posting or less ingestion.");
  L.push("- **Removed and deleted content.** Bodies read `[removed]` or `[deleted]` when taken down before the archive's copy. Report the intact share" + (intact !== null ? ` (${pct(intact)} here).` : "."));
  L.push("- **Scores are snapshots**, typically from the archive's re-visit about 36 hours after posting; they are not final and not comparable to live Reddit values.");
  L.push("- **Comment counts.** `post_num_comments` is Reddit's counter; the number of retrieved rows is the better measure of what is in the data.");
  L.push("- **Deleted accounts** appear as `[deleted]`; they cannot be linked across posts, so author-level measures undercount.");
  if (keywords.length) L.push("- **Keyword search recall.** The archive's full-text search is not a guaranteed census; validate against an unfiltered sample or collect the community without keywords and filter offline.");
  L.push("");
  L.push("## 3. Runs", "", "| run | community | scope | posts | comments | status | collected |", "|---|---|---|---|---|---|---|");
  for (const m of ms) L.push(`| ${m.export_basename || m.run_id} | r/${m.subreddit} | ${m.batch?.segment || (m.window_utc ? day(m.window_utc.from) + " → " + day(m.window_utc.to) : m.scope)} | ${n(m.counts?.posts)} | ${n(m.counts?.comments)} | ${m.status} | ${day(m.finished_at || m.started_at)} |`);
  L.push("");
  L.push("## 4. Data dictionary (short)", "", "| column(s) | meaning |", "|---|---|");
  for (const [c, d] of COLUMN_NOTES) L.push(`| \`${c}\` | ${d} |`);
  L.push("", "The full dictionary is DATA_DICTIONARY.md in the LemonSqueeze repository.", "");
  L.push("## 5. How to cite", "");
  L.push("- The tool: Heller, J. LemonSqueeze: a Reddit research data collector. https://redditscrapersbe.netlify.app (state the date of use).");
  L.push("- The data source: Arctic Shift, an archive of Reddit posts and comments. https://github.com/ArthurHeitmann/arctic_shift");
  L.push("- State that the data did not come from the Reddit API, and give the collection dates above.", "");
  L.push("## 6. Data management and ethics checklist", "", "Not legal advice. Each line is a decision to make, document, and where required have approved.", "");
  for (const item of [
    "Ethics review: does your institution require approval or an exemption for research on public social-media posts? Obtain and cite it.",
    "Legal basis (GDPR and equivalents): posts can contain personal data and special categories (health, sexuality, beliefs). Record your legal basis, e.g. public-interest research with safeguards, and complete a DPIA if your institution asks for one.",
    `Pseudonymisation: ${pseudonymised ? "author names in this export are salted SHA-256 pseudonyms. Store the salt separately from the data, with access limited to the team." : "this export contains user names. Pseudonymise on export unless you need names and can justify it."}`,
    "User names and identifying details also occur INSIDE post and comment text; pseudonymising the author column does not remove them.",
    "Quotations: verbatim quotes are searchable and can identify their author. Paraphrase, or quote only with a justification; take extra care with sensitive communities.",
    "Vulnerable groups and minors: consider who posts in this community and whether the topic is sensitive; adjust reporting granularity accordingly.",
    "Storage and access: keep raw data on institutional, access-controlled storage; define retention and deletion dates in your data-management plan.",
    "Sharing: share post and comment ids (and your code) rather than text, so others can re-collect what is still public; this respects deletions and Reddit's terms.",
    "Deletion requests: decide how you will handle a user asking for removal from your dataset, and how you will treat content deleted after collection.",
    "Platform terms: review Reddit's current terms and data policies for research use, and note that this data came from a third-party archive.",
    "Guidance: Association of Internet Researchers, Internet Research: Ethical Guidelines 3.0 (2019).",
  ]) L.push(`- [ ] ${item}`);
  L.push("");
  return L.join("\n");
}

const api = { buildMethodsPack, COLUMN_NOTES };
if (typeof window !== "undefined") window.MethodsPack = api;
export default api;
