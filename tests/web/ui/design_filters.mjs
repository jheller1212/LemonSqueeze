// Filter lab: population from a saved run and from a CSV.gz file; counts, month table, escaped preview,
// parse errors, Unicode boundaries, and the time limit on a runaway regex.
import { writeFileSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../devserver.mjs";
import { launch, check, finish, sleep } from "../harness.mjs";

const external = process.argv[2];
const server = external ? null : await startServer(8792);
const url = external || "http://127.0.0.1:8792/";
const b = await launch();
await b.goto(url);

// a saved run with known content, including an XSS probe and the açai case
await b.page(`
  const run = { id: RunStore.newId(), subreddit: "designtest", status: "complete", createdAt: Date.now(), updatedAt: Date.now(), finishedAt: Date.now(),
    settings: { limit: 1000, includeComments: false, includeSelftext: true, skipNSFW: false, keywords: [] },
    plan: { scope: "range", window: { after: 1735689600, before: 1743465599 }, limit: 1000, queue: [{ sort: "new", label: "New", query: "" }] },
    chunks: [{ i: 0, after: 1, before: 2, status: "done", posts: 300 }], progress: { chunkIdx: 1, modeIdx: 0, after: null, modeFetched: 0, seq: 0, tail: "done" }, counts: { posts: 300, comments: 0 } };
  await RunStore.saveRun(run);
  const posts = [];
  for (let i = 0; i < 300; i++) {
    const month = i % 3; // Jan, Feb, Mar 2025
    let title = "Ordinary post " + i, selftext = "nothing special here";
    if (i % 10 === 0) { title = "My AI girlfriend " + i; selftext = "he talks to Replika all night"; }
    if (i % 25 === 0) selftext = "I asked ChatGPT about it";
    if (i === 7) { title = "<img src=x onerror=window.__xss=1> ai"; selftext = "<script>window.__xss=1</scr" + "ipt> chatbot"; }
    if (i === 8) { title = "smoothie"; selftext = "do you like açai?"; }
    if (i % 4 === 1) selftext = "[removed]";
    posts.push({ id: "d" + i, title, selftext, author: "u" + (i % 17), created_utc: Date.UTC(2025, month, 2 + (i % 20)) / 1000, score: i % 9, num_comments: i % 30, permalink: "x", comments: [], seq: i });
  }
  await RunStore.putPosts(run.id, posts, 0);
`);
await b.goto(url);
await b.page(`document.getElementById("designBlock").open = true; document.getElementById("designBlock").dispatchEvent(new Event("toggle"));`);
await b.waitFor(`return document.getElementById("designSource").options.length > 1`);
await b.page(`const s = document.getElementById("designSource"); s.value = [...s.options].find(o => o.textContent.includes("designtest")).value; s.dispatchEvent(new Event("change"));`);

const FILTERS = String.raw`RIVAL = (\bai (girlfriend|boyfriend)\b
  |\breplika\b)
TOOL = \bchatgpt\b
BROAD = (\bai\b|\bchatbot\b) OR RIVAL OR TOOL`;
const runFilters = async (text) => {
  await b.page(`document.getElementById("designFilters").value = arg; document.getElementById("designRun").click();`, text);
  await b.waitFor(`return !document.getElementById("designRun").disabled`, { timeout: 60000 });
};
await runFilters(FILTERS);
const st = await b.page(`const D = window.DesignState; const bit = (n) => D.filters.findIndex(f => f.name === n); const cnt = (n) => D.records.filter(r => r.mask & (1 << bit(n))).length;
  return { n: D.records.length, rival: cnt("RIVAL"), tool: cnt("TOOL"), broad: cnt("BROAD"), acai: D.records.find(r => r.id === "d8").mask, removed: D.records.filter(r => r.body === "removed").length,
           totals: document.getElementById("designTotals").innerText, rows: document.querySelectorAll("#designTable tbody tr").length, preview: document.querySelectorAll("#designPreview li").length,
           marks: document.querySelectorAll("#designPreview mark").length, xss: window.__xss || 0, imgs: document.querySelectorAll("#designPreview img, #designPreview script").length, visible: !document.getElementById("designResults").classList.contains("hidden") };`);
check("all 300 posts read", st.n === 300, String(st.n));
check("RIVAL count", st.rival === 30, String(st.rival));          // i % 10 === 0
check("TOOL count", st.tool === 9, String(st.tool));               // i % 25 === 0, minus 25/125/225 whose body is [removed]
check("BROAD = own pattern OR RIVAL OR TOOL", st.broad === 34, String(st.broad)); // 30 rival + 3 tool-only (75,175,275) + the probe post d7
check("açai does not match \\bai\\b (Unicode boundaries)", st.acai === 0, String(st.acai));
check("body state recorded", st.removed === 75, String(st.removed));
check("results visible with month table", st.visible && st.rows === 3, `rows=${st.rows}`);
check("preview shows up to 20 hits with highlighted matches", st.preview === 20 && st.marks === 20, `li=${st.preview} mark=${st.marks}`);
check("post text is escaped (no injected elements, no script ran)", st.imgs === 0 && st.xss === 0, `els=${st.imgs} xss=${st.xss}`);

// errors are shown, nothing runs
await b.page(`document.getElementById("designFilters").value = "A = (unclosed"; document.getElementById("designRun").click();`);
await sleep(500);
check("invalid regex is reported", /not a valid regular expression/.test(await b.page(`return document.getElementById("designErrors").textContent`)));

// runaway regex is stopped by the time limit, page stays alive
await b.page(`
  const run = { id: RunStore.newId(), subreddit: "evilregex", status: "complete", createdAt: Date.now(), updatedAt: Date.now(), settings: { keywords: [], includeComments: false }, plan: { scope: "count", limit: 1, window: null, queue: [] }, chunks: [], progress: {}, counts: { posts: 1, comments: 0 } };
  await RunStore.saveRun(run);
  await RunStore.putPosts(run.id, [{ id: "evil1", title: "x", selftext: "a".repeat(60) + "!", created_utc: 1735689600, score: 1, num_comments: 0, comments: [], seq: 0 }], 0);
`);
await b.goto(url);
await b.page(`document.getElementById("designBlock").open = true; document.getElementById("designBlock").dispatchEvent(new Event("toggle"));`);
await b.waitFor(`return [...document.getElementById("designSource").options].some(o => o.textContent.includes("evilregex"))`);
// the pattern travels as an argument: inside a page string literal "\b" would become a backspace
await b.page(`const s = document.getElementById("designSource"); s.value = [...s.options].find(o => o.textContent.includes("evilregex")).value; s.dispatchEvent(new Event("change"));
  document.getElementById("designFilters").value = arg; document.getElementById("designRun").click();`, String.raw`EVIL = \b(a+)+$`);
const t0 = Date.now();
await b.waitFor(`return !document.getElementById("designRun").disabled`, { timeout: 40000 });
const evilMsg = await b.page(`return document.getElementById("designErrors").textContent`);
check("runaway regex stopped with an explanation", /catastrophic backtracking/.test(evilMsg), `${((Date.now() - t0) / 1000).toFixed(0)}s: ${evilMsg.slice(0, 60)}`);
check("page still responsive afterwards", (await b.page(`return 1 + 1`)) === 2);

// population from a gzipped CSV file
const dir = join(tmpdir(), "ls-design-files"); mkdirSync(dir, { recursive: true });
const rows = ["post_id,subreddit,post_title,post_selftext,post_author,post_created_utc,post_score,post_num_comments,row_type"];
const quotedBody = 'my chatbot says ""hi""\r\nsecond line'; // CSV-escaped quotes and a CRLF inside a quoted field
for (let i = 0; i < 50; i++) rows.push(`f${i},filetest,"Title, with comma ${i}","${i % 5 === 0 ? quotedBody : "plain"}",a${i},${1740000000 + i * 86400},${i},${i % 7},post_only`);
rows.push(`f0,filetest,"dup of f0","chatbot again",a0,1740000000,0,0,comment`); // repeated post id must be ignored
const file = join(dir, "pop.csv.gz"); writeFileSync(file, gzipSync(rows.join("\n") + "\n"));
const doc = await b.send("DOM.getDocument"); const node = await b.send("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: "#designFiles" });
await b.send("DOM.setFileInputFiles", { nodeId: node.result.nodeId, files: [file] });
await b.page(`document.getElementById("designFiles").dispatchEvent(new Event("change"));`);
await runFilters("BOT = \\bchatbot\\b");
const fs2 = await b.page(`const D = window.DesignState; return { n: D.records.length, bot: D.records.filter(r => r.mask & 1).length, label: D.sourceLabel, source: document.getElementById("designSource").value }`);
check("CSV.gz population: unique posts read", fs2.n === 50, String(fs2.n));
check("CSV.gz population: hits in quoted multi-line bodies", fs2.bot === 10, String(fs2.bot));
check("choosing files clears the saved-run choice", fs2.source === "" && /pop\.csv\.gz/.test(fs2.label), fs2.label);

await b.screenshot(join(tmpdir(), "ls-design-filters.png"));
console.log("screenshot:", join(tmpdir(), "ls-design-filters.png"));
if (server) server.close();
finish(b);
