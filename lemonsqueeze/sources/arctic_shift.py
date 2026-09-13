"""Arctic Shift: the full Reddit archive, no credentials.

Quirks learned the hard way (see README "Data completeness"):
- pages are capped at 100 and `after`/`before` are exclusive, so cursors step
  back one second and rows are deduplicated by id;
- full-text `query` needs a subreddit, accepts quoted phrases, has no OR —
  OR queries are split into one call per alternative;
- under load it answers 200 + {"error": "Timeout..."} and blocks Python's
  default User-Agent; both are handled in ratelimit.get_with_backoff.
"""
import re

import requests

from ..ratelimit import Pacer, get_with_backoff
from ..schema import iso
from .base import Source

API = "https://arctic-shift.photon-reddit.com/api"
USER_AGENT = "LemonSqueeze/2.0 (academic research tool)"
OR_SPLIT = re.compile(r"\s+OR\s+", re.IGNORECASE)


class ArcticShift(Source):
    name = "arctic_shift"
    supports_sorts = ("new",)

    def __init__(self, study, store):
        super().__init__(study, store)
        self.session = requests.Session()
        self.pacer = Pacer(1.0)

    def _get(self, path, params, **log_fields):
        attempts = []

        def on_response(resp, body):
            attempts.append(resp.status_code)
            err = body.get("error") if isinstance(body, dict) else None
            if err or resp.status_code >= 400:
                self.store.log_request(source=self.name, http_status=resp.status_code, results=None,
                                       attempt=len(attempts), error=str(err or "")[:120], **log_fields)

        body = get_with_backoff(self.session, API + path, params=params, headers={"User-Agent": USER_AGENT},
                                pacer=self.pacer, retries=8, on_response=on_response)
        data = (body.get("data") if isinstance(body, dict) else None) or []
        self.store.log_request(source=self.name, http_status=attempts[-1] if attempts else None, results=len(data),
                               attempt=len(attempts), **log_fields)
        return data

    @staticmethod
    def split_query(query):
        """Arctic has no OR: 'a OR b' -> ['a', 'b']; quoted phrases pass through."""
        parts = [p.strip() for p in OR_SPLIT.split(query) if p.strip()]
        return parts or [query]

    # --- posts -----------------------------------------------------------------

    def search_posts(self, subreddit, query, date_from, date_to, sort):
        for term in self.split_query(query):
            for post in self._walk_forward(subreddit, term, date_from, date_to, query):
                yield post

    def _walk_forward(self, subreddit, term, date_from, date_to, query_label):
        """Oldest → newest over the window; the cursor re-covers the boundary second."""
        after = (date_from - 1) if date_from else None
        seen = set()
        page = 0
        while True:
            page += 1
            params = {"subreddit": subreddit, "query": term, "limit": 100, "sort": "asc"}
            if after is not None:
                params["after"] = after
            if date_to:
                params["before"] = date_to + 1
            batch = self._get("/posts/search", params, subreddit=subreddit, query=query_label, sort="new", page=page, term=term)
            for raw in batch:
                if raw.get("id") in seen:
                    continue
                seen.add(raw.get("id"))
                yield self.normalise_post(raw, self.name)
            if len(batch) < 100:
                return
            last = int(batch[-1].get("created_utc") or 0)
            nxt = last - 1
            # a page that sits entirely in one second cannot be paged through; step past it
            after = last if nxt == after else nxt

    def list_posts(self, subreddit, date_from, date_to):
        """Newest → oldest (stream mode)."""
        before = (date_to + 1) if date_to else None
        seen = set()
        page = 0
        while True:
            page += 1
            params = {"subreddit": subreddit, "limit": 100, "sort": "desc"}
            if before is not None:
                params["before"] = before
            if date_from:
                params["after"] = date_from - 1
            batch = self._get("/posts/search", params, subreddit=subreddit, query="", sort="new", page=page)
            for raw in batch:
                if raw.get("id") in seen:
                    continue
                seen.add(raw.get("id"))
                yield self.normalise_post(raw, self.name)
            if len(batch) < 100:
                return
            last = int(batch[-1].get("created_utc") or 0)
            nxt = last + 1
            before = last if nxt == before else nxt

    def earliest_post(self, subreddit):
        """Epoch of the subreddit's first archived post, or None."""
        data = self._get("/subreddits/search", {"subreddit": subreddit, "limit": 1}, subreddit=subreddit, query="subreddit_meta", sort="", page=1)
        meta = (data[0].get("_meta") or {}) if data else {}
        return meta.get("earliest_post") or None

    # --- comments --------------------------------------------------------------

    def fetch_comments(self, post_id, num_comments):
        link_id = post_id if post_id.startswith("t3_") else "t3_" + post_id
        comments = []
        seen = set()
        after = None
        page = 0
        while True:
            page += 1
            params = {"link_id": link_id, "limit": 100, "sort": "asc"}
            if after is not None:
                params["after"] = after
            batch = self._get("/comments/search", params, subreddit="", query="comments", sort="asc", page=page, post_id=post_id)
            for raw in batch:
                if raw.get("id") in seen:
                    continue
                seen.add(raw.get("id"))
                comments.append(self.normalise_comment(raw, self.name))
            if len(batch) < 100:
                return comments, True
            last = int(batch[-1].get("created_utc") or 0)
            nxt = last - 1
            after = last if nxt == after else nxt

    def plan(self, subreddit, query, date_from, date_to, sort):
        terms = self.split_query(query)
        return "%s: r/%s %s window=%s..%s (walk forward, 100/page, 1 req/s)" % (
            self.name, subreddit,
            " + ".join("query=%r" % t for t in terms) + (" [OR split]" if len(terms) > 1 else ""),
            iso(date_from) or "beginning", iso(date_to) or "now")
