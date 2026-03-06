// Reddit scraper serverless function for Netlify
// Uses Reddit OAuth API (required — public endpoints are blocked from server IPs)

const APP_USER_AGENT = "LemonSqueeze/1.0 (research scraper)";

// OAuth state (cached across invocations in the same Lambda container)
let oauthToken = null;
let oauthExpiry = 0;

async function getOAuthToken() {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "Reddit API credentials are not configured. " +
      "The site owner needs to set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET " +
      "in the Netlify dashboard (Site Settings → Environment Variables). " +
      "Get free credentials at https://www.reddit.com/prefs/apps — create a 'script' type app."
    );
  }

  // Reuse token if still valid
  if (oauthToken && Date.now() < oauthExpiry) return oauthToken;

  const resp = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      "Authorization": "Basic " + btoa(`${clientId}:${clientSecret}`),
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": APP_USER_AGENT,
    },
    body: "grant_type=client_credentials",
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Failed to authenticate with Reddit API (${resp.status}). ` +
      "Check that REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET are correct."
    );
  }

  const data = await resp.json();
  oauthToken = data.access_token;
  // Expire 60s early to be safe
  oauthExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return oauthToken;
}

async function fetchReddit(url, retries = 3) {
  const token = await getOAuthToken();

  // OAuth requests go to oauth.reddit.com
  const oauthUrl = url.replace(
    /https:\/\/(old|www)\.reddit\.com/,
    "https://oauth.reddit.com"
  );

  for (let attempt = 0; attempt < retries; attempt++) {
    const resp = await fetch(oauthUrl, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "User-Agent": APP_USER_AGENT,
      },
    });

    if (resp.status === 429) {
      // Rate limited — wait with exponential backoff
      const wait = 2 ** (attempt + 1) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    if (resp.status === 401) {
      // Token expired mid-session — force refresh and retry once
      oauthToken = null;
      oauthExpiry = 0;
      if (attempt === 0) {
        const newToken = await getOAuthToken();
        const retryResp = await fetch(oauthUrl, {
          headers: {
            "Authorization": `Bearer ${newToken}`,
            "User-Agent": APP_USER_AGENT,
          },
        });
        if (retryResp.ok) return retryResp.json();
      }
      throw new Error("Reddit API authentication failed. Credentials may be invalid.");
    }

    if (!resp.ok) {
      throw new Error(`Reddit API error (${resp.status})`);
    }

    return resp.json();
  }

  throw new Error("Reddit API rate limit exceeded. Please try again in a minute.");
}

async function fetchListing(subreddit, sort, limit, after = null, timeFilter = "all") {
  let url = `https://oauth.reddit.com/r/${subreddit}/${sort}.json?limit=${Math.min(limit, 100)}&raw_json=1`;
  if (sort === "top") url += `&t=${timeFilter}`;
  if (after) url += `&after=${after}`;
  return fetchReddit(url);
}

async function fetchComments(subreddit, postId) {
  const url = `https://oauth.reddit.com/r/${subreddit}/comments/${postId}.json?raw_json=1&limit=500&depth=10`;
  try {
    const data = await fetchReddit(url);
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
    over_18: p.over_18 || false,
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
    const effectiveBatch = Math.min(includeComments ? batchSize : Math.min(batchSize, 100), 100);

    const listing = await fetchListing(parsedSubreddit, sort, effectiveBatch, after, timeFilter);

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
    // Truncate error messages to avoid sending huge HTML dumps to the client
    const message = err.message.length > 500 ? err.message.slice(0, 500) + "…" : err.message;
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: message }),
    };
  }
}
