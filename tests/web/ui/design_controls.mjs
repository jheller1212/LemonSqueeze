// Matched controls end to end with real posts: build the design, check matching rules, fetch both groups,
// and verify that the exported CSV and the run report carry the design.
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../devserver.mjs";
import { launch, check, finish, sleep } from "../harness.mjs";
import { parseCsv } from "../../../web/lib/csvstream.js";

const external = process.argv[2];
const server = external ? null : await startServer(8794);
const url = external || "http://127.0.0.1:8794/";
const dl = join(tmpdir(), "ls-controls-dl");
const b = await launch({ downloadDir: dl });
await b.goto(url);

// population: ~300 real recent posts of a small community, stored as a finished run
const n = await b.page(`
  const posts = []; let before = null;
  for (let page = 0; page < 3; page++) {
    const params = { subreddit: "MyBoyfriendIsAI", limit: 100, sort: "desc" }; if (before) params.before = before;
    const batch = await Archive.get("posts/search", params);
    for (const raw of batch) posts.push(window.Mappers.mapPost(raw));
    if (batch.length < 100) break; before = batch[batch.length - 1].created_utc;
  }
  const uniq = [...new Map(posts.map(p => [p.id, p])).values()];
  const run = { id: RunStore.newId(), subreddit: "MyBoyfriendIsAI", status: "complete", createdAt: Date.now(), updatedAt: Date.now(), finishedAt: Date.now(),
    settings: { limit: 1000, includeComments: false, includeSelftext: true, skipNSFW: false, keywords: [] },
    plan: { scope: "count", window: null, limit: uniq.length, queue: [{ sort: "new", label: "New", query: "" }] },
    chunks: [{ i: 0, after: null, before: null, status: "done", posts: uniq.length }], progress: { chunkIdx: 1, modeIdx: 0, after: null, modeFetched: 0, seq: 0, tail: "done" }, counts: { posts: uniq.length, comments: 0 } };
  await RunStore.saveRun(run);
  await RunStore.putPosts(run.id, uniq.map((p, i) => ({ ...p, comments: [], seq: i })), 0);
  return uniq.length;`);
check("population of real posts stored", n >= 150, String(n));
await b.goto(url);
await b.page(`document.getElementById("designBlock").open = true; document.getElementById("designBlock").dispatchEvent(new Event("toggle"));`);
await b.waitFor(`return document.getElementById("designSource").options.length > 1`);
await b.page(`const s = document.getElementById("designSource"); s.value = [...s.options].find(o => o.value.startsWith("run:")).value; s.dispatchEvent(new Event("change"));
  document.getElementById("designFilters").value = arg; document.getElementById("designRun").click();`, String.raw`GPT = (\bchatgpt\b|\bgpt\b|\b4o\b)
ANYAI = (\bai\b|\bcompanion\b) OR GPT`);
await b.waitFor(`return !document.getElementById("designRun").disabled`, { timeout: 60000 });
const pre = await b.page(`return { step: !document.getElementById("designControlStep").classList.contains("hidden"), t: document.getElementById("ctrlTargets").value, x: document.getElementById("ctrlExclude").value, gpt: window.DesignState.records.filter(r => r.mask & 1).length, any: window.DesignState.records.filter(r => r.mask & 2).length }`);
check("control step appears; defaults are the broadest filter for both", pre.step && pre.t === "ANYAI" && pre.x === "ANYAI", JSON.stringify(pre));
check("filters hit real posts", pre.gpt > 0 && pre.any >= pre.gpt, `GPT=${pre.gpt} ANYAI=${pre.any}`);

// targets = GPT, controls must not match ANYAI, k = 1, matched on month only (small population)
const d = await b.page(`
  document.getElementById("ctrlTargets").value = "GPT"; document.getElementById("ctrlExclude").value = "ANYAI"; document.getElementById("ctrlK").value = 1;
  document.getElementById("ctrlComments").checked = false; document.getElementById("ctrlMonth").checked = true; document.getElementById("ctrlSeed").value = 42;
  document.getElementById("ctrlBuild").click();
  const m = window.DesignState.matched; const recs = new Map(window.DesignState.records.map(r => [r.id, r]));
  const month = (ts) => new Date(ts * 1000).toISOString().slice(0, 7);
  const controls = m.items.filter(x => x.group === "control"), targets = m.items.filter(x => x.group === "target");
  return { targets: targets.length, controls: controls.length, shortfall: m.shortfall, summary: document.getElementById("ctrlSummary").innerText,
    noOverlap: new Set(m.items.map(x => x.id)).size === m.items.length,
    controlsClean: controls.every(c => !(recs.get(c.id).mask & 2)),
    sameMonth: controls.every(c => month(recs.get(c.id).ts) === month(recs.get(c.match).ts)),
    matchedToTargets: controls.every(c => targets.some(t => t.id === c.match)), ids: m.items.map(x => x.id + ":" + x.group) };`);
