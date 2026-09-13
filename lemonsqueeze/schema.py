"""The output schema.

BASE_COLUMNS is the web app's combined export, column for column and in the
same order. Downstream files depend on it: never reorder or rename, only
append. STUDY_COLUMNS are appended after it.
"""
from datetime import datetime, timezone

BASE_COLUMNS = [
    "post_id", "subreddit", "post_title", "post_selftext", "post_author",
    "post_created_utc", "post_created_datetime", "post_date", "post_day_of_week", "post_hour_utc",
    "post_score", "post_score_as_of", "post_upvote_ratio", "post_num_comments", "post_permalink", "post_flair",
    "post_over_18", "post_edited", "post_distinguished",
    "post_is_crosspost", "post_crosspost_subreddit",
    "post_total_awards", "post_gilded",
    "post_title_word_count", "post_selftext_word_count", "post_comments_complete",
    "comment_id", "comment_body", "comment_author",
    "comment_created_utc", "comment_created_datetime", "comment_date", "comment_day_of_week", "comment_hour_utc",
    "comment_score", "comment_score_as_of", "comment_parent_id", "comment_is_submitter",
    "comment_depth", "comment_edited", "comment_distinguished", "comment_controversiality",
    "comment_body_word_count",
    "row_type", "query",
]

STUDY_COLUMNS = ["study", "source", "sort", "collected_at", "flags"]

COLUMNS = BASE_COLUMNS + STUDY_COLUMNS

DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]


def iso(ts):
    """Epoch seconds -> ISO-8601 UTC string, '' for missing."""
    if not ts:
        return ""
    return datetime.fromtimestamp(int(ts), tz=timezone.utc).isoformat().replace("+00:00", "Z")


def date_parts(ts):
    if not ts:
        return "", "", ""
    d = datetime.fromtimestamp(int(ts), tz=timezone.utc)
    # JS getUTCDay() is Sunday=0; Python weekday() is Monday=0
    return d.strftime("%Y-%m-%d"), DAYS[(d.weekday() + 1) % 7], d.hour


def word_count(text):
    return len((text or "").split())


def post_fields(post, comments_complete):
    """Map a normalised post onto the post_* columns."""
    date, day, hour = date_parts(post.get("created_utc"))
    return {
        "post_id": post["id"],
        "subreddit": post.get("subreddit", ""),
        "post_title": post.get("title", ""),
        "post_selftext": post.get("selftext", ""),
        "post_author": post.get("author", "[deleted]"),
        "post_created_utc": post.get("created_utc", 0),
        "post_created_datetime": iso(post.get("created_utc")),
        "post_date": date,
        "post_day_of_week": day,
        "post_hour_utc": hour,
        "post_score": post.get("score", 0),
        "post_score_as_of": post.get("score_as_of", ""),
        "post_upvote_ratio": post.get("upvote_ratio", 0),
        "post_num_comments": post.get("num_comments", 0),
        "post_permalink": post.get("permalink", ""),
        "post_flair": post.get("link_flair_text") or "",
        "post_over_18": bool(post.get("over_18", False)),
        "post_edited": post.get("edited", False),
        "post_distinguished": post.get("distinguished") or "",
        "post_is_crosspost": bool(post.get("is_crosspost", False)),
        "post_crosspost_subreddit": post.get("crosspost_subreddit", ""),
        "post_total_awards": post.get("total_awards_received", 0),
        "post_gilded": post.get("gilded", 0),
        "post_title_word_count": word_count(post.get("title")),
        "post_selftext_word_count": word_count(post.get("selftext")),
        "post_comments_complete": "" if comments_complete is None else bool(comments_complete),
    }


def comment_fields(comment):
    date, day, hour = date_parts(comment.get("created_utc"))
    depth = comment.get("depth")
    return {
        "comment_id": comment["id"],
        "comment_body": comment.get("body", ""),
        "comment_author": comment.get("author", "[deleted]"),
        "comment_created_utc": comment.get("created_utc", 0),
        "comment_created_datetime": iso(comment.get("created_utc")),
        "comment_date": date,
        "comment_day_of_week": day,
        "comment_hour_utc": hour,
        "comment_score": comment.get("score", 0),
        "comment_score_as_of": comment.get("score_as_of", ""),
        "comment_parent_id": comment.get("parent_id", ""),
        "comment_is_submitter": bool(comment.get("is_submitter", False)),
        "comment_depth": "" if depth is None else depth,
        "comment_edited": comment.get("edited", False),
        "comment_distinguished": comment.get("distinguished") or "",
        "comment_controversiality": comment.get("controversiality", 0),
        "comment_body_word_count": word_count(comment.get("body")),
    }


EMPTY_COMMENT_FIELDS = {k: "" for k in BASE_COLUMNS if k.startswith("comment_")}


def assign_depths(comments):
    """Depth from the parent_id chain: 0 = top level, None = parent not collected."""
    by_id = {c["id"]: c for c in comments}
    memo = {}

    def depth_of(c, visiting):
        if c["id"] in memo:
            return memo[c["id"]]
        if c["id"] in visiting:
            return None
        visiting.add(c["id"])
        parent_id = c.get("parent_id") or ""
        if not parent_id or parent_id.startswith("t3_"):
            d = 0
        else:
            parent = by_id.get(parent_id[3:])
            if parent is None:
                d = None
            else:
                pd = depth_of(parent, visiting)
                d = None if pd is None else pd + 1
        visiting.discard(c["id"])
        memo[c["id"]] = d
        return d

    for c in comments:
        c["depth"] = depth_of(c, set())
    return comments
