// Removed/deleted content: shares and monthly table in the results view, in the run report, and as optional analysis columns.
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../devserver.mjs";
import { launch, check, finish, sleep } from "../harness.mjs";
import { parseCsv } from "../../../web/lib/csvstream.js";

const external = process.argv[2];
const server = external ? null : await startServer(8795);
const url = external || "http://127.0.0.1:8795/";
const dl = join(tmpdir(), "ls-content-dl");
const b = await launch({ downloadDir: dl });
await b.goto(url);
await b.page(`
  const run = { id: RunStore.newId(), subreddit: "bodytest", status: "complete", createdAt: Date.now(), updatedAt: Date.now(), finishedAt: Date.now(),
    settings: { limit: 100, includeComments: true, includeSelftext: true, skipNSFW: false, keywords: [] },
    plan: { scope: "range", window: { after: 1735689600, before: 1740787199 }, limit: 100, queue: [{ sort: "new", label: "New", query: "" }] },
    chunks: [{ i: 0, after: 1, before: 2, status: "done", posts: 100 }], progress: { chunkIdx: 1, modeIdx: 0, after: null, modeFetched: 0, seq: 0, tail: "done" }, counts: { posts: 100, comments: 200 } };
  await RunStore.saveRun(run);
  const posts = [];
  for (let i = 0; i < 100; i++) {
    const selftext = i < 20 ? "a real body " + i : i < 70 ? "[removed]" : i < 90 ? "[deleted]" : "";
    const comments = [{ id: "c" + i + "a", body: i % 4 === 0 ? "[removed]" : "fine", author: "u1", created_utc: 1736000000 + i, score: 1, parent_id: "t3_b" + i, depth: 0 },
                      { id: "c" + i + "b", body: i % 10 === 0 ? "[deleted]" : "also fine", author: i % 10 === 0 ? "[deleted]" : "u2", created_utc: 1736000100 + i, score: 1, parent_id: "t1_c" + i + "a", depth: 1 }];
    posts.push({ id: "b" + i, title: "Post " + i, selftext, author: i % 5 === 0 ? "[deleted]" : "author" + (i % 7), created_utc: Date.UTC(2025, i < 50 ? 0 : 1, 3 + (i % 20)) / 1000, score: i, num_comments: 2,
      permalink: "x", comments, comments_complete: true, comments_walked: true, seq: i });
  }
  await RunStore.putPosts(run.id, posts, 0);
`);
await b.goto(url);
await b.page(`window.showSaveFilePicker = undefined; document.getElementById("runsBar").click();`);
await b.waitFor(`return document.querySelectorAll(".run-row").length > 0`);
await b.page(`document.querySelector(".run-row .run-open").click();`);
await b.waitFor(`return !document.getElementById("results").classList.contains("hidden")`);
const v = await b.page(`return { visible: !document.getElementById("contentAvailability").classList.contains("hidden"), text: document.getElementById("contentSummary").innerText, rows: [...document.querySelectorAll("#contentTable tbody tr")].map(r => [...r.children].map(c => c.textContent)) }`); // textContent: the table sits in a closed <details>
check("content availability shown with the right shares", v.visible && /20% intact/.test(v.text) && /50% removed/.test(v.text) && /20% deleted/.test(v.text) && /10% empty/.test(v.text), v.text.slice(0, 160));
check("comment share and deleted authors reported", /comments: 83% intact/.test(v.text) && /authors deleted: 20% of posts/.test(v.text), v.text.slice(100, 260));
check("warns when fewer than half of the bodies survive", /Fewer than half/.test(v.text));
check("monthly table", v.rows.length === 2 && v.rows[0][0] === "2025-01" && v.rows[0][1] === "50" && v.rows[0][2] === "20" && v.rows[1][2] === "0" && v.rows[1][6] === "0%", JSON.stringify(v.rows));

// run report
await b.page(`document.getElementById("downloadManifest").click();`); await sleep(1500);
const rep = b.files().find((f) => f.endsWith("_run_report.json"));
check("run report downloaded", !!rep, String(rep));
if (rep) { const j = JSON.parse(readFileSync(join(dl, rep), "utf8")); check("run report records content availability with the monthly breakdown", j.content_availability && j.content_availability.post_bodies.intact === 20 && j.content_availability.by_month.length === 2 && j.content_availability.comment_bodies.removed === 25, JSON.stringify(j.content_availability?.post_bodies)); }

// exports: off → 45 columns; on → two trailing columns with the right values
await b.page(`document.getElementById("gzipToggle").checked = false; document.getElementById("analysisToggle").checked = false; document.getElementById("downloadCombinedCsv").click();`);
await b.waitFor(`return true`, { timeout: 1000 }); await sleep(2000);
const plainName = b.files().find((f) => f.endsWith("_combined.csv"));
const plain = plainName ? parseCsv(readFileSync(join(dl, plainName), "utf8")) : [[]];
check("analysis columns off: the 45 schema columns only", plain[0].length === 45 && plain.length === 201, `${plain[0].length} cols, ${plain.length - 1} rows`);
await b.page(`document.getElementById("analysisToggle").checked = true; document.getElementById("downloadCommentsCsv") && 0; document.getElementById("downloadCombinedCsv").click();`);
await sleep(2500);
const names = b.files().filter((f) => f.endsWith(".csv"));
const second = names.find((f) => f !== plainName) || names[names.length - 1];
const rows = parseCsv(readFileSync(join(dl, second), "utf8"));
const h = rows[0], ps = h.indexOf("post_body_state"), cs = h.indexOf("comment_body_state"), pid = h.indexOf("post_id"), cid = h.indexOf("comment_id");
check("analysis columns on: post_body_state and comment_body_state trail the schema", h.length === 47 && ps === 45 && cs === 46, h.slice(-3).join(","));
const byPost = (id) => rows.slice(1).filter((r) => r[pid] === id);
check("values are right per post and per comment", byPost("b5").every((r) => r[ps] === "intact") && byPost("b30").every((r) => r[ps] === "removed") && byPost("b80").every((r) => r[ps] === "deleted") && byPost("b95").every((r) => r[ps] === "empty")
  && rows.find((r) => r[cid] === "c4a")[cs] === "removed" && rows.find((r) => r[cid] === "c10b")[cs] === "deleted" && rows.find((r) => r[cid] === "c3a")[cs] === "intact");
if (server) server.close();
finish(b);
