"""The interface every source implements.

Sources yield *normalised* post and comment dicts (see schema.post_fields /
comment_fields for the keys) and log every request through the store so the
methods section can state exactly how the corpus was built.
"""
from ..schema import iso


class Source:
    name = "base"
    supports_sorts = ("new",)

    def __init__(self, study, store):
        self.study = study
        self.store = store

    def search_posts(self, subreddit, query, date_from, date_to, sort):
        """Yield normalised posts matching ``query`` in ``subreddit``."""
        raise NotImplementedError

    def list_posts(self, subreddit, date_from, date_to):
        """Yield every post in the window, newest first (stream mode)."""
        raise NotImplementedError

    def fetch_comments(self, post_id, num_comments):
        """Return (comments, walked_to_end) — the full flat tree and whether the
        source reported no more data (as opposed to stopping on an error)."""
        raise NotImplementedError

    def plan(self, subreddit, query, date_from, date_to, sort):
        """Human-readable request plan for --dry-run."""
        return "%s: r/%s query=%r sort=%s window=%s..%s" % (
            self.name, subreddit, query, sort, iso(date_from) or "beginning", iso(date_to) or "now")

    # --- shared normalisers --------------------------------------------------

    @staticmethod
    def normalise_post(raw, source_name):
        created = int(raw.get("created_utc") or 0)
        permalink = raw.get("permalink") or ""
        if permalink and not permalink.startswith("http"):
            permalink = "https://reddit.com" + permalink
        elif not permalink and raw.get("id") and raw.get("subreddit"):
            permalink = "https://reddit.com/r/%s/comments/%s/" % (raw["subreddit"], raw["id"])
        edited = raw.get("edited")
        meta = raw.get("_meta") or {}
        score_ts = meta.get("retrieved_2nd_on") or raw.get("retrieved_on") or raw.get("retrieved_utc")
        return {
            "id": raw.get("id", ""),
            "subreddit": raw.get("subreddit", ""),
            "title": raw.get("title", "") or "",
            "selftext": raw.get("selftext", "") or "",
            "author": raw.get("author") or "[deleted]",
            "created_utc": created,
            "score": int(raw.get("score") or 0),
            "score_as_of": iso(score_ts) if score_ts else "",
            "upvote_ratio": raw.get("upvote_ratio") or 0,
            "num_comments": int(raw.get("num_comments") or 0),
            "permalink": permalink,
            "url": raw.get("url", "") or "",
            "link_flair_text": raw.get("link_flair_text") or "",
            "over_18": bool(raw.get("over_18", False)),
            "edited": edited if isinstance(edited, (int, float)) and edited else bool(edited),
            "distinguished": raw.get("distinguished"),
            "is_crosspost": bool(raw.get("crosspost_parent")),
            "crosspost_subreddit": ((raw.get("crosspost_parent_list") or [{}])[0] or {}).get("subreddit", ""),
            "total_awards_received": int(raw.get("total_awards_received") or 0),
            "gilded": int(raw.get("gilded") or 0),
            "source": source_name,
        }

    @staticmethod
    def normalise_comment(raw, source_name):
        created = int(raw.get("created_utc") or 0)
        edited = raw.get("edited")
        meta = raw.get("_meta") or {}
        score_ts = meta.get("retrieved_2nd_on") or raw.get("retrieved_on") or raw.get("retrieved_utc")
        return {
            "id": raw.get("id", ""),
            "body": raw.get("body", "") or "",
            "author": raw.get("author") or "[deleted]",
            "created_utc": created,
            "score": int(raw.get("score") or 0),
            "score_as_of": iso(score_ts) if score_ts else "",
            "parent_id": raw.get("parent_id", "") or "",
            "is_submitter": bool(raw.get("is_submitter", False)),
            "depth": None,
            "edited": edited if isinstance(edited, (int, float)) and edited else bool(edited),
            "distinguished": raw.get("distinguished"),
            "controversiality": int(raw.get("controversiality") or 0),
            "source": source_name,
        }
