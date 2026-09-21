import test from "node:test";
import assert from "node:assert/strict";
import { edgeRows, threadSummary, edgesToCSV, threadsToCSV, EDGE_COLUMNS, THREAD_COLUMNS } from "../../../web/lib/threads.js";
import { parseCsv } from "../../../web/lib/csvstream.js";

// post by ann at t=1000
//   c1 bob   +60   (top)        ── c2 ann +120 (reply, OP)  ── c3 bob +300
//   c4 [deleted] +600 (top)
//   c5 cy    +900  reply to a comment that is not in the data (orphan)
const post = { id: "p1", subreddit: "sub", author: "ann", created_utc: 1000, num_comments: 6, comments_complete: false, comments: [
  { id: "c1", parent_id: "t3_p1", author: "bob", created_utc: 1060, score: 5, body: "first reply here", is_submitter: false, depth: 0 },
  { id: "c2", parent_id: "t1_c1", author: "ann", created_utc: 1120, score: 2, body: "thanks", is_submitter: true, depth: 1 },
  { id: "c3", parent_id: "t1_c2", author: "bob", created_utc: 1300, score: 1, body: "np", is_submitter: false },           // depth missing → derived
  { id: "c4", parent_id: "t3_p1", author: "[deleted]", created_utc: 1600, score: 0, body: "[removed]", is_submitter: false, depth: 0 },
  { id: "c5", parent_id: "t1_gone", author: "cy", created_utc: 1900, score: 1, body: "late, to a removed parent", is_submitter: false },
] };

test("edge list: parents, depth, latencies, orphans", () => {
  const e = Object.fromEntries(edgeRows(post).map((r) => [r.comment_id, r]));
  assert.deepEqual([e.c1.parent_id, e.c1.parent_type, e.c1.parent_author, e.c1.seconds_since_post, e.c1.seconds_since_parent], ["p1", "post", "ann", 60, 60]);
  assert.deepEqual([e.c2.parent_id, e.c2.parent_type, e.c2.parent_author, e.c2.depth, e.c2.seconds_since_parent, e.c2.is_submitter], ["c1", "comment", "bob", 1, 60, true]);
  assert.equal(e.c3.depth, 2); // derived from the chain
  assert.equal(e.c3.seconds_since_parent, 180);
  assert.deepEqual([e.c5.parent_id, e.c5.parent_in_data, e.c5.depth, e.c5.seconds_since_parent, e.c5.parent_author], ["gone", false, "", "", ""]);
  assert.equal(e.c1.body_word_count, 3);
});

test("thread summary", () => {
  const s = threadSummary(post);
  assert.deepEqual([s.comments_retrieved, s.top_level_comments, s.replies, s.share_top_level], [5, 2, 3, 0.4]);
  assert.deepEqual([s.max_depth, s.mean_depth], [2, 0.75]);            // depths 0,1,2,0 ; the orphan has none
  assert.deepEqual([s.unique_commenters, s.op_comments, s.op_participated, s.deleted_author_comments, s.orphan_comments], [3, 1, true, 1, 1]);
  assert.equal(s.largest_subtree, 3);                                   // c1 → c2 → c3
  assert.deepEqual([s.first_reply_seconds, s.median_reply_seconds, s.thread_duration_hours], [60, 120, 0.25]); // latencies 60,60,180,600 → median 120
  const empty = threadSummary({ id: "p2", author: "[deleted]", created_utc: 5, comments: [] });
  assert.deepEqual([empty.comments_retrieved, empty.max_depth, empty.op_participated, empty.first_reply_seconds, empty.largest_subtree], [0, "", false, "", 0]);
});

test("a parent cycle cannot hang the depth walk", () => {
  const loop = { id: "p", author: "a", created_utc: 1, comments: [{ id: "x", parent_id: "t1_y", created_utc: 2 }, { id: "y", parent_id: "t1_x", created_utc: 3 }] };
  assert.deepEqual(edgeRows(loop).map((r) => r.depth), ["", ""]);
  assert.equal(threadSummary(loop).comments_retrieved, 2);
});

test("CSV: headers, header:false for later batches, per-post extra columns, quoting", () => {
  const csv = parseCsv(edgesToCSV([post]));
  assert.deepEqual(csv[0], EDGE_COLUMNS);
  assert.equal(csv.length, 6);
  assert.equal(parseCsv(edgesToCSV([post], { header: false })).length, 5);
  const t = parseCsv(threadsToCSV([{ ...post, author: 'an"n, the OP' }], { extra: { run_label: "2025-01" }, extraCols: ["sample_group"], extraFor: () => ({ sample_group: "target" }) }));
  assert.deepEqual(t[0], [...THREAD_COLUMNS, "run_label", "sample_group"]);
  assert.equal(t[1][t[0].indexOf("post_author")], 'an"n, the OP');
  assert.deepEqual(t[1].slice(-2), ["2025-01", "target"]);
});
