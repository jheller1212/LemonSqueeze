// Per-run event log. Every run carries its own log (`run.log`) in the run
// store, so "it took four hours" or "it failed" can be answered afterwards:
// when each chunk started and finished, how many posts it found, every
// back-off the archive forced, every error with its stack, every export.
// Nothing leaves the browser unless the researcher clicks "Send log".
const RunLog = (() => {
  const MAX_EVENTS = 4000;
  const WAIT_EVENT_EVERY_MS = 30000;
  let current = null;
  const buffer = []; // events before a run is attached (counts, page errors)

  const env = () => ({
    ua: navigator.userAgent,
    cores: navigator.hardwareConcurrency || null,
    memory_gb: navigator.deviceMemory || null,
    online: navigator.onLine,
    page_built: document.lastModified,
  });

  function attach(run) {
    current = run;
    run.log = run.log || [];
    run.logStats = run.logStats || { waits: 0, waitMs: 0, shed: 0, errors: 0 };
    // carry over what happened just before the run existed (count, errors)
    for (const e of buffer.splice(0, buffer.length)) push(e);
  }
  function detach() { current = null; }

  function push(e) {
    if (!current) { buffer.push(e); if (buffer.length > 200) buffer.shift(); return; }
    current.log.push(e);
    if (current.log.length > MAX_EVENTS) {
      const i = current.log.findIndex((x) => x.level === "debug");
      current.log.splice(i >= 0 ? i : 0, 1);
    }
    if (e.level === "error") current.logStats.errors++;
  }

  function event(level, type, data) {
    const e = { t: Date.now(), level, type, ...(data || {}) };
    push(e);
    if (level === "error") console.error("[run]", type, data);
    return e;
  }

  // Archive back-offs are frequent under load: count them all, log one every 30 s.
  function wait(why, attempt, ms) {
    if (!current) return;
    const s = current.logStats;
    s.waits++; s.waitMs += ms;
    if (why === "archive busy") s.shed++;
    if (Date.now() - (s.lastWaitEvent || 0) > WAIT_EVENT_EVERY_MS) {
      s.lastWaitEvent = Date.now();
      event("warn", "archive_wait", { why, attempt, wait_s: Math.round(ms / 1000), waits_so_far: s.waits, waited_total_min: Math.round(s.waitMs / 60000) });
    }
  }

  function errorInfo(err) {
    if (!err) return { error: "unknown" };
    return { error: String(err.message || err).slice(0, 300), name: err.name || undefined, stack: err.stack ? String(err.stack).split("\n").slice(0, 6).join("\n") : undefined };
  }

  function summary(run) {
    const log = run.log || [];
    const s = run.logStats || { waits: 0, waitMs: 0, shed: 0, errors: 0 };
    const chunks = log.filter((e) => e.type === "chunk_done");
    const ms = chunks.map((e) => e.ms || 0);
    const first = log[0]?.t, last = log[log.length - 1]?.t;
    const slowest = chunks.reduce((a, b) => (b.ms > (a?.ms || 0) ? b : a), null);
    return {
      events: log.length,
      errors: s.errors,
      wall_time_min: first && last ? Math.round((last - first) / 60000) : null,
      archive_waits: s.waits,
      archive_shed: s.shed,
      archive_waited_min: Math.round(s.waitMs / 60000),
      chunks_done: chunks.length,
      chunk_avg_min: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length / 6000) / 10 : null,
      slowest_chunk: slowest ? { chunk: slowest.chunk, minutes: Math.round(slowest.ms / 6000) / 10, posts: slowest.posts } : null,
      last_error: [...log].reverse().find((e) => e.level === "error") || null,
    };
  }

  const fmtTime = (t) => new Date(t).toISOString().replace("T", " ").slice(0, 19);
  function line(e) {
    const { t, level, type, ...rest } = e;
    const kv = Object.entries(rest).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v).replace(/\n/g, " ⏎ ")}`).join(" ");
    return `${fmtTime(t)}  ${level.toUpperCase().padEnd(5)} ${type.padEnd(14)} ${kv}`;
  }
  function text(run, limit = Infinity) {
    const log = run.log || [];
    const slice = limit < log.length ? log.slice(log.length - limit) : log;
    return (limit < log.length ? `… ${log.length - limit} earlier events omitted\n` : "") + slice.map(line).join("\n");
  }

  // Everything needed to diagnose a run, without any post content.
  function report(run) {
    return {
      tool: "LemonSqueeze web app",
      run_id: run.id,
      subreddit: run.subreddit,
      status: run.status,
      settings: run.settings,
      plan: { ...run.plan, queue: run.plan?.queue?.map((q) => q.label) },
      batch: run.batch || null,
      chunks: run.chunks?.map((c) => ({ i: c.i, status: c.status, posts: c.posts, error: c.error || undefined })),
      counts: run.counts,
      created_at: run.createdAt ? new Date(run.createdAt).toISOString() : null,
      finished_at: run.finishedAt ? new Date(run.finishedAt).toISOString() : null,
      environment: env(),
      summary: summary(run),
      log: run.log || [],
    };
  }

  // Page-level failures land in the current run's log, or wait for the next one.
  window.addEventListener("error", (e) => {
    event("error", "page_error", { error: String(e.message || "").slice(0, 300), where: e.filename ? `${e.filename.split("/").pop()}:${e.lineno}` : undefined });
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    if (r && r.name === "AbortError") return;
    event("error", "unhandled", errorInfo(r));
  });

  return { attach, detach, event, wait, errorInfo, summary, text, report, env, current: () => current };
})();
