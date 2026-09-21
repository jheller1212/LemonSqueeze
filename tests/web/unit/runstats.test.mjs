import test from "node:test";
import assert from "node:assert/strict";
import { createRunStats } from "../../../web/lib/runstats.js";

const iso = (ts) => new Date(ts * 1000).toISOString();
const jan = Date.UTC(2025, 0, 10) / 1000, feb = Date.UTC(2025, 1, 10) / 1000;
const posts = [
  { id: "a", author: "ann", selftext: "real text", created_utc: jan, score_as_of: iso(jan + 36 * 3600), num_comments: 2, query: "ai;gpt",
    comments: [{ body: "hi", author: "bob" }, { body: "[removed]", author: "[deleted]" }] },
  { id: "b", author: "ann", selftext: "[removed]", created_utc: jan + 5, score_as_of: iso(jan + 5 + 12 * 3600), num_comments: 0, query: "ai", comments: [] },
  { id: "c", author: "[deleted]", selftext: "[deleted]", created_utc: feb, score_as_of: "", num_comments: 40, comments: [] },
  { id: "d", author: "cy", selftext: "", created_utc: feb + 9, score_as_of: iso(feb + 9 + 48 * 3600), num_comments: 7, comments: [{ body: "[deleted]", author: "ann" }] },
];

test("content availability, months, buckets, authors, keywords, score lag", () => {
  const s = createRunStats();
  posts.forEach(s.add);
  const r = s.result();
  assert.equal(r.posts, 4); assert.equal(r.comments, 3);
  assert.deepEqual([r.content.post_bodies.intact, r.content.post_bodies.removed, r.content.post_bodies.deleted, r.content.post_bodies.empty], [1, 1, 1, 1]);
  assert.equal(r.content.post_bodies.intact_share, 0.25);
  assert.deepEqual([r.content.comment_bodies.intact, r.content.comment_bodies.removed, r.content.comment_bodies.deleted], [1, 1, 1]);
  assert.equal(r.content.post_author_deleted_share, 0.25);
  assert.deepEqual(r.months.map((m) => [m.month, m.posts, m.intact, m.comments]), [["2025-01", 2, 1, 2], ["2025-02", 2, 0, 1]]);
  // posts without a fetched tree fall back to num_comments for the distribution
  assert.deepEqual(Object.fromEntries(r.comments_per_post.filter((b) => b.posts).map((b) => [b.bucket, b.posts])), { "0": 1, "1–2": 2, "26–50": 1 });
  assert.equal(r.authors.unique, 3);
  assert.deepEqual(r.authors.top[0], { name: "ann", posts: 2, comments: 1, total: 3 });
  assert.deepEqual(r.keywords, [{ query: "ai", posts: 2, share: 0.5 }, { query: "gpt", posts: 1, share: 0.25 }]);
  assert.equal(r.score_snapshot.posts_with_timestamp, 3);
  assert.equal(r.score_snapshot.posts_without, 1);
  assert.equal(r.score_snapshot.median_hours, 36);
  assert.equal(r.period.from, iso(jan));
  assert.equal(s.authorRows().length, 3);
});

test("an empty run gives zeros, not NaN", () => {
  const r = createRunStats().result();
  assert.equal(r.content.post_bodies.intact_share, 0);
  assert.equal(r.score_snapshot.median_hours, null);
  assert.equal(r.authors.top10_share, 0);
  assert.equal(r.period, null);
});
