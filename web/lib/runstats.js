// One streaming pass over a run's posts gives everything the results view, the run report and the
// methods pack say about the data: what is left of the content, how it is spread over time and
// authors, and how old the score snapshots are. Pure and unit-tested; no DOM, no network.
import { bodyState, monthOf } from "./design.js";

const MAX_AUTHORS = 300000;       // beyond this the author table stops growing (flagged as truncated)
const LAG_RESERVOIR = 20000;      // sample of score-snapshot lags kept for the quantiles
const MAX_DAYS = 120;             // daily volume is only useful (and only charted) for short runs
export const COMMENT_BUCKETS = [[0, 0, "0"], [1, 2, "1–2"], [3, 5, "3–5"], [6, 10, "6–10"], [11, 25, "11–25"], [26, 50, "26–50"], [51, 100, "51–100"], [101, Infinity, "101+"]];

const isGone = (name) => !name || name === "[deleted]";

export function createRunStats() {
  const s = {
    posts: 0, comments: 0,
    body: { intact: 0, removed: 0, deleted: 0, empty: 0 },
    commentBody: { intact: 0, removed: 0, deleted: 0, empty: 0 },
    postAuthorGone: 0, commentAuthorGone: 0,
    months: new Map(),
    authors: new Map(), authorsTruncated: false,
    buckets: COMMENT_BUCKETS.map(() => 0),
    queries: new Map(),
    lags: [], lagSeen: 0, lagMissing: 0,
    firstTs: null, lastTs: null,
    days: new Map(), daysOverflow: false, // posts per UTC day, kept only while the run spans few days
  };
  let rnd = 1234567; // tiny LCG: the lag reservoir must not depend on Math.random so results are reproducible
  const rand = () => { rnd = (rnd * 1103515245 + 12345) % 2147483648; return rnd / 2147483648; };

  function author(name, kind) {
    if (isGone(name)) return;
    let a = s.authors.get(name);
    if (!a) { if (s.authors.size >= MAX_AUTHORS) { s.authorsTruncated = true; return; } a = { posts: 0, comments: 0 }; s.authors.set(name, a); }
    a[kind]++;
  }

  function add(post) {
    s.posts++;
    const ts = post.created_utc || 0;
    if (ts) { if (s.firstTs === null || ts < s.firstTs) s.firstTs = ts; if (s.lastTs === null || ts > s.lastTs) s.lastTs = ts; }
    const state = bodyState(post.selftext);
    s.body[state]++;
    const m = ts ? monthOf(ts) : "unknown";
    let row = s.months.get(m);
    if (!row) { row = { posts: 0, comments: 0, intact: 0, removed: 0, deleted: 0, empty: 0 }; s.months.set(m, row); }
    row.posts++; row[state]++;
    if (ts && !s.daysOverflow) {
      const d = new Date(ts * 1000).toISOString().slice(0, 10);
      s.days.set(d, (s.days.get(d) || 0) + 1);
      if (s.days.size > MAX_DAYS) { s.daysOverflow = true; s.days.clear(); }
    }
    if (isGone(post.author)) s.postAuthorGone++;
    author(post.author, "posts");
    const comments = post.comments || [];
    // posts-only runs have no trees: fall back to Reddit's counter for the distribution
    const n = comments.length || post.num_comments || 0;
    row.comments += comments.length;
    s.buckets[COMMENT_BUCKETS.findIndex(([lo, hi]) => n >= lo && n <= hi)]++;
    for (const c of comments) {
      s.comments++;
      s.commentBody[bodyState(c.body)]++;
      if (isGone(c.author)) s.commentAuthorGone++;
      author(c.author, "comments");
    }
    for (const q of String(post.query || "").split(";")) if (q) s.queries.set(q, (s.queries.get(q) || 0) + 1);
    const asOf = post.score_as_of ? Date.parse(post.score_as_of) / 1000 : 0;
    if (asOf && ts) {
      const lagH = (asOf - ts) / 3600;
      s.lagSeen++;
      if (s.lags.length < LAG_RESERVOIR) s.lags.push(lagH);
      else { const j = Math.floor(rand() * s.lagSeen); if (j < LAG_RESERVOIR) s.lags[j] = lagH; }
    } else s.lagMissing++;
  }

  const share = (a, b) => (b ? a / b : 0);
  const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : null);

  function result() {
    const lags = s.lags.slice().sort((a, b) => a - b);
    const top = Array.from(s.authors.entries()).map(([name, a]) => ({ name, posts: a.posts, comments: a.comments, total: a.posts + a.comments })).sort((a, b) => b.total - a.total);
    const items = s.posts + s.comments;
    const topShare = (k) => share(top.slice(0, k).reduce((n, a) => n + a.total, 0), items - s.postAuthorGone - s.commentAuthorGone);
    return {
      posts: s.posts, comments: s.comments,
      period: s.firstTs ? { from: new Date(s.firstTs * 1000).toISOString(), to: new Date(s.lastTs * 1000).toISOString() } : null,
      content: {
        post_bodies: { ...s.body, intact_share: share(s.body.intact, s.posts), removed_share: share(s.body.removed, s.posts), deleted_share: share(s.body.deleted, s.posts), empty_share: share(s.body.empty, s.posts) },
        comment_bodies: { ...s.commentBody, intact_share: share(s.commentBody.intact, s.comments) },
        post_author_deleted_share: share(s.postAuthorGone, s.posts),
        comment_author_deleted_share: share(s.commentAuthorGone, s.comments),
      },
      days: s.daysOverflow ? null : Array.from(s.days.entries()).sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, posts]) => ({ day, posts })),
      months: Array.from(s.months.entries()).sort(([a], [b]) => (a < b ? -1 : 1)).map(([month, r]) => ({ month, ...r, intact_share: share(r.intact, r.posts) })),
      comments_per_post: COMMENT_BUCKETS.map(([, , label], i) => ({ bucket: label, posts: s.buckets[i] })),
      authors: { unique: s.authors.size, truncated: s.authorsTruncated, top10_share: topShare(10), top1pct_share: topShare(Math.max(1, Math.ceil(s.authors.size / 100))), top: top.slice(0, 10) },
      keywords: Array.from(s.queries.entries()).sort((a, b) => b[1] - a[1]).map(([query, posts]) => ({ query, posts, share: share(posts, s.posts) })),
      score_snapshot: { posts_with_timestamp: s.lagSeen, posts_without: s.lagMissing, median_hours: quantile(lags, 0.5), p10_hours: quantile(lags, 0.1), p90_hours: quantile(lags, 0.9), under_24h_share: share(lags.filter((h) => h < 24).length, lags.length) },
    };
  }

  // the full author table, for the authors export
  function authorRows() { return Array.from(s.authors.entries()).map(([name, a]) => ({ name, ...a })); }

  return { add, result, authorRows };
}

const api = { createRunStats, COMMENT_BUCKETS };
if (typeof window !== "undefined") window.RunStats = api;
export default api;
