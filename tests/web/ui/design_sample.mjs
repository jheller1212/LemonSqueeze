// Sampling step: population without filters, stratified sample, reproducible seed, manifest file, hand-off to the ID fetch.
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../devserver.mjs";
import { launch, check, finish, sleep } from "../harness.mjs";

const external = process.argv[2];
const server = external ? null : await startServer(8793);
const url = external || "http://127.0.0.1:8793/";
const dl = join(tmpdir(), "ls-sample-dl");
const b = await launch({ downloadDir: dl });
await b.goto(url);
await b.page(`
  const run = { id: RunStore.newId(), subreddit: "sampletest", status: "complete", createdAt: Date.now(), updatedAt: Date.now(), finishedAt: Date.now(),
    settings: { limit: 1000, includeComments: false, includeSelftext: true, skipNSFW: false, keywords: [] },
    plan: { scope: "range", window: { after: 1735689600, before: 1743465599 }, limit: 1000, queue: [{ sort: "new", label: "New", query: "" }] },
    chunks: [{ i: 0, after: 1, before: 2, status: "done", posts: 600 }], progress: { chunkIdx: 1, modeIdx: 0, after: null, modeFetched: 0, seq: 0, tail: "done" }, counts: { posts: 600, comments: 0 } };
  await RunStore.saveRun(run);
  const posts = [];
  for (let i = 0; i < 600; i++) posts.push({ id: "zzzq" + String(i).padStart(3, "0"), title: i % 6 === 0 ? "my chatbot story " + i : "plain " + i, selftext: i % 5 === 0 ? "[removed]" : "text", author: "u" + (i % 23),
    created_utc: Date.UTC(2025, i % 3, 2 + (i % 25)) / 1000, score: i % 11, num_comments: i % 40, permalink: "x", comments: [], seq: i });
  await RunStore.putPosts(run.id, posts, 0);
`);
await b.goto(url);
await b.page(`document.getElementById("designBlock").open = true; document.getElementById("designBlock").dispatchEvent(new Event("toggle"));`);
await b.waitFor(`return [...document.getElementById("designSource").options].some(o => o.textContent.includes("sampletest"))`);
await b.page(`const s = document.getElementById("designSource"); s.value = [...s.options].find(o => o.textContent.includes("sampletest")).value; s.dispatchEvent(new Event("change"));`);
const load = async (filters) => { await b.page(`document.getElementById("designFilters").value = arg; document.getElementById("designRun").click();`, filters); await b.waitFor(`return !document.getElementById("designRun").disabled`); };

// population only, no filters
await load("");
let s = await b.page(`return { n: window.DesignState.records.length, step: !document.getElementById("designSampleStep").classList.contains("hidden"), pools: document.getElementById("samplePool").options.length, previewHidden: document.getElementById("designPreview").classList.contains("hidden"), err: document.getElementById("designErrors").textContent }`);
check("population loads without any filter", s.n === 600 && s.err === "", `${s.n} ${s.err}`);
check("sample step shown, one pool (whole population), preview hidden", s.step && s.pools === 1 && s.previewHidden, JSON.stringify(s));

const draw = async ({ pool = "all", size, unit = "n", seed = 42, month = true, comments = false, score = false }) => b.page(`
  const set = (id, v) => { const e = document.getElementById(id); if (e.type === "checkbox") e.checked = v; else e.value = v; };
  set("samplePool", arg.pool); set("sampleSize", arg.size); set("sampleUnit", arg.unit); set("sampleSeed", arg.seed); set("stratMonth", arg.month); set("stratComments", arg.comments); set("stratScore", arg.score);
  document.getElementById("sampleDraw").click();
  const d = window.DesignState.sample;
  return { ids: d.items.map(x => x.id), strata: [...document.querySelectorAll("#sampleStrata tbody tr")].map(r => [...r.children].map(c => c.innerText)), summary: document.getElementById("sampleSummary").innerText, months: d.items.reduce((m, x) => { const k = x.stratum.split("|")[0]; m[k] = (m[k] || 0) + 1; return m; }, {}) };`, { pool, size, unit, seed, month, comments, score });

