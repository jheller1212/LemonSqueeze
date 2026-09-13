"""Reddit's own search endpoint over OAuth (script-app client_credentials flow).

Optional: only used when a study lists ``reddit_search`` and the environment
carries REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET. Each listing is capped by
Reddit at roughly 250 results, so the pipeline runs every query × subreddit ×
sort and deduplicates on post id.
"""
import os
import time

import requests

from ..ratelimit import Pacer, RequestError, get_with_backoff
from .base import Source

TOKEN_URL = "https://www.reddit.com/api/v1/access_token"
API = "https://oauth.reddit.com"
USER_AGENT_DEFAULT = "LemonSqueeze/2.0 (academic research tool)"


class RedditSearch(Source):
    name = "reddit_search"
    supports_sorts = ("relevance", "new", "top", "hot", "comments")

    def __init__(self, study, store):
        super().__init__(study, store)
        self.client_id = os.environ.get("REDDIT_CLIENT_ID")
        self.client_secret = os.environ.get("REDDIT_CLIENT_SECRET")
        self.user_agent = os.environ.get("REDDIT_USER_AGENT", USER_AGENT_DEFAULT)
        self.session = requests.Session()
        self.pacer = Pacer(1.0)
        self._token = None
        self._token_expiry = 0
        self._remaining = None
        self._reset_at = 0

    # --- auth ------------------------------------------------------------------

    def available(self):
        return bool(self.client_id and self.client_secret)

    def _ensure_token(self):
        if not self.available():
            raise RequestError(
                "reddit_search needs REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in the environment "
                "(create a 'script' app at https://www.reddit.com/prefs/apps). Remove reddit_search "
                "from `sources` to run on Arctic Shift alone.")
        if self._token and time.time() < self._token_expiry - 60:
            return
        resp = self.session.post(
            TOKEN_URL, data={"grant_type": "client_credentials"},
            auth=(self.client_id, self.client_secret), headers={"User-Agent": self.user_agent}, timeout=30)
        if resp.status_code != 200:
            raise RequestError("Reddit token request failed: HTTP %s %s" % (resp.status_code, resp.text[:200]))
        body = resp.json()
        if "access_token" not in body:
            raise RequestError("Reddit token response had no access_token: %s" % str(body)[:200])
        self._token = body["access_token"]
        self._token_expiry = time.time() + int(body.get("expires_in", 3600))

    def _headers(self):
        self._ensure_token()
        return {"Authorization": "bearer " + self._token, "User-Agent": self.user_agent}

    def _on_response(self, resp, body=None):
        # Reddit publishes the budget in headers; sleep through the window when nearly spent.
        try:
            self._remaining = float(resp.headers.get("X-Ratelimit-Remaining", "") or self._remaining or 60)
            reset = float(resp.headers.get("X-Ratelimit-Reset", "") or 0)
            self._reset_at = time.time() + reset if reset else self._reset_at
        except ValueError:
            pass
        if self._remaining is not None and self._remaining < 5:
            wait = max(0.0, self._reset_at - time.time()) + 1
            time.sleep(min(wait, 120))

    def _get(self, path, params, log):
        body = get_with_backoff(
            self.session, API + path, params=params, headers=self._headers(),
            pacer=self.pacer, on_response=lambda r, b: (self._on_response(r, b), log(r)))
        return body

    # --- posts -----------------------------------------------------------------

    def search_posts(self, subreddit, query, date_from, date_to, sort):
        site_wide = subreddit.lower() == "all"
        path = "/search" if site_wide else "/r/%s/search" % subreddit
        t = _time_param(date_from)
        after = None
        page = 0
        while True:
            page += 1
            params = {"q": query, "sort": sort, "t": t, "limit": 100, "raw_json": 1, "type": "link"}
            if not site_wide:
                params["restrict_sr"] = 1
            if after:
                params["after"] = after
            status = {}

            def log(resp, _p=page):
                status["code"] = resp.status_code

            body = self._get(path, params, log)
            children = (body.get("data") or {}).get("children") or []
            self.store.log_request(source=self.name, subreddit=subreddit, query=query, sort=sort,
                                   page=page, results=len(children), http_status=status.get("code"))
            for child in children:
                raw = child.get("data") or {}
                created = int(raw.get("created_utc") or 0)
                if date_from and created < date_from:
                    continue
                if date_to and created > date_to:
                    continue
                yield self.normalise_post(raw, self.name)
            after = (body.get("data") or {}).get("after")
            if not after or not children:
                break

    def list_posts(self, subreddit, date_from, date_to):
        """Reddit's /new listing (≈1,000 newest). Stream mode prefers Arctic Shift."""
        after = None
        page = 0
        while True:
            page += 1
            params = {"limit": 100, "raw_json": 1}
            if after:
                params["after"] = after
            status = {}
            body = self._get("/r/%s/new" % subreddit, params, lambda r: status.update(code=r.status_code))
            children = (body.get("data") or {}).get("children") or []
            self.store.log_request(source=self.name, subreddit=subreddit, query="", sort="new",
                                   page=page, results=len(children), http_status=status.get("code"))
            for child in children:
                raw = child.get("data") or {}
                created = int(raw.get("created_utc") or 0)
                if date_to and created > date_to:
                    continue
                if date_from and created < date_from:
                    return
                yield self.normalise_post(raw, self.name)
            after = (body.get("data") or {}).get("after")
            if not after or not children:
                break

    # --- comments --------------------------------------------------------------

    def fetch_comments(self, post_id, num_comments):
        """Full live tree: /comments/{id} then every collapsed `more` node via /api/morechildren."""
        status = {}
        body = self._get("/comments/%s" % post_id, {"limit": 500, "depth": 100, "raw_json": 1, "sort": "old"},
                         lambda r: status.update(code=r.status_code))
        self.store.log_request(source=self.name, subreddit="", query="comments", sort="", page=1,
                               results=None, http_status=status.get("code"), post_id=post_id)
        if not isinstance(body, list) or len(body) < 2:
            return [], False
        comments = []
        more_ids = []
        self._walk_listing((body[1].get("data") or {}).get("children") or [], comments, more_ids)

        link_id = "t3_" + post_id
        page = 1
        while more_ids:
            batch, more_ids = more_ids[:100], more_ids[100:]
            page += 1
            body = self._get("/api/morechildren", {"link_id": link_id, "children": ",".join(batch),
                                                   "api_type": "json", "raw_json": 1, "sort": "old"},
                             lambda r: status.update(code=r.status_code))
            things = (((body.get("json") or {}).get("data") or {}).get("things")) or []
            self.store.log_request(source=self.name, subreddit="", query="morechildren", sort="", page=page,
                                   results=len(things), http_status=status.get("code"), post_id=post_id)
            self._walk_listing(things, comments, more_ids)
        return comments, True

    def _walk_listing(self, children, out, more_ids):
        for child in children:
            kind = child.get("kind")
            data = child.get("data") or {}
            if kind == "more":
                more_ids.extend(data.get("children") or [])
                continue
            if kind != "t1":
                continue
            out.append(self.normalise_comment(data, self.name))
            replies = data.get("replies")
            if isinstance(replies, dict):
                self._walk_listing((replies.get("data") or {}).get("children") or [], out, more_ids)


def _time_param(date_from):
    """Reddit's coarse `t` window that covers date_from; exact bounds are applied client-side."""
    if not date_from:
        return "all"
    age = time.time() - date_from
    for name, seconds in (("day", 86400), ("week", 7 * 86400), ("month", 31 * 86400), ("year", 366 * 86400)):
        if age <= seconds:
            return name
    return "all"
