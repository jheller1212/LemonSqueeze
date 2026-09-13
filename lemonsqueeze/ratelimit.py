"""Polite pacing and retry for HTTP sources."""
import time

import requests


class Pacer:
    """Guarantees at least ``min_interval`` seconds between calls."""

    def __init__(self, min_interval):
        self.min_interval = float(min_interval)
        self._last = 0.0

    def wait(self):
        gap = self.min_interval - (time.monotonic() - self._last)
        if gap > 0:
            time.sleep(gap)
        self._last = time.monotonic()


class RequestError(RuntimeError):
    pass


def get_with_backoff(session, url, params=None, headers=None, pacer=None, retries=5, timeout=40, on_response=None):
    """GET with exponential backoff on 429/5xx/network errors.

    ``on_response(resp)`` is called for every response received so callers can
    log it and read rate-limit headers. Raises RequestError when retries run out.
    """
    delay = 2.0
    last = None
    for attempt in range(retries):
        if pacer:
            pacer.wait()
        try:
            resp = session.get(url, params=params, headers=headers, timeout=timeout)
        except requests.RequestException as exc:
            last = "network: %s" % exc
            time.sleep(delay)
            delay = min(delay * 2, 30.0)
            continue
        try:
            body = resp.json()
        except ValueError:
            body = None
        if on_response:
            on_response(resp, body)
        # Arctic Shift sheds load with HTTP 422 {"error": "Timeout. Maybe slow down a bit"}
        upstream_timeout = isinstance(body, dict) and body.get("error") and "timeout" in str(body["error"]).lower()
        if resp.status_code == 429 or resp.status_code >= 500 or upstream_timeout:
            last = "upstream timeout" if upstream_timeout else "HTTP %s" % resp.status_code
            retry_after = resp.headers.get("Retry-After")
            time.sleep(float(retry_after) if retry_after and retry_after.isdigit() else delay)
            delay = min(delay * 2, 30.0)
            continue
        if resp.status_code >= 400:
            raise RequestError("HTTP %s for %s: %s" % (resp.status_code, resp.url, resp.text[:200]))
        if body is None:
            raise RequestError("Non-JSON response from %s" % resp.url)
        return body
    raise RequestError("Gave up after %d attempts (%s): %s" % (retries, last, url))