const a1 = await draw({ size: 60 });
const a2 = await draw({ size: 60 });
const a3 = await draw({ size: 60, seed: 7 });
check("sample has the requested size, no duplicates", a1.ids.length === 60 && new Set(a1.ids).size === 60);
check("proportional across months (200 each → 20 each)", JSON.stringify(Object.values(a1.months)) === "[20,20,20]", JSON.stringify(a1.months));
check("same seed → same sample", JSON.stringify(a1.ids) === JSON.stringify(a2.ids));
check("different seed → different sample", JSON.stringify(a1.ids) !== JSON.stringify(a3.ids));
check("summary names the seed and the stratifier", /seed 42/.test(a1.summary) && /month/.test(a1.summary), a1.summary);
const q = await draw({ size: 10, unit: "pct", comments: true });
check("percentage size and month × quartile strata", q.ids.length === 60 && q.strata.length === 12, `${q.ids.length} posts, ${q.strata.length} strata`);

// with a filter: pools for hits and non-hits
await load(String.raw`BOT = \bchatbot\b`);
s = await b.page(`return [...document.getElementById("samplePool").options].map(o => o.textContent)`);
check("pools offer hits and non-hits of each filter", s.length === 3 && /matching BOT \(100\)/.test(s[1]) && /NOT matching BOT \(500\)/.test(s[2]), s.join(" | "));
const h = await draw({ pool: "hit:BOT", size: 30, month: false });
check("sampling from a filter's hits only", h.ids.length === 30 && h.ids.every((id) => Number(id.slice(4)) % 6 === 0));
const big = await draw({ pool: "hit:BOT", size: 5000, month: false });
check("a request larger than the pool is capped and said so", big.ids.length === 100 && /only 100 available/.test(big.summary), big.summary);

// manifest
await draw({ pool: "hit:BOT", size: 30, month: true });
await b.page(`document.getElementById("sampleManifest").click();`);
await sleep(1500);
const mf = b.files().find((f) => f.endsWith("_manifest.csv"));
check("manifest downloaded with a descriptive name", !!mf && /seed42_30posts/.test(mf), String(mf));
if (mf) {
  const lines = readFileSync(join(dl, mf), "utf8").trim().split("\n");
  check("manifest columns", lines[0] === "post_id,sample_group,match_post_id,stratum,controls_matched,seed,flag_bot,post_created_utc,post_num_comments,post_score,post_body_state", lines[0]);
  check("manifest rows: 30, all flagged TRUE with seed 42", lines.length === 31 && lines.slice(1).every((l) => l.split(",")[5] === "42" && l.split(",")[6] === "TRUE"));
}

// hand-off to the ID fetch (ids are synthetic, so the archive holds none of them; the run must still finish cleanly)
await b.page(`document.getElementById("sampleFetch").click();`);
await b.waitFor(`return /^Done|Stopped|Failed/.test(document.getElementById("statusText").textContent) || (currentRun && currentRun.status !== "running" && !abortController)`, { timeout: 120000 });
const run = await b.page(`return { scope: currentRun.plan.scope, n: currentRun.plan.idCount, design: currentRun.design, status: currentRun.status, missing: (currentRun.missingIds || []).length, manifestDesign: currentRun.manifest && currentRun.manifest.design }`);
check("ID run started with the sampled ids and records the design", run.scope === "ids" && run.n === 30 && run.design && run.design.seed === 42 && run.design.kind === "sample", JSON.stringify(run.design));
check("run finished; unknown ids are listed as not in the archive", run.status === "complete" && run.missing === 30, `${run.status} missing=${run.missing}`);
check("run report carries the design (seed, pool, filters)", !!run.manifestDesign && run.manifestDesign.seed === 42 && run.manifestDesign.filters[0].name === "BOT");

await b.page(`document.getElementById("designBlock").open = true;`);
await b.screenshot(join(tmpdir(), "ls-design-sample.png"));
if (server) server.close();
finish(b);