check("one control per target (or a reported shortfall)", d.controls + d.shortfall === d.targets && d.targets === pre.gpt, `${d.targets} targets, ${d.controls} controls, shortfall ${d.shortfall}`);
check("no post is in both groups; controls match neither filter", d.noOverlap && d.controlsClean);
check("every control is from its target's month and points at a real target", d.sameMonth && d.matchedToTargets);
const again = await b.page(`document.getElementById("ctrlBuild").click(); return window.DesignState.matched.items.map(x => x.id + ":" + x.group)`);
check("same seed → same design", JSON.stringify(again) === JSON.stringify(d.ids));

// manifest
await b.page(`document.getElementById("ctrlManifest").click();`); await sleep(1500);
const mf = b.files().find((f) => f.endsWith("_manifest.csv"));
check("manifest downloaded", !!mf && /design_matched_/.test(mf), String(mf));
if (mf) { const rows = parseCsv(readFileSync(join(dl, mf), "utf8")); check("manifest has both groups and match ids", rows[0].includes("flag_gpt") && rows.slice(1).filter((r) => r[1] === "control").every((r) => r[2]) && rows.slice(1).filter((r) => r[1] === "target").length === d.targets); }

// fetch both groups (posts only, to keep the check quick) and inspect the exports
await b.page(`window.showSaveFilePicker = undefined; document.getElementById("ctrlWithComments").checked = false; document.getElementById("ctrlFetch").click();`);
await b.waitFor(`return /^Done/.test(document.getElementById("statusText").textContent)`, { timeout: 240000 });
await sleep(2500);
const run = await b.page(`return { posts: currentRun.counts.posts, design: { kind: currentRun.design.kind, k: currentRun.design.k, seed: currentRun.design.seed, cols: currentRun.design.columns, ann: Object.keys(currentRun.design.annotations).length }, report: currentRun.manifest.design, reportHasAnnotations: !!(currentRun.manifest.design && currentRun.manifest.design.annotations) }`);
check("run fetched every target and control", run.posts === d.targets + d.controls, `${run.posts} of ${d.targets + d.controls}`);
check("run stores the design and its annotations", run.design.kind === "matched_controls" && run.design.k === 1 && run.design.ann === d.targets + d.controls, JSON.stringify(run.design));
check("run report records the design without the per-post table", run.report && run.report.targets_filter === "GPT" && run.report.controls_exclude_filter === "ANYAI" && !run.reportHasAnnotations);
const csvName = b.files().find((f) => f.endsWith("_combined.csv"));
check("combined CSV downloaded automatically", !!csvName, String(csvName));
if (csvName) {
  const rows = parseCsv(readFileSync(join(dl, csvName), "utf8"));
  const h = rows[0]; const ix = (c) => h.indexOf(c);
  check("design columns trail the 45 schema columns", h.length === 49 && h.slice(-4).join(",") === "sample_group,match_post_id,flag_gpt,flag_anyai" && h[44] === "query", h.slice(-5).join(","));
  const body = rows.slice(1);
  const t = body.filter((r) => r[ix("sample_group")] === "target"), c = body.filter((r) => r[ix("sample_group")] === "control");
  check("rows are labelled target / control with the right flags", t.length === d.targets && c.length === d.controls && t.every((r) => r[ix("flag_gpt")] === "true" && r[ix("match_post_id")] === "") && c.every((r) => r[ix("flag_gpt")] === "false" && r[ix("flag_anyai")] === "false" && r[ix("match_post_id")] !== ""));
}
// a run without a design must export the plain 45 columns
const plain = await b.page(`const rs = await RunStore.listRuns(); const pop = rs.find(r => !r.design); const posts = await RunStore.getPosts(pop.id); return combinedToCSV(posts.slice(0, 2).map(stripStoreFields), false, { subreddit: pop.subreddit }).split("\\n")[0].split(",").length`);
check("runs without a design keep the 45-column schema", plain === 45, String(plain));

if (server) server.close();
finish(b);
