// Author-level data with real posts: concentration summary, pseudonymised exports that match the CLI's hash,
// salt import, authors table, and an author panel run whose report never contains a user name.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../devserver.mjs";
import { launch, check, finish, sleep } from "../harness.mjs";
import { parseCsv } from "../../../web/lib/csvstream.js";

const external = process.argv[2];
const server = external ? null : await startServer(8796);
const url = external || "http://127.0.0.1:8796/";
const dl = join(tmpdir(), "ls-authors-dl");
const b = await launch({ downloadDir: dl });
await b.goto(url);
const SALT = "5a".repeat(32);
const pop = await b.page(`
  window.Pseudo.importSalt(localStorage, arg);
  const posts = []; let before = null;
  for (let page = 0; page < 3; page++) {
    const params = { subreddit: "MyBoyfriendIsAI", limit: 100, sort: "desc" }; if (before) params.before = before;
    const batch = await Archive.get("posts/search", params);
    for (const raw of batch) posts.push(window.Mappers.mapPost(raw));
    if (batch.length < 100) break; before = batch[batch.length - 1].created_utc;
  }
  const uniq = [...new Map(posts.map(p => [p.id, p])).values()];
  const run = { id: RunStore.newId(), subreddit: "MyBoyfriendIsAI", status: "complete", createdAt: Date.now() - 60000, updatedAt: Date.now() - 60000, finishedAt: Date.now(),
    settings: { limit: 1000, includeComments: false, includeSelftext: true, skipNSFW: false, keywords: [] }, plan: { scope: "count", window: null, limit: uniq.length, queue: [{ sort: "new", label: "New", query: "" }] },
    chunks: [{ i: 0, after: null, before: null, status: "done", posts: uniq.length }], progress: { chunkIdx: 1, modeIdx: 0, after: null, modeFetched: 0, seq: 0, tail: "done" }, counts: { posts: uniq.length, comments: 0 } };
  await RunStore.saveRun(run);
  await RunStore.putPosts(run.id, uniq.map((p, i) => ({ ...p, comments: [], seq: i })), 0);
  const counts = {}; for (const p of uniq) if (p.author !== "[deleted]" && p.author !== "AutoModerator") counts[p.author] = (counts[p.author] || 0) + 1;
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return { n: uniq.length, names: Object.keys(counts), top: ranked.slice(0, 3), third: ranked[2][1] };`, SALT);
check("population stored", pop.n >= 150 && pop.names.length > 20, `${pop.n} posts, ${pop.names.length} named authors`);
await b.goto(url);
await b.page(`window.showSaveFilePicker = undefined; document.getElementById("runsBar").click();`);
await b.waitFor(`return document.querySelectorAll(".run-row").length > 0`);
await b.page(`document.querySelector(".run-row .run-open").click();`);
await b.waitFor(`return !document.getElementById("authorsBlock").classList.contains("hidden")`);
const sum = await b.page(`return document.getElementById("authorsSummary").textContent`);
check("concentration summary", /Authors: \d+/.test(sum) && /10 most active wrote \d+/.test(sum), sum);

// pseudonymised combined CSV
await b.page(`document.getElementById("authorsBlock").open = true; document.getElementById("gzipToggle").checked = false; document.getElementById("pseudoToggle").checked = true; document.getElementById("downloadCombinedCsv").click();`);
await sleep(2500);
const f1 = b.files().find((f) => f.endsWith("_combined.csv"));
const rows = parseCsv(readFileSync(join(dl, f1), "utf8")); const ai = rows[0].indexOf("post_author");
const authorsOut = rows.slice(1).map((r) => r[ai]);
check("every author is a 64-hex pseudonym or a kept placeholder", authorsOut.every((a) => /^[0-9a-f]{64}$/.test(a) || ["[deleted]", "AutoModerator", ""].includes(a)));
check("no real user name appears in the author column", !authorsOut.some((a) => pop.names.includes(a)));
const expectTop = createHash("sha256").update(SALT + pop.top[0][0]).digest("hex");
check("same function as the CLI for the imported salt: sha256(salt + name)", authorsOut.filter((a) => a === expectTop).length === pop.top[0][1], `${authorsOut.filter((a) => a === expectTop).length} rows for the most active author, expected ${pop.top[0][1]}`);

