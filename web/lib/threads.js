// Conversation structure from a post and its comment tree: a reply edge list (who answered what,
// how deep, how fast) and one summary row per thread. Pure and unit-tested.
const bare = (fullname) => String(fullname || "").replace(/^t[13]_/, "");
const isGone = (name) => !name || name === "[deleted]";

function escapeCsv(val) {
  if (val === null || val === undefined) return "";
  const str = String(val);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export const EDGE_COLUMNS = ["post_id", "comment_id", "parent_id", "parent_type", "parent_in_data", "depth", "author", "parent_author", "is_submitter",
  "created_utc", "seconds_since_post", "seconds_since_parent", "score", "body_word_count"];

export const THREAD_COLUMNS = ["post_id", "subreddit", "post_created_utc", "post_author", "post_num_comments", "comments_retrieved", "comments_complete",
  "top_level_comments", "replies", "share_top_level", "max_depth", "mean_depth", "unique_commenters", "op_comments", "op_participated",
  "deleted_author_comments", "orphan_comments", "largest_subtree", "first_reply_seconds", "median_reply_seconds", "thread_duration_hours"];

// depth from the parent chain when the stored value is missing (0 = top level, "" = parent not in the data)
function depths(comments) {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const memo = new Map();
  const depthOf = (c, guard) => {
    if (memo.has(c.id)) return memo.get(c.id);
    if (guard.has(c.id)) return null;
    guard.add(c.id);
    const pid = String(c.parent_id || "");
    let d;
    if (!pid || pid.startsWith("t3_")) d = 0;
    else { const parent = byId.get(bare(pid)); const pd = parent ? depthOf(parent, guard) : null; d = pd === null || pd === undefined ? null : pd + 1; }
    memo.set(c.id, d);
    return d;
  };
  for (const c of comments) depthOf(c, new Set());
  return memo;
}

export function edgeRows(post) {
  const comments = post.comments || [];
  const byId = new Map(comments.map((c) => [c.id, c]));
  const d = depths(comments);
  return comments.map((c) => {
    const pid = String(c.parent_id || "");
    const toPost = !pid || pid.startsWith("t3_");
    const parent = toPost ? null : byId.get(bare(pid));
    const parentTs = toPost ? post.created_utc : parent ? parent.created_utc : null;
    const depth = c.depth ?? d.get(c.id);
    return {
      post_id: post.id, comment_id: c.id, parent_id: toPost ? post.id : bare(pid), parent_type: toPost ? "post" : "comment", parent_in_data: toPost || !!parent,
      depth: depth === null || depth === undefined ? "" : depth, author: c.author ?? "", parent_author: toPost ? post.author ?? "" : parent ? parent.author ?? "" : "",
      is_submitter: !!c.is_submitter, created_utc: c.created_utc ?? "", seconds_since_post: c.created_utc && post.created_utc ? c.created_utc - post.created_utc : "",
      seconds_since_parent: parentTs && c.created_utc ? c.created_utc - parentTs : "", score: c.score ?? "", body_word_count: String(c.body || "").split(/\s+/).filter(Boolean).length,
    };
  });
}

const median = (xs) => { if (!xs.length) return ""; const s = xs.slice().sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export function threadSummary(post) {
  const comments = post.comments || [];
  const edges = edgeRows(post);
  const known = edges.filter((e) => e.depth !== "");
  const top = edges.filter((e) => e.parent_type === "post");
  // subtree sizes: every comment counts towards its top-level ancestor
  const byId = new Map(comments.map((c) => [c.id, c]));
  const rootOf = (c) => { let cur = c, hops = 0; while (cur && !String(cur.parent_id || "").startsWith("t3_") && cur.parent_id && hops++ < 10000) cur = byId.get(bare(cur.parent_id)); return cur ? cur.id : null; };
  const sizes = new Map();
  for (const c of comments) { const r = rootOf(c); if (r) sizes.set(r, (sizes.get(r) || 0) + 1); }
  const commenters = new Set(comments.map((c) => c.author).filter((a) => !isGone(a)));
  const op = isGone(post.author) ? [] : comments.filter((c) => c.author === post.author || c.is_submitter);
  const lat = edges.map((e) => e.seconds_since_parent).filter((x) => x !== "" && x >= 0);
  const sincePost = edges.map((e) => e.seconds_since_post).filter((x) => x !== "" && x >= 0);
  return {
    post_id: post.id, subreddit: post.subreddit ?? "", post_created_utc: post.created_utc ?? "", post_author: post.author ?? "", post_num_comments: post.num_comments ?? "",
    comments_retrieved: comments.length, comments_complete: post.comments_complete === undefined ? "" : post.comments_complete,
    top_level_comments: top.length, replies: comments.length - top.length, share_top_level: comments.length ? +(top.length / comments.length).toFixed(4) : "",
    max_depth: known.length ? Math.max(...known.map((e) => e.depth)) : "", mean_depth: known.length ? +(known.reduce((n, e) => n + e.depth, 0) / known.length).toFixed(3) : "",
    unique_commenters: commenters.size, op_comments: op.length, op_participated: op.length > 0,
    deleted_author_comments: comments.filter((c) => isGone(c.author)).length, orphan_comments: edges.filter((e) => !e.parent_in_data).length,
    largest_subtree: sizes.size ? Math.max(...sizes.values()) : 0,
    first_reply_seconds: sincePost.length ? Math.min(...sincePost) : "", median_reply_seconds: median(lat),
    thread_duration_hours: sincePost.length ? +(Math.max(...sincePost) / 3600).toFixed(2) : "",
  };
}

// CSV text for a batch of posts. opts: header (default true), extra (constant trailing columns),
// extraCols + extraFor(post) (per-post trailing columns, e.g. a study design).
function toCsv(columns, rowsOf, posts, opts = {}) {
  const base = opts.extra || {};
  const head = [...columns, ...Object.keys(base), ...(opts.extraCols || [])];
  const lines = [];
  for (const p of posts) {
    const ex = opts.extraFor ? { ...base, ...(opts.extraFor(p) || {}) } : base;
    for (const row of rowsOf(p)) lines.push(head.map((h) => escapeCsv(h in row ? row[h] : ex[h])).join(","));
  }
  return (opts.header === false ? lines : [head.join(","), ...lines]).join("\n");
}
export const edgesToCSV = (posts, opts) => toCsv(EDGE_COLUMNS, edgeRows, posts, opts);
export const threadsToCSV = (posts, opts) => toCsv(THREAD_COLUMNS, (p) => [threadSummary(p)], posts, opts);

const api = { EDGE_COLUMNS, THREAD_COLUMNS, edgeRows, threadSummary, edgesToCSV, threadsToCSV };
if (typeof window !== "undefined") window.Threads = api;
export default api;
