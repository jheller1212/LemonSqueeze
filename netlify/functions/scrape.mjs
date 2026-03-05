// Reddit scraper serverless function for Netlify
// Uses public JSON endpoints — no API credentials required

const USER_AGENT = "MyBoyfriendIsAI-Scraper/1.0 (research; no auth)";
const BASE_URL = "https://www.reddit.com";

async function fetchWithRetry(url, options = {}, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const resp = await fetch(url, {
      ...options,
      headers: { "User-Agent": USER_AGENT, ...options.headers },
    });

    if (resp.status === 429) {
      const wait = 2 ** (attempt + 1) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Reddit error (${resp.status}): ${text}`);
    }

    return resp.json();
  }
  throw new Error("Rate limited by Reddit after multiple retries");
}

async function fetchListing(subreddit, sort, limit, after = null) {
  let url = `${BASE_URL}/r/${subreddit}/${sort}.json?limit=${Math.min(limit, 100)}&raw_json=1`;
  if (sort === "top") url += "&t=all";
  if (after) url += `&after=${after}`;
  return fetchWithRetry(url);
}

async function fetchComments(subreddit, postId) {
  const url = `${BASE_URL}/r/${subreddit}/comments/${postId}.json?raw_json=1&limit=500&depth=10`;
  try {
    const data = await fetchWithRetry(url);
    if (!data[1] || !data[1].data) return [];

    const comments = [];
    function extractComments(children) {
      for (const child of children) {
        if (child.kind !== "t1") continue;
        const c = child.data;
        comments.push({
          id: c.id,
          body: c.body || "",
          author: c.author || "[deleted]",
          created_utc: c.created_utc,
          created_datetime: new Date(c.created_utc * 1000).toISOString(),
          score: c.score,
          parent_id: c.parent_id,
          is_submitter: c.is_submitter || false,
        });
        if (c.replies && c.replies.data && c.replies.data.children) {
          extractComments(c.replies.data.children);
        }
      }
    }

    extractComments(data[1].data.children);
    return comments;
  } catch {
    return [];
  }
}

function extractPost(postData) {
  const p = postData.data;
  return {
    id: p.id,
    title: p.title || "",
    selftext: p.selftext || "",
    author: p.author || "[deleted]",
    created_utc: p.created_utc,
    created_datetime: new Date(p.created_utc * 1000).toISOString(),
    score: p.score,
    upvote_ratio: p.upvote_ratio,
    num_comments: p.num_comments,
    url: p.url,
    permalink: `https://reddit.com${p.permalink}`,
    link_flair_text: p.link_flair_text || "",
    comments: [],
  };
}

export async function handler(event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    const body = JSON.parse(event.body);
    const {
      subreddit,
      sort = "new",
      batchSize = 25,
      after = null,
      includeComments = true,
      skipIds = [],
    } = body;

    let parsedSubreddit = (subreddit || "").trim();
    const urlMatch = parsedSubreddit.match(/reddit\.com\/r\/([^/?\s]+)/);
    if (urlMatch) parsedSubreddit = urlMatch[1];
    parsedSubreddit = parsedSubreddit.replace(/^r\//, "");

    if (!parsedSubreddit) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Subreddit name is required" }) };
    }

    const seenIds = new Set(skipIds);
    const effectiveBatch = Math.min(includeComments ? batchSize : Math.min(batchSize, 100), 100);

    const listing = await fetchListing(parsedSubreddit, sort, effectiveBatch, after);

    if (!listing.data || !listing.data.children || listing.data.children.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ posts: [], after: null, done: true }),
      };
    }

    const posts = [];
    for (const child of listing.data.children) {
      if (child.kind !== "t3") continue;
      if (seenIds.has(child.data.id)) continue;

      const post = extractPost(child);

      if (includeComments && post.num_comments > 0) {
        post.comments = await fetchComments(parsedSubreddit, post.id);
      }

      posts.push(post);
    }

    const nextAfter = listing.data.after || null;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        posts,
        after: nextAfter,
        done: nextAfter === null,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
}
