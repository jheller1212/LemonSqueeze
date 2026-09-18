// Receives a run log the researcher chose to send and writes it to the
// function log, where the maintainer can read it (`netlify logs:functions
// report`). Nothing is stored anywhere else; no post content is included.
const MAX_BYTES = 512 * 1024;

const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  const raw = event.body || "";
  if (raw.length > MAX_BYTES) return json(413, { error: `Report too large (${Math.round(raw.length / 1024)} KB, limit ${MAX_BYTES / 1024} KB)` });
  let report;
  try { report = JSON.parse(raw); } catch { return json(400, { error: "Invalid JSON" }); }
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const log = Array.isArray(report.log) ? report.log : [];
  const head = { ...report, log: undefined, log_events: log.length };
  console.log(`[report ${id}] r/${report.subreddit} status=${report.status} events=${log.length} ${JSON.stringify(head)}`);
  // errors and warnings in full, the rest as the last 300 events, 40 per line
  const important = log.filter((e) => e.level === "error" || e.level === "warn");
  const tail = log.slice(-300);
  const lines = [];
  for (let i = 0; i < important.length; i += 40) lines.push(`[report ${id}] problems ${i + 1}-${Math.min(i + 40, important.length)}/${important.length}: ${JSON.stringify(important.slice(i, i + 40))}`);
  for (let i = 0; i < tail.length; i += 40) lines.push(`[report ${id}] tail ${i + 1}-${Math.min(i + 40, tail.length)}/${tail.length}: ${JSON.stringify(tail.slice(i, i + 40))}`);
  for (const l of lines) console.log(l);
  return json(200, { ok: true, id });
}
