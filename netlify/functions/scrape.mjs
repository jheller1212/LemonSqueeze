// Reddit data scraper serverless function for Netlify
// Uses Arctic Shift (primary) and PullPush (fallback) — no Reddit API needed

const ARCTIC_SHIFT = "https://arctic-shift.photon-reddit.com";
const PULLPUSH = "https://api.pullpush.io";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJSON(url, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "LemonSqueeze/1.0 (academic research tool)" },
      });

      if (resp.status === 429) {
        if (attempt < retries - 1) {
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

      return await resp.json();
    } catch (err) {
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

function mapComment(raw, depth = 0) {
  const created = raw.created_utc || 0;
  return {
    id: raw.id || "",
    body: raw.body || "",
    author: raw.author || "[deleted]",
    created_utc: created,
    created_datetime: created ? new Date(created * 1000).toISOString() : "",
    score: raw.score || 0,
    parent_id: raw.parent_id || "",
    is_submitter: raw.is_submitter || false,
    depth: raw.depth ?? depth,
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

async function arcticSearchComments(postId, limit = 500) {
  const linkId = postId.startsWith("t3_") ? postId : `t3_${postId}`;
  const allComments = [];
  let after = null;

  // Paginate through comments in batches
  while (allComments.length < limit) {
    const params = new URLSearchParams({
      link_id: linkId,
      limit: String(Math.min(100, limit - allComments.length)),
      sort: "asc",
    });
    if (after) params.set("after", String(after));

    const url = `${ARCTIC_SHIFT}/api/comments/search?${params}`;
    const data = await fetchJSON(url);
    const batch = data?.data || [];
    if (batch.length === 0) break;

    allComments.push(...batch);

    // Use the last comment's created_utc for pagination
    const last = batch[batch.length - 1];
    if (last?.created_utc) {
      after = last.created_utc;
    } else {
      break;
    }

    // Stop if we got fewer than requested (no more data)
    if (batch.length < 100) break;
    await delay(500);
  }

  return allComments;
}

async function arcticGetSubreddit(subreddit) {
  const params = new URLSearchParams({ name: subreddit, limit: "1" });
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
    const url = `${ARCTIC_SHIFT}/api/posts/search/aggregate?subreddit=${encodeURIComponent(subreddit)}&aggregate=created_utc&frequency=year`;
    const data = await fetchJSON(url);
    const buckets = data?.data || data?.aggs || [];
    let total = 0;
    if (Array.isArray(buckets)) {
      for (const b of buckets) total += b.doc_count || b.count || b.bg_count || 0;
    }
    return total;
  } catch {
    return 0;
  }
}

// --- PullPush ---

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
  const data = await fetchJSON(url);
  return data?.data || [];
}

async function pullPushGetComments(postId) {
  const cleanId = postId.replace(/^t3_/, "");

  // Try the dedicated submission comments endpoint first
  try {
    const url = `${PULLPUSH}/reddit/submission/${cleanId}/comments/`;
    const data = await fetchJSON(url);
    if (data?.data?.length > 0) return data.data;
  } catch { /* fall through */ }

  // Fallback to comment search
  try {
    const url = `${PULLPUSH}/reddit/search/comment/?link_id=${cleanId}&size=100&sort=asc`;
    const data = await fetchJSON(url);
    return data?.data || [];
  } catch {
    return [];
  }
}

async function pullPushGetSubmission(postId) {
  const cleanId = postId.replace(/^t3_/, "");
  const url = `${PULLPUSH}/reddit/search/submission/?ids=${cleanId}`;
  const data = await fetchJSON(url);
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

    result.push(mapComment(item, depth));

    // Arctic Shift nests replies in various ways
    const replies = item.replies || item.children;
    if (Array.isArray(replies)) {
      result.push(...flattenCommentTree(replies, depth + 1));
    }
  }
  return result;
}

// --- Combined fetchers with fallback ---

async function fetchPostsBatch(subreddit, sort, limit, paginationCursor, timeAfterEpoch) {
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
  let beforeUtc = null;
  let maxScore = null;
  if (paginationCursor) {
    if (paginationCursor.startsWith("score:")) {
      maxScore = parseInt(paginationCursor.split(":")[1], 10);
    } else {
      beforeUtc = parseInt(paginationCursor, 10);
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

      // Score-based pagination: filter to posts with score below last page's minimum
      if (maxScore !== null) {
        // PullPush supports score filter; we'll fetch and filter client-side as fallback
        ppParams.before = undefined;
      }
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

async function fetchCommentsForPost(postId, subreddit) {
  // Try Arctic Shift comment search (flat results, well-structured)
  try {
    const comments = await arcticSearchComments(postId);
    if (comments.length > 0) return comments.map((c) => mapComment(c));
  } catch { /* fall through */ }

  // Fallback to PullPush
  try {
    const comments = await pullPushGetComments(postId);
    if (comments.length > 0) return comments.map((c) => mapComment(c));
  } catch { /* fall through */ }

  return [];
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

  // Try Arctic Shift for subreddit metadata
  try {
    const sub = await arcticGetSubreddit(subreddit);
    if (sub) {
      info.name = sub.display_name || sub.name || subreddit;
      info.title = sub.title || "";
      info.subscribers = sub.subscribers || 0;
      info.created_utc = sub.created_utc || 0;
      info.description = (sub.public_description || sub.description || "").slice(0, 300);
      info.over18 = sub.over18 || sub.over_18 || false;
    }
  } catch { /* use defaults */ }

  // Estimate post count
  let estimatedTotal = 0;
  try {
    estimatedTotal = await arcticEstimatePostCount(subreddit);
  } catch { /* leave at 0 */ }

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
    estimatedTotalUnique: Math.min(estimatedTotal, 10000),
    sortConfigs: probes.filter((p) => p.available),
  };
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

  // Get comments
  post.comments = await fetchCommentsForPost(postId, subreddit);
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

export async function handler(event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

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

    const seenIds = new Set(skipIds);
    const effectiveBatch = Math.min(batchSize, 100);
    const timeAfterEpoch = getTimeFilterEpoch(timeFilter);

    const { posts: rawPosts } = await fetchPostsBatch(
      parsedSubreddit,
      sort,
      effectiveBatch,
      after,
      timeAfterEpoch > 0 ? timeAfterEpoch : undefined,
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

    // Fetch comments in parallel batches
    if (includeComments) {
      const PARALLEL = 3;
      const postsNeedingComments = posts.filter((p) => p.num_comments > 0);
      for (let i = 0; i < postsNeedingComments.length; i += PARALLEL) {
        if (i > 0) await delay(1000);
        const batch = postsNeedingComments.slice(i, i + PARALLEL);
        const results = await Promise.all(
          batch.map((p) => fetchCommentsForPost(p.id, parsedSubreddit)),
        );
        for (let j = 0; j < batch.length; j++) {
          batch[j].comments = results[j];
        }
      }
    }

    // Build pagination cursor for next page
    let nextAfter = null;
    const isScoreSort = sort === "top" || sort === "controversial";

    if (posts.length > 0 && posts.length >= effectiveBatch) {
      if (isScoreSort) {
        // For score-sorted: use the minimum score as cursor
        const minScore = Math.min(...posts.map((p) => p.score));
        nextAfter = `score:${minScore}`;
      } else {
        // For time-sorted: use the oldest post's timestamp
        const oldestUtc = Math.min(...posts.map((p) => p.created_utc));
        nextAfter = String(oldestUtc);
      }
    }

    const done = !nextAfter || posts.length < effectiveBatch;

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
