// Score snapshot honesty: measured timing in the results view, the run report, the methods pack, and as analysis columns.
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../devserver.mjs";
import { launch, check, finish, sleep } from "../harness.mjs";
import { parseCsv } from "../../../web/lib/csvstream.js";

const external = process.argv[2];
const server = external ? null : await startServer(8801);
const url = external || "http://127.0.0.1:8801/";
const dl = join(tmpdir(), "ls-score-dl");
const b = await launch({ downloadDir: dl });
await b.goto(url);
await b.page(`
  const run = { id: RunStore.newId(), subreddit: "scoretest", status: "complete", createdAt: Date.now(), updatedAt: Date.now(), finishedAt: Date.now(),
    settings: { limit: 100, includeComments: true, includeSelftext: true, skipNSFW: false, keywords: [] }, plan: { scope: "range", window: { after: 1735689600, before: 1738367999 }, limit: 100, queue: [{ sort: "new", label: "New", query: "" }] },
    chunks: [{ i: 0, after: 1, before: 2, status: "done", posts: 100 }], progress: { chunkIdx: 1, modeIdx: 0, after: null, modeFetched: 0, seq: 0, tail: "done" }, counts: { posts: 100, comments: 100 } };
  await RunStore.saveRun(run);
  const posts = [];
  for (let i = 0; i < 100; i++) {
    const created = 1735700000 + i * 3600;
    // 80 posts captured after 36 h, 10 after 12 h (too early), 10 without a capture time
    const lagH = i < 80 ? 36 : i < 90 ? 12 : null;
    const iso = (t) => new Date(t * 1000).toISOString();
    posts.push({ id: "s" + i, title: "t", selftext: "body", author: "a" + (i % 11), created_utc: created, score: 5, score_as_of: lagH === null ? "" : iso(created + lagH * 3600), num_comments: 1, permalink: "x",
      comments: [{ id: "k" + i, body: "c", author: "b", created_utc: created + 600, score: 2, score_as_of: iso(created + 600 + 40 * 3600), parent_id: "t3_s" + i, depth: 0 }], comments_complete: true, comments_walked: true, seq: i });
  }
  await RunStore.putPosts(run.id, posts, 0);
`);
await b.goto(url);
await b.page(`window.showSaveFilePicker = undefined; document.getElementById("runsBar").click();`);
await b.waitFor(`return document.querySelectorAll(".run-row").length > 0`);
await b.page(`document.querySelector(".run-row .run-open").click();`);
await b.waitFor(`return !document.getElementById("scoreSnapshot").classList.contains("hidden")`);
const text = await b.page(`return document.getElementById("scoreSnapshot").innerText`);
check("states that scores are snapshots, with the measured median and range", /Scores are snapshots, not live values/.test(text) && /median of 36 hours/.test(text) && /12–36 h/.test(text), text.slice(0, 200));
check("reports early captures and missing capture times", /11% were captured less than a day after posting/.test(text) && /10 posts carry no capture time/.test(text), text.slice(100, 330));
check("tells the researcher how to control for it", /post_score_as_of/.test(text) && /post_score_age_hours/.test(text));

await b.page(`document.querySelector(".other-formats").open = true; document.getElementById("downloadManifest").click();`); await sleep(1500);
const rep = b.files().find((f) => f.endsWith("_run_report.json"));
const j = rep ? JSON.parse(readFileSync(join(dl, rep), "utf8")) : {};
check("run report records the snapshot timing", j.score_snapshot && j.score_snapshot.median_hours === 36 && j.score_snapshot.posts_without === 10 && j.score_snapshot.posts_with_timestamp === 90, JSON.stringify(j.score_snapshot));
await b.page(`document.getElementById("downloadPack").click();`); await sleep(1500);
const pack = b.files().find((f) => f.endsWith("_methods_and_ethics.md"));
check("methods pack states the measured timing", !!pack && /snapshots taken by the archive a median of 36 hours after posting \(10th–90th percentile 12–36 h\)/.test(readFileSync(join(dl, pack), "utf8")));

await b.page(`document.getElementById("gzipToggle").checked = false; document.getElementById("analysisToggle").checked = true; document.getElementById("downloadCombinedCsv").click();`); await sleep(2500);
const f = b.files().find((x) => x.endsWith("_combined.csv"));
const rows = parseCsv(readFileSync(join(dl, f), "utf8")); const h = rows[0];
check("analysis columns include the snapshot ages, after the 45 schema columns", h.length === 49 && h.slice(45).join(",") === "post_body_state,post_score_age_hours,comment_body_state,comment_score_age_hours", h.slice(44).join(","));
const get = (id, c) => rows.find((r) => r[h.indexOf("post_id")] === id)[h.indexOf(c)];
check("ages are right per post and per comment; unknown stays empty", get("s5", "post_score_age_hours") === "36" && get("s85", "post_score_age_hours") === "12" && get("s95", "post_score_age_hours") === "" && get("s5", "comment_score_age_hours") === "40");
if (server) server.close();
finish(b);
