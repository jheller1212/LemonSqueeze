// Reddit data scraper serverless function for Netlify
// Uses Arctic Shift (primary) and PullPush (fallback) — no Reddit API needed

const ARCTIC_SHIFT = "https://arctic-shift.photon-reddit.com";
const PULLPUSH = "https://api.pullpush.io";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// PullPush became a paid service in 2026 and now answers free traffic with 429.
// Once it refuses within an invocation, stop paying the retry/backoff cost for it.
let pullPushBlocked = false;

async function fetchJSON(url, retries = 3, { retryOn429 = true } = {}) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const resp = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "LemonSqueeze/1.0 (academic research tool)" },
        signal: controller.signal,
      });

      if (resp.status === 429) {
        if (retryOn429 && attempt < retries - 1) {
          await delay(3000 * 2 ** attempt);
          continue;
        }
        throw new Error("Rate limited. Please wait a minute and try again.");
      }

      if (resp.status === 404) {
        throw new Error("Not found (404).");
      }

      if (!resp.ok) {
        if (attempt < retries - 1) {
          await delay(2000 * 2 ** attempt);
          continue;
        }
        throw new Error(`HTTP ${resp.status}`);
      }

      const data = await resp.json();
      clearTimeout(timeout);
      return data;
    } catch (err) {
      clearTimeout(timeout);
      if (err.message.includes("Rate limited") || err.message.startsWith("HTTP") || err.message.includes("404")) throw err;
      if (attempt < retries - 1) {
        await delay(2000 * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }
}

// --- Time filter helpers ---
function getTimeFilterEpoch(timeFilter) {
  const now = Math.floor(Date.now() / 1000);
  switch (timeFilter) {
    case "day": return now - 86400;
    case "week": return now - 7 * 86400;
    case "month": return now - 30 * 86400;
    case "year": return now - 365 * 86400;
    default: return 0;
  }
}

// Arctic Shift re-fetches each item ~36h after creation; the score is frozen at
// that fetch. Export when, so researchers can tell a settled score from a fresh one.
function scoreAsOf(raw) {
  const t = raw._meta?.retrieved_2nd_on || raw.retrieved_on || raw.retrieved_utc || null;
  return t ? new Date(t * 1000).toISOString() : "";
}

// --- Unified post/comment mappers ---
function mapPost(raw) {
  const created = raw.created_utc || 0;
  const permalink = raw.permalink || (raw.id && raw.subreddit ? `/r/${raw.subreddit}/comments/${raw.id}/` : "");
  return {
    id: raw.id || "",
    title: raw.title || "",
    selftext: raw.selftext || "",
    author: raw.author || "[deleted]",
    created_utc: created,
    created_datetime: created ? new Date(created * 1000).toISOString() : "",
    score: raw.score || 0,
    score_as_of: scoreAsOf(raw),
    upvote_ratio: raw.upvote_ratio || 0,
    num_comments: raw.num_comments || 0,
    url: raw.url || "",
    permalink: permalink.startsWith("http") ? permalink : `https://reddit.com${permalink}`,
    link_flair_text: raw.link_flair_text || "",
    over_18: raw.over_18 || false,
    edited: raw.edited ? (typeof raw.edited === "number" ? raw.edited : true) : false,
    distinguished: raw.distinguished || null,
    is_crosspost: !!(raw.crosspost_parent),
    crosspost_subreddit: raw.crosspost_parent_list?.[0]?.subreddit || "",
    total_awards_received: raw.total_awards_received || 0,
    gilded: raw.gilded || 0,
    comments: [],
  };
}

function mapComment(raw) {
  const created = raw.created_utc || 0;
  return {
    id: raw.id || "",
    body: raw.body || "",
    author: raw.author || "[deleted]",
    created_utc: created,
    created_datetime: created ? new Date(created * 1000).toISOString() : "",
    score: raw.score || 0,
    score_as_of: scoreAsOf(raw),
    parent_id: raw.parent_id || "",
    is_submitter: raw.is_submitter || false,
    depth: null, // derived from parent_id by the client once the thread is whole
    edited: raw.edited ? (typeof raw.edited === "number" ? raw.edited : true) : false,
    distinguished: raw.distinguished || null,
    controversiality: raw.controversiality || 0,
  };
}

// --- Arctic Shift ---

async function arcticSearchPosts(subreddit, { limit = 100, before = null, after = null } = {}) {
  const params = new URLSearchParams({
    subreddit,
    limit: String(Math.min(limit, 100)),
    sort: "desc",
  });
  if (before) params.set("before", String(before));
  if (after) params.set("after", String(after));

  const url = `${ARCTIC_SHIFT}/api/posts/search?${params}`;
  const data = await fetchJSON(url);
  return data?.data || [];
}

// Arctic Shift pages are capped at 100 and `after` is exclusive, so a comment
// posted in the same second as a page's last one would fall between pages.
// Re-fetch from that second (dedup absorbs the overlap) and stop on the time
// budget rather than a count — the caller continues from the returned cursor.
async function arcticSearchPostsAsc(subreddit, after, before) {
  const params = new URLSearchParams({ subreddit, limit: "100", sort: "asc", after: String(after), before: String(before) });
  const data = await fetchJSON(`${ARCTIC_SHIFT}/api/posts/search?${params}`);
  return data?.data || [];
}

async function arcticSearchComments(postId, { after = null, budgetMs = 18000 } = {}) {
  const linkId = postId.startsWith("t3_") ? postId : `t3_${postId}`;
  const comments = [];
  const seenIds = new Set();
  const started = Date.now();
  let cursor = after;
  let done = false;

  while (true) {
    const params = new URLSearchParams({ link_id: linkId, limit: "100", sort: "asc" });
    if (cursor) params.set("after", String(cursor));

    const data = await fetchJSON(`${ARCTIC_SHIFT}/api/comments/search?${params}`);
    const batch = data?.data || [];

    for (const c of batch) {
      if (c.id && !seenIds.has(c.id)) {
        seenIds.add(c.id);
        comments.push(c);
      }
    }

    const last = batch[batch.length - 1];
    if (batch.length < 100 || !last?.created_utc) {
      done = true;
      break;
    }
    // If a whole page sits inside one second, re-fetching from that second would
    // return the same page forever; step past it (anything beyond 100 in that
    // second is unreachable through this API) so the walk always advances.
    const next = last.created_utc - 1;
    cursor = next === cursor ? last.created_utc : next;
    if (Date.now() - started > budgetMs) break;
    await delay(300);
  }

  return { comments, after: done ? null : cursor, done };
}

async function arcticGetSubreddit(subreddit) {
  const params = new URLSearchParams({ subreddit, limit: "1" });
  const url = `${ARCTIC_SHIFT}/api/subreddits/search?${params}`;
  const data = await fetchJSON(url);
  const results = data?.data || [];
  return results.length > 0 ? results[0] : null;
}

async function arcticGetPostById(postId) {
  const cleanId = postId.replace(/^t3_/, "");
  const url = `${ARCTIC_SHIFT}/api/posts/ids?ids=${cleanId}`;
  const data = await fetchJSON(url);
  const results = data?.data || [];
  return results.length > 0 ? results[0] : null;
}

async function arcticEstimatePostCount(subreddit) {
  try {
    // The aggregate endpoint requires an explicit time window; ask for everything
    // since before Reddit existed so the bucket sum covers the whole archive.
    const url = `${ARCTIC_SHIFT}/api/posts/search/aggregate?subreddit=${encodeURIComponent(subreddit)}&aggregate=created_utc&frequency=year&after=1104537600`;
    const data = await fetchJSON(url);
    const buckets = data?.data || data?.aggs || [];
    let total = 0;
    if (Array.isArray(buckets)) {
      // Counts come back as strings; coerce or += concatenates into a truthy "000..."
      for (const b of buckets) total += Number(b.doc_count ?? b.count ?? b.bg_count ?? 0) || 0;
    }
    return total;
  } catch {
    return 0;
  }
}

// --- PullPush ---

async function pullPushFetch(url) {
  if (pullPushBlocked) throw new Error("PullPush unavailable");
  try {
    return await fetchJSON(url, 2, { retryOn429: false });
  } catch (err) {
    if (err.message.includes("Rate limited") || err.message.includes("HTTP 429")) {
      pullPushBlocked = true;
    }
    throw err;
  }
}

async function pullPushSearchSubmissions(subreddit, { size = 100, before = null, after = null, sortType = "created_utc", sort = "desc" } = {}) {
  const params = new URLSearchParams({
    subreddit,
    size: String(Math.min(size, 100)),
    sort,
    sort_type: sortType,
  });
  if (before) params.set("before", String(before));
  if (after) params.set("after", String(after));

  const url = `${PULLPUSH}/reddit/search/submission/?${params}`;
  const data = await pullPushFetch(url);
  return data?.data || [];
}

async function pullPushGetComments(postId) {
  const cleanId = postId.replace(/^t3_/, "");

  // Try the dedicated submission comments endpoint first
  try {
    const url = `${PULLPUSH}/reddit/submission/${cleanId}/comments/`;
    const data = await pullPushFetch(url);
    if (data?.data?.length > 0) return data.data;
  } catch { /* fall through */ }

  // Fallback to comment search
  try {
    const url = `${PULLPUSH}/reddit/search/comment/?link_id=${cleanId}&size=100&sort=asc`;
    const data = await pullPushFetch(url);
    return data?.data || [];
  } catch {
    return [];
  }
}

async function pullPushGetSubmission(postId) {
  const cleanId = postId.replace(/^t3_/, "");
  const url = `${PULLPUSH}/reddit/search/submission/?ids=${cleanId}`;
  const data = await pullPushFetch(url);
  const results = data?.data || [];
  return results.length > 0 ? results[0] : null;
}

// --- Flatten comment trees (Arctic Shift returns nested structures) ---

function flattenCommentTree(items, depth = 0) {
  const result = [];
  if (!Array.isArray(items)) return result;

  for (const item of items) {
    // Skip "more" placeholders
    if (!item || item.kind === "more") continue;

    result.push(mapComment(item));

    // Arctic Shift nests replies in various ways
    const replies = item.replies || item.children;
    if (Array.isArray(replies)) {
      result.push(...flattenCommentTree(replies, depth + 1));
    }
  }
  return result;
}

// --- Comment tree helpers ---

function attachComments(post, { comments, after, done }) {
  post.comments = comments.map((c) => mapComment(c));
  post.comments_complete = done;
  post.comments_cursor = after;
}

// --- Combined fetchers with fallback ---

async function fetchPostsBatch(subreddit, sort, limit, paginationCursor, timeAfterEpoch, hardBeforeEpoch) {
  const isScoreSort = sort === "top" || sort === "controversial";
  const isHot = sort === "hot";
  const isRising = sort === "rising";

  // For "hot": use last 7 days; for "rising": last 24 hours
  let effectiveAfter = timeAfterEpoch || 0;
  if (isHot && !effectiveAfter) {
    effectiveAfter = Math.floor(Date.now() / 1000) - 7 * 86400;
  } else if (isRising && !effectiveAfter) {
    effectiveAfter = Math.floor(Date.now() / 1000) - 86400;
  }

  // Parse pagination cursor
  let beforeUtc = hardBeforeEpoch || null;
  let maxScore = null;
  if (paginationCursor) {
    if (paginationCursor.startsWith("score:")) {
      maxScore = parseInt(paginationCursor.split(":")[1], 10);
    } else {
      const cursorUtc = parseInt(paginationCursor, 10);
      // Use the earlier of pagination cursor and hard before limit
      beforeUtc = beforeUtc ? Math.min(beforeUtc, cursorUtc) : cursorUtc;
    }
  }

  // --- Strategy per sort mode ---

  // For score-sorted modes, prefer PullPush (it supports sort_type=score)
  if (isScoreSort) {
    const ppSortType = sort === "top" ? "score" : "num_comments";

    // Try PullPush with score sort
    try {
      const ppParams = {
        size: limit,
        sortType: ppSortType,
        sort: "desc",
        after: effectiveAfter || undefined,
      };

      if (beforeUtc) ppParams.before = beforeUtc;

      const posts = await pullPushSearchSubmissions(subreddit, ppParams);
      if (posts.length > 0) {
        // If we have a maxScore cursor, filter out posts we've likely already seen
        const filtered = maxScore !== null
          ? posts.filter((p) => (p.score || 0) <= maxScore)
          : posts;
        if (filtered.length > 0) return { posts: filtered, source: "pullpush" };
      }
    } catch { /* fall through */ }
  }

  // For time-sorted modes (new, hot, rising) or as fallback, use Arctic Shift
  try {
    const asParams = {
      limit,
      before: beforeUtc || undefined,
      after: effectiveAfter || undefined,
    };
    const posts = await arcticSearchPosts(subreddit, asParams);
    if (posts.length > 0) return { posts, source: "arctic" };
  } catch { /* fall through */ }

  // Last fallback: PullPush time-sorted
  try {
    const ppParams = {
      size: limit,
      sortType: "created_utc",
      sort: "desc",
      before: beforeUtc || undefined,
      after: effectiveAfter || undefined,
    };
    const posts = await pullPushSearchSubmissions(subreddit, ppParams);
    if (posts.length > 0) return { posts, source: "pullpush" };
  } catch { /* fall through */ }

  return { posts: [], source: "none" };
}

async function fetchCommentsForPost(postId, { after = null, budgetMs = 18000 } = {}) {
  try {
    return await arcticSearchComments(postId, { after, budgetMs });
  } catch { /* fall through */ }

  try {
    const comments = await pullPushGetComments(postId);
    return { comments, after: null, done: true };
  } catch { /* fall through */ }

  return { comments: [], after: null, done: true };
}

// --- Analyze subreddit ---

async function analyzeSubreddit(subreddit) {
  let info = {
    name: subreddit,
    title: "",
    subscribers: 0,
    active_users: 0,
    created_utc: 0,
    description: "",
    over18: false,
  };
  let archive = { posts: 0, comments: 0, counted_at: 0, earliest_post: 0 };

  // Try Arctic Shift for subreddit metadata
  let estimatedTotal = 0;
  try {
    const sub = await arcticGetSubreddit(subreddit);
    if (sub) {
      info.name = sub.display_name || sub.name || subreddit;
      info.title = sub.title || "";
      info.subscribers = sub.subscribers || 0;
      info.created_utc = sub.created_utc || 0;
      info.description = (sub.public_description || sub.description || "").slice(0, 300);
      info.over18 = sub.over18 || sub.over_18 || false;
      // The subreddit record carries exact archive totals; prefer them.
      estimatedTotal = sub._meta?.num_posts || 0;
      archive = {
        posts: sub._meta?.num_posts || 0,
        comments: sub._meta?.num_comments || 0,
        counted_at: sub._meta?.num_posts_updated_at || 0,
        earliest_post: sub._meta?.earliest_post || 0,
      };
    }
  } catch { /* use defaults */ }

  if (estimatedTotal === 0) {
    try {
      estimatedTotal = await arcticEstimatePostCount(subreddit);
    } catch { /* leave at 0 */ }
  }

  // Last resort before declaring the subreddit missing: does it have any posts at all?
  if (estimatedTotal === 0) {
    try {
      const probe = await arcticSearchPosts(subreddit, { limit: 1 });
      if (probe.length > 0) estimatedTotal = 1000;
    } catch { /* leave at 0 */ }
  }

  // Verify subreddit exists via PullPush if Arctic Shift returned nothing
  if (estimatedTotal === 0) {
    try {
      const posts = await pullPushSearchSubmissions(subreddit, { size: 1 });
      if (posts.length > 0) {
        estimatedTotal = 1000;
        if (!info.title) info.name = posts[0].subreddit || subreddit;
      }
    } catch { /* leave at 0 */ }
  }

  if (estimatedTotal === 0) {
    throw new Error(`Subreddit r/${subreddit} not found or has no archived posts. Very new subreddits may not be indexed yet.`);
  }

  const hasAnyPosts = estimatedTotal > 0;
  const cap = (n) => Math.min(n, estimatedTotal);

  const probes = [
    { sort: "new", timeFilter: "all", label: "Newest First", available: hasAnyPosts, estimatedMax: cap(1000) },
    { sort: "top", timeFilter: "all", label: "Top (by score)", available: hasAnyPosts, estimatedMax: cap(1000) },
    { sort: "hot", timeFilter: "all", label: "Recent & Popular", available: hasAnyPosts, estimatedMax: cap(500) },
    { sort: "controversial", timeFilter: "all", label: "Most Discussed", available: hasAnyPosts, estimatedMax: cap(500) },
    { sort: "rising", timeFilter: "all", label: "Latest (24h)", available: hasAnyPosts, estimatedMax: cap(100) },
  ];

  return {
    info,
    probes,
    estimatedTotalUnique: estimatedTotal,
    archive,
    sortConfigs: probes.filter((p) => p.available),
  };
}

// --- Count posts in a date window ---
// The archive's aggregate index lags by months and times out on large
// subreddits, so: walk the window exactly while it is small, otherwise sample
// the posting rate at several points and extrapolate (calibrated to ~±15%).
async function countWindow(subreddit, after, before) {
  const EXACT_PAGES = 5;
  let posts = 0, comments = 0, cursor = before, pages = 0, endPage = null;
  const seen = new Set();
  while (pages < EXACT_PAGES) {
    const batch = await arcticSearchPosts(subreddit, { limit: 100, after, before: cursor });
    pages++;
    for (const p of batch) {
      if (!p.id || seen.has(p.id)) continue;
      seen.add(p.id);
      posts++;
      comments += p.num_comments || 0;
    }
    if (pages === 1) endPage = batch;
    if (batch.length < 100) return { posts, comments, exact: true };
    // `before` is exclusive: re-cover the boundary second, dedup absorbs the overlap
    const last = batch[batch.length - 1].created_utc;
    const next = last + 1;
    cursor = next === cursor ? last : next;
    await delay(200);
  }

  const span = before - after;
  const rates = [];
  const perPost = [];
  const sample = (batch) => {
    const ts = batch.map((p) => p.created_utc);
    const dt = Math.max(...ts) - Math.min(...ts);
    if (dt > 0) rates.push(batch.length / dt);
    perPost.push(batch.reduce((z, p) => z + (p.num_comments || 0), 0) / batch.length);
  };
  sample(endPage);
  for (const frac of [0, 0.25, 0.5, 0.75]) {
    const batch = await arcticSearchPostsAsc(subreddit, Math.floor(after + span * frac), before);
    if (batch.length === 100) sample(batch);
    await delay(200);
  }
  if (rates.length === 0) return { posts, comments, exact: false };
  const rate = rates.reduce((a, b) => a + b, 0) / rates.length;
  const est = Math.round(rate * span);
  const cpp = perPost.reduce((a, b) => a + b, 0) / perPost.length;
  return { posts: est, comments: Math.round(est * cpp), exact: false };
}

// --- Thread scraping ---

async function scrapeThread(subreddit, postId) {
  let post = null;

  // Get the post
  try {
    const raw = await arcticGetPostById(postId);
    if (raw) post = mapPost(raw);
  } catch { /* try fallback */ }

  if (!post) {
    try {
      const raw = await pullPushGetSubmission(postId);
      if (raw) post = mapPost(raw);
    } catch { /* nope */ }
  }

  if (!post) {
    throw new Error("Could not find this post. It may have been deleted, or the archive hasn't indexed it yet.");
  }

  attachComments(post, await fetchCommentsForPost(postId, { budgetMs: 18000 }));
  return post;
}

// --- URL parsing ---

function parseRedditInput(input) {
  const trimmed = (input || "").trim();

  const threadMatch = trimmed.match(/reddit\.com\/r\/([^/?\s]+)\/comments\/([^/?\s]+)/);
  if (threadMatch) return { type: "thread", subreddit: threadMatch[1], postId: threadMatch[2] };

  const subMatch = trimmed.match(/reddit\.com\/r\/([^/?\s]+)/);
  if (subMatch) return { type: "subreddit", subreddit: subMatch[1] };

  const plain = trimmed.replace(/^r\//, "");
  if (plain) return { type: "subreddit", subreddit: plain };

  return { type: "invalid" };
}

// --- Handler ---

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://redditscrapersbe.netlify.app';

export async function handler(event) {
  const headers = {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type, x-api-key",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  const apiKey = event.headers['x-api-key'];
  const expectedKey = process.env.SCRAPE_API_KEY || '';
  if (expectedKey && apiKey !== expectedKey) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  try {
    const body = JSON.parse(event.body);

    // --- Analyze action ---
    if (body.action === "analyze") {
      const parsed = parseRedditInput(body.subreddit);

      if (parsed.type === "thread") {
        const post = await scrapeThread(parsed.subreddit, parsed.postId);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ type: "thread", subreddit: parsed.subreddit, post }),
        };
      }

      if (parsed.type === "invalid" || !parsed.subreddit) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Subreddit name is required" }) };
      }

      const analysis = await analyzeSubreddit(parsed.subreddit);
      return { statusCode: 200, headers, body: JSON.stringify({ type: "subreddit", ...analysis }) };
    }

    // --- Count posts in a window (exact when small, sampled estimate otherwise) ---
    if (body.action === "count") {
      const sub = String(body.subreddit || "").replace(/^r\//, "");
      if (!/^[A-Za-z0-9_]{1,50}$/.test(sub)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid subreddit name" }) };
      }
      const after = Number(body.afterEpoch), before = Number(body.beforeEpoch);
      if (!Number.isFinite(after) || !Number.isFinite(before) || before <= after) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid date range" }) };
      }
      const result = await countWindow(sub, Math.floor(after), Math.floor(before));
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    // --- Comment continuation: the client calls this until done ---
    if (body.action === "comments") {
      const postId = String(body.postId || "").replace(/^t3_/, "");
      if (!/^[a-z0-9]{1,12}$/.test(postId)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid post id" }) };
      }
      const after = body.after == null ? null : Number(body.after);
      if (after !== null && !Number.isFinite(after)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid cursor" }) };
      }
      const page = await fetchCommentsForPost(postId, { after, budgetMs: 18000 });
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ comments: page.comments.map((c) => mapComment(c)), after: page.after, done: page.done }),
      };
    }

    // --- Scrape batch action ---
    const {
      subreddit,
      sort = "new",
      batchSize = 100,
      after = null,
      includeComments = true,
      skipIds = [],
      timeFilter = "all",
    } = body;

    let parsedSubreddit = (subreddit || "").trim();
    const urlMatch = parsedSubreddit.match(/reddit\.com\/r\/([^/?\s]+)/);
    if (urlMatch) parsedSubreddit = urlMatch[1];
    parsedSubreddit = parsedSubreddit.replace(/^r\//, "");

    if (!parsedSubreddit) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Subreddit name is required" }) };
    }

    if (!/^[A-Za-z0-9_]{1,50}$/.test(parsedSubreddit)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid subreddit name" }) };
    }

    // Only use the last 200 skipIds to prevent request body bloat
    // Client-side deduplication handles the full set
    const seenIds = new Set(skipIds.slice(-200));
    const effectiveBatch = Math.min(batchSize, 100);

    // Custom date range takes priority over preset time filters
    const afterEpochOverride = body.afterEpoch ? Number(body.afterEpoch) : null;
    const beforeEpochOverride = body.beforeEpoch ? Number(body.beforeEpoch) : null;
    const timeAfterEpoch = afterEpochOverride || getTimeFilterEpoch(timeFilter);

    const { posts: rawPosts, source: postSource } = await fetchPostsBatch(
      parsedSubreddit,
      sort,
      effectiveBatch,
      after,
      timeAfterEpoch > 0 ? timeAfterEpoch : undefined,
      beforeEpochOverride || undefined,
    );

    if (!rawPosts || rawPosts.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ posts: [], after: null, done: true }),
      };
    }

    // Map and deduplicate
    const posts = [];
    for (const raw of rawPosts) {
      const id = raw.id;
      if (!id || seenIds.has(id)) continue;
      posts.push(mapPost(raw));
    }

    // Fetch comments in parallel batches inside the 26s function limit. Anything
    // this pass cannot finish is flagged incomplete with a cursor; the client
    // continues those via the "comments" action so no dataset is silently partial.
    if (includeComments) {
      const PARALLEL = 3;
      const startTime = Date.now();
      const TIME_BUDGET_MS = 18000;
      const PER_POST_BUDGET_MS = 5000;
      for (const p of posts) {
        p.comments_complete = p.num_comments === 0;
        p.comments_cursor = null;
      }
      const postsNeedingComments = posts.filter((p) => p.num_comments > 0);
      for (let i = 0; i < postsNeedingComments.length; i += PARALLEL) {
        if (Date.now() - startTime > TIME_BUDGET_MS) break;
        if (i > 0) await delay(500);
        const batch = postsNeedingComments.slice(i, i + PARALLEL);
        const results = await Promise.all(
          batch.map((p) => fetchCommentsForPost(p.id, { budgetMs: PER_POST_BUDGET_MS })),
        );
        for (let j = 0; j < batch.length; j++) attachComments(batch[j], results[j]);
      }
    }

    // Rank score-sorted modes within the batch. Arctic Shift only sorts by time,
    // so when it answers, the ordering has to be applied here.
    const isScoreSort = sort === "top" || sort === "controversial";
    if (isScoreSort && postSource !== "pullpush") {
      const key = sort === "top" ? "score" : "num_comments";
      posts.sort((a, b) => (b[key] || 0) - (a[key] || 0));
    }

    // Build pagination cursor for next page
    let nextAfter = null;

    if (posts.length > 0 && posts.length >= effectiveBatch) {
      if (isScoreSort && postSource === "pullpush") {
        // For score-sorted: use the minimum score as cursor
        const minScore = Math.min(...posts.map((p) => p.score));
        nextAfter = `score:${minScore}`;
      } else {
        // For time-sorted: use the oldest post's timestamp
        // Keep exact value — deduplication via skipIds handles overlap
        const oldestUtc = Math.min(...posts.map((p) => p.created_utc));
        nextAfter = String(oldestUtc);
      }
    }

    // Account for deduplication reducing post count below batch size
    const done = !nextAfter || rawPosts.length < effectiveBatch;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ posts, after: nextAfter, done }),
    };
  } catch (err) {
    const message = (err.message || "Unknown error").slice(0, 500);
    return { statusCode: 500, headers, body: JSON.stringify({ error: message }) };
  }
}
