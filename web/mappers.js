// One definition of how an archive record becomes a post or comment row, shared
// by the browser (window.Mappers) and the Netlify function (ES import).

// Arctic Shift re-fetches each item ~36h after creation; the score is frozen at
// that fetch. Export when, so researchers can tell a settled score from a fresh one.
export function scoreAsOf(raw) {
  const t = raw._meta?.retrieved_2nd_on || raw.retrieved_on || raw.retrieved_utc || null;
  return t ? new Date(t * 1000).toISOString() : "";
}

export function mapPost(raw) {
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
    subreddit: raw.subreddit || "",
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

export function mapComment(raw) {
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

if (typeof window !== "undefined") {
  window.Mappers = { scoreAsOf, mapPost, mapComment };
}
