// Direct browser client for the Arctic Shift archive. The archive allows
// cross-origin requests, so the browser can page posts and comments itself:
// no 26-second function limit, no cold starts, real concurrency.
//
// Measured 2026-09-16: 16 concurrent comment requests at ~17 req/s with no
// load-shedding; a few responses stall, so every request has a timeout and a
// retry. If the archive ever stops answering the browser, `available` flips to
// false and the app falls back to the server path.
const Archive = (() => {
  const BASE = "https://arctic-shift.photon-reddit.com/api";
  const MAX_CONCURRENT = 12;
  const TIMEOUT_MS = 20000;
  const SETTLE_SECONDS = 30 * 86400; // comments still arrive for ~2 weeks; 30 days caught 100% in measurement

  let inflight = 0;
  const waiters = [];
  let available = true;
  let consecutiveNetworkFailures = 0;
  const stats = { requests: 0, retries: 0, shed: 0 };

  const acquire = () => new Promise((resolve) => {
    if (inflight < MAX_CONCURRENT) { inflight++; resolve(); } else waiters.push(resolve);
  });
  const release = () => {
    const next = waiters.shift();
    if (next) next(); else inflight--;
  };
  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); };
    if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
  });

  // `soft` requests (estimates, previews) never count towards declaring the
  // archive unreachable; only the run's own traffic may do that, and even
  // then the verdict expires so a transient blip does not pin the tab to the
  // slower server path for the rest of the session.
  async function get(path, params, { retries = 8, signal, soft = false } = {}) {
    const url = `${BASE}/${path}?${new URLSearchParams(params)}`;
    let delay = 1500;
    let last = "";
    for (let attempt = 0; attempt < retries; attempt++) {
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      await acquire();
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      const onOuter = () => ctl.abort();
      signal?.addEventListener("abort", onOuter, { once: true });
      try {
        stats.requests++;
        const resp = await fetch(url, { signal: ctl.signal, headers: { Accept: "application/json" } });
        let body = null;
        try { body = await resp.json(); } catch { body = null; }
        const shed = body && body.error && /timeout|slow down/i.test(String(body.error));
        if (resp.ok && body && !body.error) { consecutiveNetworkFailures = 0; return body.data || []; }
        if (resp.status === 429 || resp.status >= 500 || shed) {
          stats.retries++; if (shed) stats.shed++;
          last = shed ? "archive busy" : `HTTP ${resp.status}`;
        } else {
          throw new Error(body?.error || `HTTP ${resp.status}`);
        }
      } catch (err) {
        if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        if (err.name === "AbortError") { last = "timeout"; stats.retries++; }
        else if (err instanceof TypeError) { // network / CORS
          last = "network";
          stats.retries++;
          if (!soft && ++consecutiveNetworkFailures >= 4) {
            available = false;
            setTimeout(() => { available = true; consecutiveNetworkFailures = 0; }, 60000);
            throw Object.assign(new Error("archive unreachable from the browser"), { name: "ArchiveUnavailable" });
          }
        } else throw err;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onOuter);
        release();
      }
      if (typeof api.onWait === "function") { try { api.onWait(last, attempt + 1, delay); } catch { /* ignore */ } }
      await sleep(delay, signal);
      delay = Math.min(delay * 2, 30000);
    }
    throw new Error(`Archive gave up after ${retries} attempts (${last})`);
  }

  // Posts newest → oldest in (after, before), exclusive bounds; pages of 100, deduped.
  async function* walkPostsDesc(sub, { after = null, before = null, query = "", signal } = {}) {
    let cursor = before;
    const seen = new Set();
    while (true) {
      const params = { subreddit: sub, limit: 100, sort: "desc" };
      if (cursor != null) params.before = cursor;
      if (after != null) params.after = after;
      if (query) params.query = query;
      const batch = await get("posts/search", params, { signal });
      const fresh = batch.filter((r) => r.id && !seen.has(r.id));
      for (const r of fresh) seen.add(r.id);
      yield { posts: fresh.map(window.Mappers.mapPost), done: batch.length < 100, cursor: batch.length ? batch[batch.length - 1].created_utc + 1 : cursor };
      if (batch.length < 100) return;
      const last = batch[batch.length - 1].created_utc;
      const next = last + 1;
      cursor = next === cursor ? last : next; // a page inside one second cannot be paged; step past it
    }
  }

  // Every comment in the subreddit created in (after, before), exclusive bounds,
  // as pages of mapped comments each carrying `link` (the post id).
  async function* sweepComments(sub, { after, before, signal }) {
    let cursor = after;
    const seen = new Set();
    while (true) {
      const params = { subreddit: sub, limit: 100, sort: "asc", after: cursor };
      if (before != null) params.before = before;
      const batch = await get("comments/search", params, { signal });
      const out = [];
      for (const r of batch) {
        if (!r.id || seen.has(r.id)) continue;
        seen.add(r.id);
        const c = window.Mappers.mapComment(r);
        c.link = String(r.link_id || "").replace(/^t3_/, "");
        out.push(c);
      }
      yield { comments: out, done: batch.length < 100 };
      if (batch.length < 100) return;
      const last = batch[batch.length - 1].created_utc;
      const next = last - 1;
      cursor = next === cursor ? last : next;
    }
  }

  // Sweep a window in K concurrent shards; onPage receives each page's comments.
  async function shardedSweep(sub, { after, before, shards = 4, signal, onPage }) {
    const span = before - after;
    const k = Math.max(1, Math.min(shards, Math.floor(span / 3600) || 1));
    const edges = [];
    for (let i = 0; i <= k; i++) edges.push(i === 0 ? after : i === k ? before : Math.floor(after + (span * i) / k));
    // shard i covers (edges[i], edges[i+1]+1) → [edges[i]+1, edges[i+1]] inclusive; contiguous, no overlap
    await Promise.all(Array.from({ length: k }, async (_, i) => {
      for await (const page of sweepComments(sub, { after: edges[i], before: i === k - 1 ? before : edges[i + 1] + 1, signal })) {
        await onPage(page.comments);
      }
    }));
  }

  // The complete flat tree for one post.
  async function threadComments(postId, { signal } = {}) {
    const comments = [];
    const seen = new Set();
    let cursor = null;
    while (true) {
      const params = { link_id: `t3_${postId}`, limit: 100, sort: "asc" };
      if (cursor != null) params.after = cursor;
      const batch = await get("comments/search", params, { signal });
      for (const r of batch) if (r.id && !seen.has(r.id)) { seen.add(r.id); comments.push(window.Mappers.mapComment(r)); }
      if (batch.length < 100) return { comments, done: true };
      const last = batch[batch.length - 1].created_utc;
      const next = last - 1;
      cursor = next === cursor ? last : next;
    }
  }

  // Run `fn` over items with bounded concurrency. Every item is attempted even
  // if others fail; the first error (if any) is thrown after all have finished,
  // so completed work is never discarded by one straggler. Aborts stop at once.
  async function mapConcurrent(items, limit, fn) {
    const out = new Array(items.length);
    const errors = [];
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const j = i++;
        try { out[j] = await fn(items[j], j); }
        catch (err) { if (err.name === "AbortError" || err.name === "ArchiveUnavailable") throw err; errors.push(err); }
      }
    }));
    if (errors.length) throw errors[0];
    return out;
  }

  const api = {
    get, walkPostsDesc, sweepComments, shardedSweep, threadComments, mapConcurrent,
    SETTLE_SECONDS, stats,
    isAvailable: () => available,
  };
  return api;
})();
