// Methods and ethics pack: from a real fetched run with a matched design, and from a fabricated batch group.
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../devserver.mjs";
import { launch, check, finish, sleep } from "../harness.mjs";

const external = process.argv[2];
const server = external ? null : await startServer(8798);
const url = external || "http://127.0.0.1:8798/";
const dl = join(tmpdir(), "ls-pack-dl");
const b = await launch({ downloadDir: dl });
await b.goto(url);
// a real small ID run carrying a design, so the pack describes something true
const ids = await b.page(`const batch = await Archive.get("posts/search", { subreddit: "MyBoyfriendIsAI", limit: 40, sort: "desc", before: Math.floor(Date.now() / 1000) - 40 * 86400 }); return batch.slice(0, 20).map(p => p.id);`);
await b.page(`window.showSaveFilePicker = undefined;
  startIdRun(arg, { includeComments: true, design: { kind: "matched_controls", seed: 42, k: 1, match_on: ["month"], targets_filter: "GPT", controls_exclude_filter: "ANYAI", targets: 10, controls: 10, shortfall: 0, case_sensitive: false,
    population: "test population", filters: [{ name: "GPT", regex: "\\\\bgpt\\\\b", or: [] }, { name: "ANYAI", regex: "\\\\bai\\\\b", or: ["GPT"] }], posts: 20, columns: [], annotations: {} } });`, ids);
await b.waitFor(`return /^Done/.test(document.getElementById("statusText").textContent)`, { timeout: 300000 });
await sleep(2000);
await b.page(`document.querySelector(".other-formats").open = true; document.getElementById("pseudoToggle").checked = true; document.getElementById("downloadPack").click();`);
await sleep(2000);
const f = b.files().find((x) => x.endsWith("_methods_and_ethics.md"));
check("pack downloaded with the run's base name", !!f && /ids-20/.test(f), String(f));
const md = f ? readFileSync(join(dl, f), "utf8") : "";
const counts = await b.page(`return { posts: currentRun.counts.posts, comments: currentRun.counts.comments }`);
check("methods paragraph carries the real counts", md.includes(`${counts.posts.toLocaleString("en-US")} posts and ${counts.comments.toLocaleString("en-US")} comments`), `${counts.posts} / ${counts.comments}`);
check("names the archive as the source and the collection date", /Arctic Shift archive of Reddit/.test(md) && md.includes(new Date().toISOString().slice(0, 4)));
check("describes the matched design with regexes, k, strata and seed", /GPT = \/\\bgpt\\b\/i; ANYAI = \/\\bai\\b\/i OR GPT/.test(md) && /1 control post\(s\) not matching ANYAI/.test(md) && /seed 42/.test(md));
check("states completeness and the intact share", /did not meet this and are flagged/.test(md) && /of post bodies were intact/.test(md));
check("pseudonymisation toggle is reflected", /replaced by salted SHA-256 pseudonyms/.test(md) && /author names in this export are salted SHA-256 pseudonyms/.test(md));
check("limitations, dictionary, citation and an ethics checklist are present", ["## 2. Limitations to state", "## 4. Data dictionary (short)", "## 5. How to cite", "## 6. Data management and ethics checklist"].every((h) => md.includes(h)) && (md.match(/- \[ \]/g) || []).length >= 10);
check("no user name of the run appears in the pack", !(await b.page(`const posts = await RunStore.getPosts(currentRun.id); const names = [...new Set(posts.map(p => p.author))].filter(n => n && n !== "[deleted]" && n !== "AutoModerator" && n.length > 4); return names.some(n => arg.includes(n));`, md)));

// group pack from the runs panel
await b.page(`
  const batchId = RunStore.newId();
  for (let i = 0; i < 3; i++) {
    const a = Date.UTC(2025, i, 1) / 1000, z = Date.UTC(2025, i + 1, 1) / 1000 - 1;
    const rid = RunStore.newId() + i;
    await RunStore.putPosts(rid, Array.from({ length: 100 * (i + 1) }, (_, k) => ({ id: "pg" + i + "_" + k, title: "t", selftext: k % 4 ? "[removed]" : "text", author: "a" + (k % 9), created_utc: a + k * 60, score: 1, num_comments: 0, comments: [], seq: k })), 0);
    await RunStore.saveRun({ id: rid, subreddit: "packgroup", status: i === 2 ? "complete_with_gaps" : "complete", createdAt: Date.now() - i * 1000, updatedAt: Date.now() - i * 1000, finishedAt: Date.now(),
      settings: { limit: 100000, includeComments: false, includeSelftext: true, skipNSFW: false, keywords: [] }, plan: { scope: "range", window: { after: a, before: z }, segment: "2025-0" + (i + 1), limit: 100000, queue: [{ sort: "new", label: "New", query: "" }] },
      batch: { id: batchId, index: i, total: 3 }, chunks: [{ i: 0, after: a - 1, before: z + 1, status: i === 2 ? "failed" : "done", posts: 0 }], progress: {}, counts: { posts: 100 * (i + 1), comments: 0 } });
  }`);
await b.goto(url);
await b.page(`document.getElementById("runsBar").click();`);
await b.waitFor(`return !!document.querySelector(".run-group .group-pack")`);
await b.page(`[...document.querySelectorAll(".run-group")].find(g => g.innerText.includes("packgroup")).querySelector(".group-pack").click();`);
await sleep(3000);
const g = b.files().find((x) => /packgroup_merged-3runs.*_methods_and_ethics\.md$/.test(x));
check("group pack downloaded", !!g, b.files().join(" | "));
if (g) { const gm = readFileSync(join(dl, g), "utf8"); check("group pack summarises the three runs and names the missing span", /consisted of 3 runs covering 2025-01-01 to 2025-03-31/.test(gm) && /600 posts/.test(gm) && /missing from the data: 2025-03-01 to 2025-03-31/.test(gm) && (gm.match(/\| r\/packgroup \|/g) || []).length === 3, gm.split("\n")[6]?.slice(0, 200)); }
if (server) server.close();
finish(b);