// toggle off → real names again (the store is never rewritten)
await b.page(`document.getElementById("pseudoToggle").checked = false; document.getElementById("downloadPostsCsv") ? document.getElementById("downloadPostsCsv").click() : document.getElementById("downloadCsv").click();`);
await sleep(2500);
const f2 = b.files().find((f) => f.endsWith("_posts.csv"));
if (f2) { const r2 = parseCsv(readFileSync(join(dl, f2), "utf8")); const a2 = r2[0].indexOf("author"); check("pseudonymisation happens on export only; the stored data keeps names", r2.slice(1).some((r) => pop.names.includes(r[a2]))); }
else check("posts CSV downloaded", false, b.files().join(","));

// authors table
await b.page(`document.getElementById("pseudoToggle").checked = true; document.getElementById("authorsCsv").click();`); await sleep(2000);
const f3 = b.files().find((f) => f.endsWith("_authors.csv"));
check("authors table downloaded", !!f3, String(f3));
if (f3) { const t = parseCsv(readFileSync(join(dl, f3), "utf8")); check("authors table: header, pseudonyms, sorted by activity", t[0].join(",") === "author,posts,comments,total,share_of_all,pseudonymised" && t[1][0] === expectTop && Number(t[1][1]) === pop.top[0][1] && t.slice(1).every((r) => r[5] === "TRUE" && !pop.names.includes(r[0]))); }

// author panel: the three most active accounts
await b.page(`const m = document.getElementById("authorPanelMin"); m.value = arg; m.dispatchEvent(new Event("input"));`, pop.third);
await sleep(1200); // the count is debounced; read the label only after the update for the new minimum has run
await b.waitFor(`return /account/.test(document.getElementById("authorPanelCount").textContent) && !document.getElementById("authorPanelBtn").disabled`, { timeout: 30000 });
const count = await b.page(`return document.getElementById("authorPanelCount").textContent`);
await b.page(`document.getElementById("pseudoToggle").checked = false; document.getElementById("authorPanelBtn").click();`);
await b.waitFor(`return /^Done/.test(document.getElementById("statusText").textContent)`, { timeout: 300000 });
await sleep(2500);
const run = await b.page(`const posts = await RunStore.getPosts(currentRun.id); const wanted = new Set(currentRun.chunks.flatMap(c => c.authors));
  return { scope: currentRun.plan.scope, authors: currentRun.plan.authorCount, posts: posts.length, allByPanel: posts.every(p => wanted.has(p.author)), oneSub: posts.every(p => p.subreddit === "MyBoyfriendIsAI"),
           report: JSON.stringify(currentRun.manifest), names: [...wanted], toggle: document.getElementById("pseudoToggle").checked, label: scopeText(currentRun.plan) };`);
check("the run uses exactly the accounts the label announced (no stale count)", run.authors === Number(count.match(/^[\d,]+/)[0].replace(/,/g, "")), `label "${count}" vs ${run.authors} authors in the run`);
check("author panel run collected posts by exactly those accounts, in that community", run.scope === "authors" && run.authors >= 3 && run.posts >= pop.top[0][1] && run.allByPanel && run.oneSub, `${count} → ${run.authors} authors, ${run.posts} posts (${run.label})`);
check("the run report contains no user name", !run.names.some((n) => run.report.includes(n)) && /author_panel/.test(run.report));
check("author-panel results switch pseudonymisation on by default", run.toggle === true);
const f4 = b.files().find((f) => /authors-\d+_.*_combined\.csv$/.test(f));
check("author-panel export is named by its scope", !!f4, b.files().join(" | "));
if (server) server.close();
finish(b);
