import test from "node:test";
import assert from "node:assert/strict";
import { buildMethodsPack } from "../../../web/lib/pack.js";

const base = { tool: "LemonSqueeze web app", run_id: "run_1", subreddit: "relationship_advice", status: "complete", scope: "range", window_utc: { from: "2024-01-01T00:00:00.000Z", to: "2024-01-31T23:59:59.000Z" },
  keywords: [], include_comments: true, chunks: [{ status: "done" }], counts: { posts: 1000, comments: 25000, posts_with_incomplete_comments: 10 }, comment_method: "windowed sweep, then per-post walks",
  content_availability: { post_bodies: { intact: 250, removed: 600, deleted: 100, empty: 50 } }, started_at: "2026-09-20T08:00:00.000Z", finished_at: "2026-09-20T09:00:00.000Z", export_basename: "reddit_relationship_advice_2024-01" };

test("methods paragraph states what was done, with the numbers", () => {
  const md = buildMethodsPack([base], { generatedAt: "2026-09-21T00:00:00Z" });
  assert.match(md, /^# Methods and ethics pack — r\/relationship_advice/);
  assert.match(md, /Arctic Shift archive of Reddit .* not the Reddit API/);
  assert.match(md, /\(web app\) on 2026-09-20 \(the date the tool ran, not the period the data cover\)/); // never "between X and X"
  assert.match(buildMethodsPack([{ ...base, started_at: "2026-09-19T23:00:00Z" }]), /between 2026-09-19 and 2026-09-20/);
  assert.match(md, /all posts created between 2024-01-01 and 2024-01-31 \(UTC\)/);
  assert.match(md, /1,000 posts and 25,000 comments/);
  assert.match(md, /10 of 1,000 posts \(1\.0%\) did not meet this/); // shares under 10 % keep one decimal
  assert.match(md, /25% of post bodies were intact/);
  assert.match(md, /No keyword filter was applied at collection/);
  assert.match(md, /User names were exported as they appear on Reddit/);
  assert.match(md, /## 6\. Data management and ethics checklist/);
  assert.ok((md.match(/- \[ \]/g) || []).length >= 10);
});

test("keywords, gaps, pseudonymisation and score snapshot change the text", () => {
  const m = { ...base, keywords: ["jealous", "cheating"], chunks: [{ status: "failed", from_utc: "2024-01-10T00:00:00Z", to_utc: "2024-01-12T00:00:00Z" }], score_snapshot: { median_hours: 36.2, p10_hours: 30, p90_hours: 50 } };
  const md = buildMethodsPack([m], { pseudonymised: true });
  assert.match(md, /one pass per keyword \("jealous", "cheating"\)/);
  assert.match(md, /missing from the data: 2024-01-10 to 2024-01-12 \(r\/relationship_advice\)/);
  assert.match(md, /replaced by salted SHA-256 pseudonyms/);
  assert.match(md, /median of 36 hours after posting \(10th–90th percentile 30–50 h\)/);
  assert.match(md, /Keyword search recall/);
});

test("a matched design is described with its regexes, k, strata and seed", () => {
  const m = { ...base, scope: "ids", window_utc: null, counts: { ...base.counts, ids_requested: 150, ids_not_in_archive: 0 },
    design: { kind: "matched_controls", seed: 42, k: 2, match_on: ["month", "comments_q"], targets_filter: "BROAD", controls_exclude_filter: "BROAD", targets: 50, controls: 100, shortfall: 0, case_sensitive: false,
      filters: [{ name: "TOOL", regex: "\\bchatgpt\\b", or: [] }, { name: "BROAD", regex: "\\bai\\b", or: ["TOOL"] }] } };
  const md = buildMethodsPack([m]);
  assert.match(md, /a list of 150 post ids/);
  assert.match(md, /TOOL = \/\\bchatgpt\\b\/i; BROAD = \/\\bai\\b\/i OR TOOL/);
  assert.match(md, /2 control post\(s\) not matching BROAD .* same month × comments_q stratum .* seed 42; 100 controls were obtained/);
});

test("several runs are summarised and listed", () => {
  const feb = { ...base, run_id: "run_2", window_utc: { from: "2024-02-01T00:00:00Z", to: "2024-02-29T23:59:59Z" }, counts: { posts: 500, comments: 0, posts_with_incomplete_comments: 0 }, export_basename: "reddit_relationship_advice_2024-02" };
  const md = buildMethodsPack([base, feb]);
  assert.match(md, /consisted of 2 runs covering 2024-01-01 to 2024-02-29/);
  assert.match(md, /1,500 posts/);
  assert.equal((md.match(/\| reddit_relationship_advice_2024-0/g) || []).length, 2);
  assert.match(buildMethodsPack([]), /No run report available/);
});
