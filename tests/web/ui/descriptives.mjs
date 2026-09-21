// Descriptive charts in the results view: the right charts for the run, right bar counts, no names, screenshot for review.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../devserver.mjs";
import { launch, check, finish } from "../harness.mjs";

const external = process.argv[2];
const server = external ? null : await startServer(8800);
const url = external || "http://127.0.0.1:8800/";
const b = await launch({ windowSize: "1280,1700" });
await b.goto(url);
await b.page(`
  const run = { id: RunStore.newId(), subreddit: "charttest", status: "complete", createdAt: Date.now(), updatedAt: Date.now(), finishedAt: Date.now(),
    settings: { limit: 1000, includeComments: true, includeSelftext: true, skipNSFW: false, keywords: ["ai", "gpt", "replika"] },
    plan: { scope: "range", window: { after: 1704067200, before: 1719791999 }, limit: 1000, queue: [{ sort: "new", label: "New", query: "ai" }] },
    chunks: [{ i: 0, after: 1, before: 2, status: "done", posts: 600 }], progress: { chunkIdx: 1, modeIdx: 0, after: null, modeFetched: 0, seq: 0, tail: "done" }, counts: { posts: 600, comments: 0 } };
  await RunStore.saveRun(run);
  const posts = [];
  for (let i = 0; i < 600; i++) {
    const month = i % 6;
    const nC = i % 50 === 0 ? 120 : i % 7;
    const comments = Array.from({ length: Math.min(nC, 12) }, (_, k) => ({ id: "c" + i + "_" + k, body: k % 5 ? "ok" : "[removed]", author: k === 0 ? "whale_user" : "u" + ((i + k) % 40), created_utc: 1704067200 + i * 1000 + k, score: 1, parent_id: "t3_x" + i, depth: 0 }));
    posts.push({ id: "x" + i, title: "t" + i, selftext: (i + month * 40) % 10 < 3 + month ? "[removed]" : "body text", author: i % 9 === 0 ? "whale_user" : "poster" + (i % 60), created_utc: Date.UTC(2024, month, 1 + (i % 27)) / 1000,
      score: i % 30, num_comments: nC, query: ["ai", "gpt", "replika"][i % 3] + (i % 10 === 0 ? ";gpt" : ""), permalink: "x", comments, comments_complete: true, comments_walked: true, seq: i });
  }
  await RunStore.putPosts(run.id, posts, 0);
`);
await b.goto(url);
await b.page(`document.getElementById("runsBar").click();`);
await b.waitFor(`return document.querySelectorAll(".run-row").length > 0`);
await b.page(`document.querySelector(".run-row .run-open").click();`);
await b.waitFor(`return !document.getElementById("descriptives").classList.contains("hidden")`);
const v = await b.page(`const cards = [...document.querySelectorAll("#descriptiveCharts .chart-card")];
  return { ids: cards.map(c => c.dataset.chart), bars: Object.fromEntries(cards.map(c => [c.dataset.chart, c.querySelectorAll("rect.chart-bar").length])), titles: cards.map(c => c.querySelector(".chart-title").textContent),
           html: document.getElementById("descriptiveCharts").innerHTML, open: document.getElementById("descriptives").open, aria: cards.every(c => c.querySelector("svg").getAttribute("role") === "img" && c.querySelector("svg").getAttribute("aria-label").length > 10) }`);
check("the five charts appear, open by default", v.open && JSON.stringify(v.ids) === JSON.stringify(["volume", "comments", "intact", "authors", "keywords"]), JSON.stringify(v.ids));
check("monthly volume for a six-month run", v.titles[0] === "Posts per month" && v.bars.volume === 6, `${v.titles[0]} / ${v.bars.volume}`);
check("comment buckets, intact share by month, top ten, three keywords", v.bars.comments === 8 && v.bars.intact === 6 && v.bars.authors === 10 && v.bars.keywords === 3, JSON.stringify(v.bars));
check("no account name anywhere in the charts", !v.html.includes("whale_user") && !v.html.includes("poster1"));
check("charts are labelled for screen readers", v.aria);
const heights = await b.page(`return [...document.querySelectorAll('[data-chart="intact"] rect.chart-bar')].map(r => Number(r.getAttribute("height")))`);
check("the intact share falls month by month in this fixture, and the bars show it", heights.every((h, i) => i === 0 || h <= heights[i - 1] + 0.01) && heights[0] > heights[5], heights.map((h) => h.toFixed(0)).join(","));
// clip in document coordinates (the capture is not limited to the viewport)
const rect = await b.page(`const r = document.getElementById("descriptives").getBoundingClientRect(); return { x: Math.max(0, r.left + window.scrollX - 10), y: r.top + window.scrollY - 10, w: r.width + 20, h: Math.min(r.height + 20, 1000) }`);
await b.send("Page.captureScreenshot", {}); // warm-up: the first capture after a scroll-free layout can be blank
await b.screenshot(join(tmpdir(), "ls-descriptives.png"), { x: rect.x, y: rect.y, width: rect.w, height: rect.h });
console.log("screenshot:", join(tmpdir(), "ls-descriptives.png"));
if (server) server.close();
finish(b);
