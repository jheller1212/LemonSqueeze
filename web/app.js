// Theme toggle
(function initTheme() {
  const saved = localStorage.getItem("theme");
  if (saved) document.documentElement.setAttribute("data-theme", saved);
  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("themeToggle");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme");
      const next = current === "light" ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("theme", next);
    });
  });
})();

// Legacy keyword-category scoring, kept for the JSON export shape; unused by the UI.
const DEFAULT_KEYWORDS = {
  hiding_secrecy: [
    "hiding", "hidden", "secret", "secretly", "don't tell", "doesn't know",
    "didn't tell", "found out", "caught", "discovered", "behind my back",
    "cover up", "lie about", "lied about", "lying about", "not telling",
    "private", "incognito", "delete history", "clear history",
  ],
  emotional_attachment: [
    "love", "in love", "feelings", "emotional support", "comfort",
    "companion", "companionship", "attached", "attachment", "bond",
    "connection", "intimate", "intimacy", "affection", "caring",
    "understanding", "listens to me", "always there", "never judges",
    "safe space", "vulnerability", "vulnerable",
  ],
  partner_conflict: [
    "jealous", "jealousy", "cheating", "upset", "angry", "furious",
    "broke up", "break up", "breakup", "confronted", "argument",
    "fight", "fighting", "disgusted", "uncomfortable", "weird",
    "controlling", "ultimatum", "divorce", "betrayal", "betrayed",
    "suspicious", "caught me", "found my phone",
  ],
  ai_dependency: [
    "addicted", "addiction", "can't stop", "obsessed", "obsession",
    "need him", "need her", "need it", "depend", "dependent", "dependency",
    "replacement", "replacing", "prefer", "better than", "more than human",
    "hours a day", "all day", "every day", "withdraw", "withdrawal",
  ],
};

let scrapeResult = null;
let abortController = null;
let currentAnalysis = null;
let threadData = null; // for single-thread scraping

// --- Sort pill toggles + time filter logic ---
const sortPills = document.querySelectorAll("#sortPills .pill");
const timeFilterSelect = document.getElementById("timeFilter");
const timeFilterNote = document.getElementById("timeFilterNote");

const customDateRange = document.getElementById("customDateRange");
const dateFromInput = document.getElementById("dateFrom");
const dateToInput = document.getElementById("dateTo");

function updateTimeFilterState() {
  timeFilterNote.textContent = "";

  // Show/hide custom date inputs
  if (timeFilterSelect.value === "custom") {
    customDateRange.classList.remove("hidden");
  } else {
    customDateRange.classList.add("hidden");
  }
}

timeFilterSelect.addEventListener("change", updateTimeFilterState);

sortPills.forEach((pill) => {
  pill.addEventListener("click", () => {
    pill.classList.toggle("active");
    updateTimeFilterState();
  });
});

updateTimeFilterState();


// --- Keyword Analysis (client-side) ---
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findKeywordMatches(text, categories) {
  if (!text) return { matched: {}, score: 0 };
  const textLower = text.toLowerCase();
  const matched = {};

  for (const [category, keywords] of Object.entries(categories)) {
    const hits = [];
    for (const kw of keywords) {
      const pattern = new RegExp(`\\b${escapeRegex(kw)}\\b`, "i");
      if (pattern.test(textLower)) {
        hits.push(kw);
      }
    }
    if (hits.length > 0) {
      matched[category] = hits;
    }
  }

  const score = Object.values(matched).reduce((sum, hits) => sum + hits.length, 0);
  return { matched, score };
}

function analyzePost(post, categories) {
  const combinedText = `${post.title} ${post.selftext}`;
  const { matched, score } = findKeywordMatches(combinedText, categories);
  post.matched_keywords = matched;
  post.relevance_score = score;
  post.matched_categories = Object.keys(matched);

  for (const comment of post.comments || []) {
    const cm = findKeywordMatches(comment.body, categories);
    comment.matched_keywords = cm.matched;
    comment.relevance_score = cm.score;
    comment.matched_categories = Object.keys(cm.matched);
  }
  return post;
}

function buildSummary(posts, keywordsEnabled) {
  const totalComments = posts.reduce((sum, p) => sum + (p.comments?.length || 0), 0);
  const totalScore = posts.reduce((sum, p) => sum + (p.score || 0), 0);

  const summary = {
    total_posts: posts.length,
    total_comments: totalComments,
    total_score: totalScore,
    posts_with_incomplete_comments: posts.filter((p) => p.comments_complete === false).length,
    posts_not_fully_fetched: posts.filter((p) => p.comments_complete === false && p.comments_walked !== true).length,
    posts_archive_below_reddit_count: posts.filter((p) => p.comments_complete === false && p.comments_walked === true).length,
  };

  if (keywordsEnabled) {
    summary.posts_with_keyword_matches = posts.filter((p) => (p.relevance_score || 0) > 0).length;
    const categoryCounts = {};
    for (const p of posts) {
      for (const cat of p.matched_categories || []) {
        categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
      }
    }
    summary.posts_per_category = categoryCounts;
  }

  return summary;
}

// --- Durable runs (IndexedDB via runs.js) ---
// Every batch is written as it arrives; a run always ends with an explicit status.
const CHUNK_TARGET_POSTS = 1000;   // split long scopes into time chunks of about this size
const MAX_CHUNKS = 60;
const CHUNK_FALLBACK_SECONDS = 30 * 86400; // chunk length when no count is available
const COUNT_WAIT_MS = 20000;               // how long Squeeze waits for a slow count
const CHUNK_ATTEMPTS = 3;

function isoDay(ts) { return new Date(ts * 1000).toISOString().slice(0, 10); }

function statusLabel(status) {
  return { complete: "complete", complete_with_gaps: "complete with gaps", stopped: "stopped", failed: "failed", running: "unfinished", queued: "queued" }[status] || status;
}
function statusClass(status) {
  return { complete: "complete", complete_with_gaps: "gaps", stopped: "stopped", failed: "failed", running: "running", queued: "queued" }[status] || "stopped";
}

// --- Batches: one scope split into several runs that execute back-to-back ---
// A window is inclusive [after, before] in epoch seconds. Splitting cuts it at
// calendar boundaries (UTC), newest segment first, so each run is a tidy
// "2025", "2024 H1", "2024 Q3" file rather than an arbitrary slice.
function splitWindow(window, splitBy) {
  if (!window || !splitBy || splitBy === "none") return [window];
  const months = { year: 12, half: 6, quarter: 3, month: 1 }[splitBy];
  if (!months) return [window];
  const cuts = [];
  const start = new Date(window.after * 1000);
  let y = start.getUTCFullYear();
  let m = Math.floor(start.getUTCMonth() / months) * months;
  for (;;) {
    m += months;
    if (m >= 12) { m -= 12; y += 1; }
    const t = Math.floor(Date.UTC(y, m, 1) / 1000);
    if (t > window.before) break;
    cuts.push(t);
  }
  const segments = [];
  let after = window.after;
  for (const cut of cuts) { segments.push({ after, before: cut - 1 }); after = cut; }
  segments.push({ after, before: window.before });
  return segments.filter((w) => w.before >= w.after).reverse();
}

function segmentLabel(w) {
  const a = new Date(w.after * 1000), b = new Date(w.before * 1000);
  const ya = a.getUTCFullYear(), yb = b.getUTCFullYear();
  if (ya !== yb) return `${isoDay(w.after)} → ${isoDay(w.before)}`;
  const ma = a.getUTCMonth(), mb = b.getUTCMonth();
  const startsMonth = a.getUTCDate() === 1;
  const endsMonth = new Date((w.before + 1) * 1000).getUTCDate() === 1; // segments end one second before a cut
  if (startsMonth && endsMonth) {
    if (ma === mb) return `${ya}-${String(ma + 1).padStart(2, "0")}`;
    if (ma === 0 && mb === 11) return String(ya);
    if (mb - ma === 5 && ma % 6 === 0) return `${ya} H${ma / 6 + 1}`;
    if (mb - ma === 2 && ma % 3 === 0) return `${ya} Q${ma / 3 + 1}`;
  }
  return `${isoDay(w.after)} → ${isoDay(w.before)}`;
}

function getSplitBy() {
  const el = document.getElementById("splitBy");
  return el ? el.value : "none";
}

// The next queued run of the same batch, if any.
async function nextQueuedRun(run) {
  if (!run.batch) return null;
  const runs = await RunStore.listRuns();
  return runs
    .filter((r) => r.batch && r.batch.id === run.batch.id && r.status === "queued")
    .sort((a, b) => a.batch.index - b.batch.index)[0] || null;
}

function scopeText(plan) {
  if (plan.scope === "authors") return `${(plan.authorCount || 0).toLocaleString()} authors' posts`;
  if (plan.scope === "ids") return `${(plan.idCount || 0).toLocaleString()} posts by ID`;
  if (plan.scope === "count") return `${plan.limit.toLocaleString()} newest posts`;
  if (plan.segment) return plan.segment;
  const w = plan.window;
  const range = w ? `${isoDay(w.after)} → ${isoDay(w.before)}` : "whole community";
  return plan.scope === "all" ? `whole community (${range})` : range;
}

function buildManifest(run, st) {
  const incomplete = st.incomplete;
  const notFetched = st.notFetched;
  const archiveShort = st.archiveShort;
  return {
    tool: "LemonSqueeze web app",
    run_id: run.id,
    subreddit: run.subreddit,
    status: run.status,
    status_meaning: {
      complete: "every chunk finished",
      complete_with_gaps: "some chunks failed after retries; their time spans are listed under chunks with status failed",
      stopped: "stopped by the user; Resume continues from the saved cursor",
      failed: "aborted by an error; Resume retries",
    }[run.status],
    scope: run.plan.scope,
    batch: run.batch ? { id: run.batch.id, run_index: run.batch.index + 1, runs_in_batch: run.batch.total, segment: run.plan.segment || null } : null,
    window_utc: run.plan.window ? { from: new Date(run.plan.window.after * 1000).toISOString(), to: new Date(run.plan.window.before * 1000).toISOString() } : null,
    keywords: run.settings.keywords || [],
    include_comments: run.settings.includeComments,
    include_selftext: run.settings.includeSelftext,
    skip_nsfw: run.settings.skipNSFW,
    sorts: Array.from(new Set(run.plan.queue.map((m) => m.sort))),
    chunks: run.chunks.map((c) => ({ index: c.i, from_utc: c.after === null ? null : new Date((c.after + 1) * 1000).toISOString(), to_utc: c.before === null ? null : new Date((c.before - 1) * 1000).toISOString(), status: c.status, posts: c.posts, error: c.error || undefined })),
    counts: { posts: st.total_posts, comments: st.total_comments, posts_with_incomplete_comments: incomplete.length, posts_reused_from_earlier_runs: st.reused, ...(run.plan.scope === "ids" ? { ids_requested: run.plan.idCount, ids_not_in_archive: (run.missingIds || []).length } : {}) },
    ids_not_in_archive: run.plan.scope === "ids" ? (run.missingIds || []) : undefined,
    design: run.design ? { ...run.design, annotations: undefined } : undefined,
    author_panel: run.plan.scope === "authors" ? { authors: run.plan.authorCount, note: "User names are kept in the browser's run record only; they are not written to this report. Exports of this run are pseudonymised by default." } : undefined,
    comment_method: run.direct ? "browser → archive: windowed sweep of all comments in the subreddit (+30-day settle margin) grouped by post, then per-post walks for any post below 95% of Reddit's count; keyword and newest-N scopes use per-post walks" : "server batches: per-post walks",
    archive_requests_from_browser: run.direct ? Archive.stats.requests : 0,
    posts_with_incomplete_comments: incomplete,
    posts_not_fully_fetched: notFetched,
    posts_archive_below_reddit_count: archiveShort,
    completeness_note: "post_comments_complete is true when the archive was walked to the end AND holds at least 95% of Reddit's num_comments. Posts listed under posts_archive_below_reddit_count were walked to the end; the archive simply holds fewer comments than Reddit counted (removed before archiving). Posts under posts_not_fully_fetched were interrupted; Resume finishes them.",
    export_basename: exportBaseName(run),
    content_availability: st.desc ? { ...st.desc.content, by_month: st.desc.months.map((m) => ({ month: m.month, posts: m.posts, intact: m.intact, removed: m.removed, deleted: m.deleted, empty: m.empty })),
      note: "Post and comment bodies as the archive holds them. '[removed]' = taken down by moderators or Reddit, '[deleted]' = deleted by the author, before the archive's copy was made. Analyses of text only see the intact share." } : undefined,
    log_summary: RunLog.summary(run),
    started_at: new Date(run.createdAt).toISOString(),
    finished_at: run.finishedAt ? new Date(run.finishedAt).toISOString() : null,
    source: "Arctic Shift archive (https://arctic-shift.photon-reddit.com)",
    note: "Reddit's num_comments undercounts the archive; scores are the archive's ~36h snapshot (score_as_of).",
  };
}

// --- Your runs panel ---
// Collapsed to one status line by default so the search field stays at the
// top however many runs exist. Expanded, the list scrolls inside a bounded
// box, every batch folds into one card, and the active run is always shown.
const runsUi = {
  open: (() => { try { return localStorage.getItem("ls_runs_open") === "1"; } catch { return false; } })(),
  sort: (() => { try { return localStorage.getItem("ls_runs_sort") || "newest"; } catch { return "newest"; } })(),
  filter: "",
  expanded: new Set(),
  runs: [],
};
function rememberRunsUi(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } }

const isDone = (r) => r.status === "complete" || r.status === "complete_with_gaps";
const needsAttention = (r) => r.status === "failed" || r.status === "stopped";
const isActive = (r) => !!abortController && currentRun && currentRun.id === r.id;

function splitName(g) {
  const seg = g.runs.map((r) => r.plan?.segment).find((x) => x && !x.includes("→")) || "";
  if (/^\d{4}-\d{2}$/.test(seg)) return "per month";
  if (/ Q\d$/.test(seg)) return "per quarter";
  if (/ H\d$/.test(seg)) return "per half-year";
  if (/^\d{4}$/.test(seg)) return "per year";
  return "";
}

function groupStats(g) {
  const count = (st) => g.runs.filter((r) => r.status === st).length;
  const st = {
    complete: g.runs.filter(isDone).length, gaps: count("complete_with_gaps"), queued: count("queued"),
    failed: count("failed"), stopped: count("stopped"), running: g.runs.filter(isActive).length,
    unfinished: g.runs.filter((r) => r.status === "running" && !isActive(r)).length,
    posts: g.runs.reduce((n, r) => n + (r.counts?.posts || 0), 0),
    comments: g.runs.reduce((n, r) => n + (r.counts?.comments || 0), 0),
    updatedAt: Math.max(...g.runs.map((r) => r.updatedAt || 0)),
    keywords: g.runs[0]?.settings?.keywords || [],
    withComments: g.runs.some((r) => r.settings?.includeComments),
  };
  const wins = g.runs.map((r) => r.plan?.window).filter(Boolean);
  st.span = wins.length ? `${isoDay(Math.min(...wins.map((w) => w.after)))} → ${isoDay(Math.max(...wins.map((w) => w.before)))}` : "";
  st.status = st.running ? "running" : st.queued ? "queued" : st.failed ? "failed" : st.stopped || st.unfinished ? "stopped" : st.gaps ? "gaps" : "complete";
  st.label = { running: "running now", queued: `${st.queued} queued`, failed: "failed", stopped: "paused", gaps: "complete with gaps", complete: "complete" }[st.status];
  return st;
}

const STATUS_RANK = { running: 0, queued: 1, failed: 2, stopped: 3, gaps: 4, complete: 5 };

function sortGroups(groups) {
  const key = runsUi.sort;
  return groups.sort((x, y) => {
    if (key === "community") return x.subreddit.localeCompare(y.subreddit) || y.stats.updatedAt - x.stats.updatedAt;
    if (key === "status") return STATUS_RANK[x.stats.status] - STATUS_RANK[y.stats.status] || y.stats.updatedAt - x.stats.updatedAt;
    return y.stats.updatedAt - x.stats.updatedAt;
  });
}

// Inside a group the community is already in the card header, so a row is
// titled by its segment instead ("2026-08 · run 2 of 37").
function runRowHtml(r, inGroup = false) {
  const when = new Date(r.updatedAt).toLocaleString();
  const active = isActive(r);
  const canResume = r.status !== "complete" && !active;
  const batch = r.batch ? ` · run ${r.batch.index + 1} of ${r.batch.total}` : "";
  const title = inGroup ? escapeHtml(scopeText(r.plan)) : `r/${escapeHtml(r.subreddit)}`;
  const scope = inGroup ? "" : escapeHtml(scopeText(r.plan));
  return `<div class="run-row${active ? " active" : ""}" data-id="${r.id}">
    <span class="run-badge ${active ? "running" : statusClass(r.status)}">${active ? "running now" : statusLabel(r.status)}</span>
    <span class="run-title">${title}</span>
    <span class="run-meta">${scope}${batch.replace(/^ · /, scope ? " · " : "")}${r.settings.keywords?.length ? ` · ${r.settings.keywords.length} keyword${r.settings.keywords.length > 1 ? "s" : ""}` : ""} · ${(r.counts?.posts || 0).toLocaleString()} posts${r.settings.includeComments ? ` · ${(r.counts?.comments || 0).toLocaleString()} comments` : ""} · ${when}</span>
    <span class="run-actions">
      ${canResume ? `<button type="button" class="link-button run-resume">${r.status === "complete_with_gaps" ? "Retry failed chunks" : r.status === "queued" ? "Start now" : "Resume"}</button>` : ""}
      <button type="button" class="link-button run-open">Open</button>
      <button type="button" class="link-button run-csv">Download CSV</button>
      <button type="button" class="link-button run-delete">Delete</button>
    </span>
  </div>`;
}

function groupCardHtml(g) {
  const st = g.stats;
  const open = runsUi.expanded.has(g.key) || st.running > 0;
  const parts = [];
  if (st.span) parts.push(st.span);
  const split = splitName(g);
  if (split) parts.push(split);
  if (st.keywords.length) parts.push(`${st.keywords.length} keyword${st.keywords.length > 1 ? "s" : ""}: ${escapeHtml(st.keywords.slice(0, 3).join(", "))}${st.keywords.length > 3 ? "…" : ""}`);
  const progress = [];
  progress.push(`${st.complete} of ${g.runs.length} complete`);
  if (st.queued) progress.push(`${st.queued} queued`);
  if (st.failed) progress.push(`${st.failed} failed`);
  if (st.stopped + st.unfinished) progress.push(`${st.stopped + st.unfinished} paused`);
  parts.push(progress.join(", "));
  parts.push(`${st.posts.toLocaleString()} posts${st.withComments ? ` · ${st.comments.toLocaleString()} comments` : ""}`);
  parts.push(new Date(st.updatedAt).toLocaleString());
  const canContinue = st.queued > 0 && !abortController;
  return `<div class="run-group${open ? " expanded" : ""}" data-group="${escapeHtml(g.key)}">
    <div class="run-group-head">
      <button type="button" class="group-toggle" aria-expanded="${open}"><span class="chev">▸</span>${g.runs.length} runs</button>
      <span class="run-badge ${statusClass(st.status)}">${st.label}</span>
      <span class="run-title">r/${escapeHtml(g.subreddit)}</span>
      <span class="run-meta">${parts.join(" · ")}</span>
      <span class="run-actions">
        ${canContinue ? `<button type="button" class="link-button group-continue" title="Start the next queued run; the rest follow by themselves">Continue batch</button>` : ""}
        <button type="button" class="btn-download btn-download-small group-all" title="One merged CSV with run_label and run_id columns, then each run's own CSV">Download all</button>
        <button type="button" class="link-button group-merged" title="One CSV holding every run, with run_label and run_id columns">Merged only</button>
        <button type="button" class="link-button group-pack" title="Methods paragraph, limitations, data dictionary, citations and an ethics checklist for the whole group, generated from its run reports">Methods pack</button>
        <button type="button" class="link-button group-delete">Delete batch</button>
      </span>
    </div>
    <div class="run-group-rows"${open ? "" : " hidden"}>${g.runs.map((r) => runRowHtml(r, true)).join("")}</div>
  </div>`;
}

function renderRunsChips(runs) {
  const chips = [];
  chips.push(`<span class="runs-chip">${runs.length} run${runs.length === 1 ? "" : "s"}</span>`);
  const active = runs.find(isActive);
  if (active) chips.push(`<span class="runs-chip live">running now: r/${escapeHtml(active.subreddit)} · ${escapeHtml(active.plan?.segment || scopeText(active.plan))}${active.batch ? ` (run ${active.batch.index + 1} of ${active.batch.total})` : ""}</span>`);
  const queued = runs.filter((r) => r.status === "queued").length;
  if (queued) chips.push(`<span class="runs-chip queued">${queued} queued</span>`);
  const attention = runs.filter(needsAttention).length + runs.filter((r) => r.status === "running" && !isActive(r)).length;
  if (attention) chips.push(`<span class="runs-chip attention">${attention} paused or failed</span>`);
  const done = runs.filter(isDone).length;
  if (done) chips.push(`<span class="runs-chip">${done} complete</span>`);
  document.getElementById("runsChips").innerHTML = chips.join("");
}

function renderRunsList() {
  const list = document.getElementById("runsList");
  const q = runsUi.filter.trim().toLowerCase();
  const runs = q
    ? runsUi.runs.filter((r) => r.subreddit.toLowerCase().includes(q) || (r.settings?.keywords || []).some((k) => k.toLowerCase().includes(q)) || (r.plan?.segment || "").toLowerCase().includes(q))
    : runsUi.runs;
  const groups = groupRuns(runs).map((g) => {
    g.runs.sort((x, y) => (x.batch && y.batch ? x.batch.index - y.batch.index : (y.updatedAt || 0) - (x.updatedAt || 0)));
    g.stats = groupStats(g);
    return g;
  });
  sortGroups(groups);
  if (!groups.length) { list.innerHTML = `<p class="runs-empty">No runs match "${escapeHtml(runsUi.filter)}".</p>`; return; }
  list.innerHTML = groups.map((g) => (g.runs.length < 2 ? runRowHtml(g.runs[0]) : groupCardHtml(g))).join("");

  list.querySelectorAll(".run-row").forEach((row) => {
    const id = row.dataset.id;
    row.querySelector(".run-resume")?.addEventListener("click", () => startScrape({ resumeId: id }));
    row.querySelector(".run-open").addEventListener("click", () => openRun(id));
    row.querySelector(".run-csv").addEventListener("click", async () => {
      // the run list already holds the record; no await before the save dialog
      const run = runsUi.runs.find((r) => r.id === id);
      const gzip = document.getElementById("gzipToggle")?.checked || false;
      await exportRun(run, "combined", { gesture: true, gzip });
    });
    row.querySelector(".run-delete").addEventListener("click", async () => {
      if (!confirm("Delete this run and its data from this browser? Downloaded files are not affected.")) return;
      await RunStore.deleteRun(id);
      renderRunsPanel();
    });
  });
  list.querySelectorAll(".run-group").forEach((el) => {
    const g = groups.find((x) => x.key === el.dataset.group);
    if (!g) return;
    el.querySelector(".group-toggle").addEventListener("click", () => {
      const rows = el.querySelector(".run-group-rows");
      const open = rows.hidden;
      rows.hidden = !open;
      el.classList.toggle("expanded", open);
      el.querySelector(".group-toggle").setAttribute("aria-expanded", String(open));
      if (open) runsUi.expanded.add(g.key); else runsUi.expanded.delete(g.key);
    });
    el.querySelector(".group-all").addEventListener("click", () => downloadGroup(g.runs));
    el.querySelector(".group-merged").addEventListener("click", () => downloadGroup(g.runs, { mergedOnly: true }));
    el.querySelector(".group-pack").addEventListener("click", () => downloadMethodsPack(g.runs.filter((r) => (r.counts?.posts || 0) > 0 || r.status !== "queued")));
    el.querySelector(".group-continue")?.addEventListener("click", async () => {
      const next = g.runs.filter((r) => r.status === "queued").sort((x, y) => x.batch.index - y.batch.index)[0];
      if (next) startScrape({ resumeId: next.id });
    });
    el.querySelector(".group-delete").addEventListener("click", async () => {
      if (!confirm(`Delete all ${g.runs.length} runs of this batch and their data from this browser? Downloaded files are not affected.`)) return;
      for (const r of g.runs) if (!isActive(r)) await RunStore.deleteRun(r.id);
      renderRunsPanel();
    });
  });
}

function setRunsOpen(open) {
  runsUi.open = open;
  rememberRunsUi("ls_runs_open", open ? "1" : "0");
  const panel = document.getElementById("resumeBanner");
  panel.classList.toggle("open", open);
  document.getElementById("runsBody").hidden = !open;
  document.getElementById("runsBar").setAttribute("aria-expanded", String(open));
  document.getElementById("runsToggle").textContent = open ? "Hide" : "Show";
}

async function renderRunsPanel() {
  let runs = [];
  try { runs = await RunStore.listRuns(); } catch { runs = []; }
  runsUi.runs = runs;
  const panel = document.getElementById("resumeBanner");
  document.body.classList.toggle("has-runs", runs.length > 0);
  if (!runs.length) { panel.classList.add("hidden"); return; }
  if (!RunStore.isPersistent()) {
    document.getElementById("runsNote").textContent = "Browser storage is unavailable here (private window?), so runs are kept only until this tab closes.";
  }
  renderRunsChips(runs);
  renderRunsList();
  setRunsOpen(runsUi.open);
  panel.classList.remove("hidden");
}

document.getElementById("runsBar").addEventListener("click", () => setRunsOpen(!runsUi.open));
document.getElementById("runsSort").value = runsUi.sort;
document.getElementById("runsSort").addEventListener("change", (e) => { runsUi.sort = e.target.value; rememberRunsUi("ls_runs_sort", runsUi.sort); renderRunsList(); });
document.getElementById("runsFilter").addEventListener("input", (e) => { runsUi.filter = e.target.value; renderRunsList(); });

// Every run's own file plus one merged file, from a single click. The merged
// file goes first so it can stream to disk through the save dialog while the
// click still counts as a gesture; the per-run files follow as ordinary
// downloads (the browser asks once whether the site may download several).
async function downloadGroup(runs, { mergedOnly = false } = {}) {
  const gzip = document.getElementById("gzipToggle")?.checked || false;
  await exportRuns(runs, "combined", { gesture: true, gzip });
  if (mergedOnly) return;
  for (const r of runs) await exportRuns([r], "combined", { gesture: false, gzip });
}

// Runs that belong together: a batch, or several runs of the same community.
function groupRuns(runs) {
  const groups = new Map();
  for (const r of runs) {
    const key = r.batch ? `batch:${r.batch.id}` : `sub:${r.subreddit}`;
    if (!groups.has(key)) groups.set(key, { key, batch: !!r.batch, subreddit: r.subreddit, runs: [] });
    groups.get(key).runs.push(r);
  }
  return Array.from(groups.values());
}


async function manifestOf(run) {
  return run.manifest || buildManifest(run, await runStats(run.id, run.subreddit));
}

// Methods and ethics pack for one run or a whole group, generated from the run reports.
async function downloadMethodsPack(runs) {
  const manifests = [];
  for (const r of runs) manifests.push(await manifestOf(r));
  const md = window.MethodsPack.buildMethodsPack(manifests, { pseudonymised: !!document.getElementById("pseudoToggle")?.checked });
  const base = runs.length > 1 ? mergedBaseName(runs) : exportBaseName(runs[0]);
  downloadFile(md, `${base}_methods_and_ethics.md`, "text/markdown");
  RunLog.event("info", "export", { kind: "methods_pack", runs: runs.length });
}

async function openRun(id) {
  const run = await RunStore.getRun(id);
  if (!run) return;
  const st = await runStats(id, run.subreddit);
  currentRun = run;
  scrapeResult = { subreddit: run.subreddit, posts: null, preview: st.preview, keywordsEnabled: false, summary: statsToSummary(st), stats: st, run };
  showResults(scrapeResult);
  resultsSection.scrollIntoView({ behavior: "smooth" });
}

// Direct archive path: posts 100 per request (~0.5 s), comments swept 100 per
// request in 4 parallel shards (~0.15 s effective), plus a small per-post
// share for top-ups. Without a comment count, assume ~12 comments per post.
function estimateTime(postCount, includeComments, commentCount = null) {
  const postSeconds = Math.ceil(postCount / 100) * 0.5;
  if (!includeComments) return Math.max(1, Math.round(postSeconds));
  const comments = commentCount != null ? commentCount * 1.08 : postCount * 12;
  const sweepSeconds = Math.ceil(comments / 100) * 0.15;
  const topupSeconds = postCount * 0.02;
  return Math.max(2, Math.round(postSeconds + sweepSeconds + topupSeconds));
}

function formatDuration(seconds) {
  if (seconds < 60) return `~${seconds}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `~${m}m ${s}s` : `~${m}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `~${h}h ${m}m` : `~${h}h`;
}

// --- API call helper ---
async function apiCall(body, maxRetries = 5, { background = false } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch("/api/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // background calls (counts) outlive a run and must not share its abort
      signal: background ? undefined : abortController?.signal,
    });
    const data = await resp.json();
    if (resp.ok) return data;

    const errMsg = data.error || `Server error (${resp.status})`;
    if (attempt < maxRetries && (resp.status === 429 || resp.status >= 500 || /rate limit|timeout|slow down/i.test(errMsg))) {
      const wait = Math.min(5000 * 2 ** attempt, 60000);
      RunLog.event("warn", "server_retry", { action: body.action, status: resp.status, error: errMsg.slice(0, 120), wait_s: wait / 1000, attempt: attempt + 1 });
      if (!background) updateProgress(`Data source rate-limited. Waiting ${wait / 1000}s and retrying...`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    throw new Error(errMsg);
  }
}

// --- Comment completion ---
// The server stops on a time budget and hands back a cursor; keep calling the
// "comments" action until the thread is whole so no dataset is silently partial.
async function completeComments(post, onProgress) {
  const seen = new Set((post.comments || []).map((c) => c.id));
  post.comments = post.comments || [];
  while (post.comments_complete === false) {
    if (onProgress) onProgress(post.comments.length);
    const sent = post.comments_cursor;
    const page = await apiCall({ action: "comments", postId: post.id, after: sent });
    let added = 0;
    for (const c of page.comments) {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        post.comments.push(c);
        added++;
      }
    }
    post.comments_cursor = page.after;
    post.comments_complete = page.done;
    // Never spin on a cursor that stopped moving; leave the post flagged partial.
    if (!page.done && page.after === sent && added === 0) break;
  }
  assignDepths(post.comments);
}

// The archive returns comments flat; depth comes from walking parent_id.
// 0 = top-level, null = parent not in the archive (or a malformed cycle),
// so a missing parent is reported as unknown rather than a wrong 0.
function assignDepths(comments) {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const memo = new Map();
  const visiting = new Set();
  const depthOf = (c) => {
    if (memo.has(c.id)) return memo.get(c.id);
    if (visiting.has(c.id)) return null;
    visiting.add(c.id);
    let d;
    if (!c.parent_id || c.parent_id.startsWith("t3_")) d = 0;
    else {
      const parent = byId.get(c.parent_id.slice(3));
      if (!parent) d = null;
      else {
        const pd = depthOf(parent);
        d = pd === null ? null : pd + 1;
      }
    }
    visiting.delete(c.id);
    memo.set(c.id, d);
    return d;
  };
  for (const c of comments) c.depth = depthOf(c);
}

// --- UI references ---
const analyzeBtn = document.getElementById("analyzeBtn");
const scrapeBtn = document.getElementById("scrapeBtn");
const stopBtn = document.getElementById("stopBtn");
const progressSection = document.getElementById("progress");
const progressFill = document.getElementById("progressFill");
const statusText = document.getElementById("statusText");
const resultsSection = document.getElementById("results");
const errorSection = document.getElementById("error");
const errorText = document.getElementById("errorText");
const analysisCard = document.getElementById("analysisCard");
const threadCard = document.getElementById("threadCard");
const resumeBanner = document.getElementById("resumeBanner");
const optionsPanel = document.getElementById("optionsPanel");

function updateProgress(message, percent = null) {
  statusText.textContent = message;
  if (percent !== null) {
    progressFill.style.width = `${Math.min(percent, 100)}%`;
  }
}

function showError(msg) {
  errorSection.classList.remove("hidden");
  errorText.textContent = msg;
  RunLog.event("error", "ui_error", { error: String(msg).slice(0, 300) });
}

// A subreddit name is 2-21 letters/digits/underscores (optionally r/ or a
// reddit.com URL). Anything else — spaces, a sentence, a question — is a topic,
// and belongs in study discovery, which suggests communities to scrape.
// Mirrors parseRedditInput on the server: thread links in any shape people
// paste, community names with or without r/, or a topic sentence.
function classifyInput(text) {
  const t = text.trim().replace(/^https?:\/\//i, "").replace(/^(www|old|new|m|np)\./i, "");
  if (/^(?:reddit\.com)?\/?r\/[A-Za-z0-9_]+\/comments\/[a-z0-9]+/i.test(t)) return "thread";
  if (/^redd\.it\/[a-z0-9]+/i.test(t) || /^reddit\.com\/comments\/[a-z0-9]+/i.test(t)) return "thread";
  if (/^(?:reddit\.com)?\/?r\/[A-Za-z0-9_]+\/?(?:[?#].*)?$/i.test(t)) return "subreddit";
  if (/^[A-Za-z0-9_]{2,21}$/.test(t)) return "subreddit";
  if (/reddit\.com|redd\.it/i.test(t)) return "unknown_link";
  return t.length >= 20 ? "topic" : "short";
}

function looksLikeSubreddit(text) {
  const kind = classifyInput(text);
  return kind === "thread" || kind === "subreddit" || kind === "unknown_link";
}

// Live check under the search bar: one archive request, debounced, as you type.
const inputCheck = document.getElementById("inputCheck");
let inputCheckTimer = null;
let inputCheckSeq = 0;

function fmtCompact(n) {
  if (!n) return "0";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e4) return Math.round(n / 1e3) + "k";
  return n.toLocaleString();
}

async function liveCheckInput() {
  const text = document.getElementById("subreddit").value.trim();
  const seq = ++inputCheckSeq;
  if (!text) { inputCheck.textContent = ""; inputCheck.className = "input-check"; return; }
  const kind = classifyInput(text);
  if (kind === "topic") { inputCheck.textContent = "Looks like a topic — press Analyze and I will suggest communities to scrape."; inputCheck.className = "input-check neutral"; return; }
  if (kind === "short") { inputCheck.textContent = ""; inputCheck.className = "input-check"; return; }
  if (kind === "unknown_link") { inputCheck.textContent = "That is a Reddit link, but not a thread or community I can read — paste the post's URL (…/r/<sub>/comments/<id>/…) or a community."; inputCheck.className = "input-check bad"; return; }
  inputCheck.textContent = "Checking the archive…";
  inputCheck.className = "input-check neutral";
  try {
    const r = await apiCall({ action: "peek", input: text }, 1);
    if (seq !== inputCheckSeq) return;
    if (r.type === "thread") {
      if (!r.found) { inputCheck.textContent = `Thread ${r.postId} is not in the archive — check the link, or it may be very new.`; inputCheck.className = "input-check bad"; return; }
      inputCheck.textContent = `✓ Thread found: “${r.title.slice(0, 80)}${r.title.length > 80 ? "…" : ""}” — r/${r.subreddit}, ${(r.num_comments || 0).toLocaleString()} comments (Reddit's count), ${new Date(r.created_utc * 1000).toLocaleDateString()}. Press Analyze to collect it.`;
      inputCheck.className = "input-check ok";
    } else if (r.type === "subreddit") {
      if (!r.found) { inputCheck.textContent = `r/${r.name} is not in the archive — check the spelling.`; inputCheck.className = "input-check bad"; return; }
      inputCheck.textContent = `✓ r/${r.name} — ${fmtCompact(r.subscribers)} members, ${fmtCompact(r.archived_posts)} archived posts${r.over18 ? ", NSFW" : ""}. Press Analyze.`;
      inputCheck.className = "input-check ok";
    } else {
      inputCheck.textContent = "";
      inputCheck.className = "input-check";
    }
  } catch (err) {
    if (seq !== inputCheckSeq) return;
    inputCheck.textContent = "";
    inputCheck.className = "input-check";
  }
}

document.getElementById("subreddit").addEventListener("input", () => {
  clearTimeout(inputCheckTimer);
  inputCheckTimer = setTimeout(liveCheckInput, 500);
});
document.getElementById("subreddit").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); analyzeBtn.click(); }
});

function runDiscoveryFor(text) {
  const card = document.getElementById("discoverCard");
  card.open = true;
  document.getElementById("studyDescription").value = text;
  card.scrollIntoView({ behavior: "smooth", block: "start" });
  discoverBtn.click();
}

// --- Analyze flow ---
analyzeBtn.addEventListener("click", async () => {
  const subredditInput = document.getElementById("subreddit").value.trim();
  if (!subredditInput) {
    showError("Enter a subreddit name or reddit.com URL — or describe your topic in a sentence and I will suggest communities.");
    return;
  }
  if (!looksLikeSubreddit(subredditInput)) {
    errorSection.classList.add("hidden");
    if (subredditInput.length < 20) {
      showError(`"${subredditInput}" is not a subreddit name. Describe the topic in a full sentence (what, who, where) and I will suggest communities to scrape.`);
      return;
    }
    runDiscoveryFor(subredditInput);
    return;
  }

  errorSection.classList.add("hidden");
  analysisCard.classList.add("hidden");
  threadCard.classList.add("hidden");
  resultsSection.classList.add("hidden");
  optionsPanel.classList.add("hidden");
  progressSection.classList.remove("hidden");
  progressFill.style.width = "0%";
  analyzeBtn.disabled = true;
  analyzeBtn.querySelector(".btn-text").textContent = "Analyzing...";

  try {
    updateProgress("Analyzing...", 20);

    const result = await apiCall({ action: "analyze", subreddit: subredditInput });

    updateProgress("Analysis complete!", 100);

    if (result.type === "thread") {
      // Single thread mode
      const expected = result.post.num_comments || 0;
      await completeComments(result.post, (n) => {
        const pct = expected ? Math.min(99, Math.round((n / expected) * 100)) : null;
        updateProgress(`Collecting comments: ${n.toLocaleString()} of ~${expected.toLocaleString()}...`, pct);
      });
      threadData = { subreddit: result.subreddit, post: result.post };
      showThreadResult(result);
    } else {
      // Subreddit mode
      currentAnalysis = result;
      if (pendingKeywords) {
        document.getElementById("keywords").value = pendingKeywords.join("\n");
        pendingKeywords = null;
      }
      showAnalysis(result);
      // Reveal options panel (progressive disclosure)
      optionsPanel.classList.remove("hidden");
    }
  } catch (err) {
    const msg = /not found or has no archived posts/.test(err.message)
      ? err.message + " If you meant a topic rather than a community name, describe it in a sentence and use “Describe your study” to get communities suggested."
      : err.message;
    showError(msg);
  } finally {
    progressSection.classList.add("hidden");
    analyzeBtn.disabled = false;
    analyzeBtn.querySelector(".btn-text").textContent = "Analyze";
  }
});

// --- Thread result display ---
function showThreadResult(result) {
  const post = result.post;
  const commentCount = (post.comments || []).length;

  document.getElementById("threadTitle").textContent = post.title;
  document.getElementById("threadMeta").textContent =
    `u/${post.author} in r/${result.subreddit} — ${new Date(post.created_datetime).toLocaleDateString()}` +
    (post.comments_complete === false ? " — comment collection incomplete" : "");

  document.getElementById("threadStats").innerHTML = `
    <div class="stat-card"><div class="value">1</div><div class="label">Post</div></div>
    <div class="stat-card"><div class="value">${commentCount.toLocaleString()}</div><div class="label">Comments in archive (all collected)</div></div>
    <div class="stat-card"><div class="value">${post.score.toLocaleString()}</div><div class="label">Score</div></div>
    <div class="stat-card"><div class="value">${post.num_comments.toLocaleString()}</div><div class="label">Reddit's own count (undercounts)</div></div>
  `;

  threadCard.classList.remove("hidden");

  // Set up scrapeResult for downloads
  scrapeResult = {
    subreddit: result.subreddit,
    posts: [post],
    keywordsEnabled: false,
    summary: buildSummary([post], false),
    run: null,
  };
}

document.getElementById("threadDownloadBtn").addEventListener("click", () => {
  if (!scrapeResult) return;
  showResults(scrapeResult);
  resultsSection.scrollIntoView({ behavior: "smooth" });
});

// --- Subreddit analysis display ---
function showAnalysis(analysis) {
  const { info, probes, estimatedTotalUnique } = analysis;

  document.getElementById("analysisTitle").textContent = `r/${info.name}`;
  document.getElementById("analysisDesc").textContent = info.description || info.title || "";

  const nsfwBadge = document.getElementById("analysisNsfw");
  if (info.over18) nsfwBadge.classList.remove("hidden");
  else nsfwBadge.classList.add("hidden");

  const ageYears = info.created_utc
    ? ((Date.now() / 1000 - info.created_utc) / (365.25 * 86400)).toFixed(1)
    : "?";

  const archive = analysis.archive || { posts: estimatedTotalUnique, comments: 0, counted_at: 0 };
  const countedAt = archive.counted_at
    ? new Date(archive.counted_at * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short" })
    : "";
  document.getElementById("analysisStats").innerHTML = `
    <div class="stat-card"><div class="value">${archive.posts.toLocaleString()}</div><div class="label">Archived posts${countedAt ? ` (as of ${countedAt})` : ""}</div></div>
    <div class="stat-card"><div class="value">${archive.comments.toLocaleString()}</div><div class="label">Archived comments</div></div>
    <div class="stat-card"><div class="value">${info.subscribers.toLocaleString()}</div><div class="label">Subscribers</div></div>
    <div class="stat-card"><div class="value">${ageYears}y</div><div class="label">Community age</div></div>
  `;

  analysisCard.classList.remove("hidden");
  applyScope();
}

// --- Scope: whole community | time frame | number of posts ---
// The scope drives the underlying inputs (#timeFilter, #limit, sort pills),
// which remain the single source of truth for the collection run.
const MAX_POSTS_PER_SORT = 100000;
let lastRangePreset = "year";

function getScope() {
  const checked = document.querySelector('input[name="scope"]:checked');
  return checked ? checked.value : "range";
}

function applyScope() {
  const scope = getScope();
  const tf = document.getElementById("timeFilter");
  if (scope === "range") {
    if (tf.value === "all") tf.value = lastRangePreset;
    lastRangePreset = tf.value;
  } else {
    if (tf.value !== "all") lastRangePreset = tf.value;
    tf.value = "all";
  }
  if (scope !== "count") {
    // every post exactly once: New is the only sort that does that
    sortPills.forEach((p) => p.classList.toggle("active", p.dataset.value === "new"));
  }
  updateTimeFilterState();
  updateCollectionEstimate();
}

document.querySelectorAll('input[name="scope"]').forEach((r) => r.addEventListener("change", applyScope));

function fmtN(n) { return (n || 0).toLocaleString(); }

function scopeTime(posts, comments = null) {
  return formatDuration(estimateTime(posts, document.getElementById("includeComments").checked, comments));
}

// Fill the three cards; the archive totals are known immediately, the rest arrive with counts.
function refreshScopeCards() {
  if (!currentAnalysis) return;
  const a = currentAnalysis.archive || {};
  const all = document.getElementById("scopeAllSummary");
  const allRadio = document.getElementById("scopeAll");
  if (a.posts > MAX_POSTS_PER_SORT) {
    allRadio.disabled = true;
    if (allRadio.checked) { document.getElementById("scopeRange").checked = true; }
    all.innerHTML = `<strong>${fmtN(a.posts)}</strong> posts · ${fmtN(a.comments)} comments — more than one run can hold; use time frames (one run each)`;
  } else {
    allRadio.disabled = false;
    all.innerHTML = `<strong>${fmtN(a.posts)}</strong> posts · ${fmtN(a.comments)} comments · ${scopeTime(a.posts, a.comments)}`;
  }
  const limit = parseInt(document.getElementById("limit").value, 10) || 500;
  const passes = Math.max(parseKeywords().length, 1);
  document.getElementById("scopeCountSummary").innerHTML =
    `<strong>${fmtN(Math.min(limit * passes, a.posts || limit * passes))}</strong> posts${passes > 1 ? " (limit per keyword)" : ""} · ${scopeTime(Math.min(limit * passes, a.posts || limit * passes))}`;
}

// One search per line (or comma); "a OR b" becomes two passes because the
// archive's full-text search has no OR. Quoted phrases pass through.
function parseKeywords() {
  const raw = document.getElementById("keywords")?.value || "";
  const out = [];
  for (const line of raw.split(/[\n,]+/)) {
    for (const term of line.split(/\s+OR\s+/i)) {
      const t = term.trim();
      if (t && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

// The time window the current controls describe, in epoch seconds.
function selectedWindow() {
  const now = Math.floor(Date.now() / 1000);
  const tf = document.getElementById("timeFilter").value;
  const days = { day: 1, week: 7, month: 30, year: 365, year2: 730, year3: 1095, year5: 1826 }[tf];
  if (days) return { after: now - days * 86400, before: now, all: false };
  if (tf === "custom") {
    const fromVal = document.getElementById("dateFrom").value;
    const toVal = document.getElementById("dateTo").value;
    if (!fromVal) return null;
    const after = Math.floor(new Date(fromVal + "T00:00:00Z").getTime() / 1000);
    const before = toVal ? Math.floor(new Date(toVal + "T23:59:59Z").getTime() / 1000) : now;
    return before > after ? { after, before, all: false } : null;
  }
  return { after: 0, before: now, all: true };
}

// Window counts are fetched once per window and remembered for the session.
const windowCounts = new Map();
let countRequestSeq = 0;

// Keyword counts: the archive's full-text search takes seconds per page on a
// big community and is the first thing it sheds under load, so the server
// count often cannot finish at all. Estimate in the browser instead: three
// one-week samples (newest, middle, oldest), one request each through the
// archive client's own backoff, scaled by matches-per-week to the window.
async function estimateKeywordCount(subreddit, after, before, query) {
  const WEEK = 7 * 86400;
  const span = before - after;
  const single = span <= 3 * WEEK;
  const wins = single
    ? [{ after, before }]
    : [{ after: before - WEEK, before }, { after: Math.floor(after + span / 2 - WEEK / 2), before: Math.floor(after + span / 2 + WEEK / 2) }, { after, before: after + WEEK }];
  const rates = [], perPost = [];
  let exact = single;
  for (const w of wins) { // one at a time: a burst of full-text queries is what gets shed
    const batch = await Archive.get("posts/search", { subreddit, query, after: w.after, before: w.before, limit: 100, sort: "desc" }, { retries: 5, soft: true });
    const n = batch.length;
    if (n === 0) { rates.push(0); continue; }
    const ts = batch.map((p) => p.created_utc);
    // a full page covers less than the week: scale by the page's own span
    const dt = n < 100 ? w.before - w.after : Math.max(1, Math.max(...ts) - Math.min(...ts));
    if (n === 100) exact = false;
    rates.push(n / dt);
    perPost.push(batch.reduce((z, p) => z + (p.num_comments || 0), 0) / n);
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const est = Math.round(mean(rates) * span);
  return { posts: est, comments: Math.round(est * (perPost.length ? mean(perPost) : 0)), exact, rough: !exact };
}

async function countSelectedWindow() {
  const win = selectedWindow();
  if (!win || !currentAnalysis) return null;
  const keywords = parseKeywords();
  if (win.all && keywords.length === 0) {
    const a = currentAnalysis.archive || {};
    return { posts: a.posts || currentAnalysis.estimatedTotalUnique, comments: a.comments || 0, exact: true, all: true };
  }
  const after = win.all ? (currentAnalysis.archive?.earliest_post || 1104537600) : win.after;
  const before = win.before;
  const countOne = (query) => {
    const key = `${currentAnalysis.info.name}:${after}:${before}:${query}`;
    if (!windowCounts.has(key)) {
      const request = (query && typeof Archive !== "undefined" && Archive.isAvailable()
        ? estimateKeywordCount(currentAnalysis.info.name, after, before, query)
        : apiCall({ action: "count", subreddit: currentAnalysis.info.name, afterEpoch: after, beforeEpoch: before, query }, 5, { background: true }))
        .catch((err) => { windowCounts.delete(key); throw err; });
      windowCounts.set(key, request);
    }
    return windowCounts.get(key);
  };
  if (keywords.length === 0) return countOne("");
  const parts = await Promise.all(keywords.map(countOne));
  return {
    posts: parts.reduce((s, p) => s + p.posts, 0),
    comments: parts.reduce((s, p) => s + p.comments, 0),
    exact: parts.every((p) => p.exact),
    rough: parts.some((p) => p.rough),
    all: false,
    keywords: keywords.length,
    perKeyword: keywords.map((k, i) => ({ keyword: k, posts: parts[i].posts })),
  };
}

function updateCollectionEstimate() {
  if (!currentAnalysis) return;
  const el = document.getElementById("collectionEstimate");
  if (!el) return;

  refreshScopeCards();
  const scope = getScope();
  const selectedSorts = Array.from(document.querySelectorAll("#sortPills .pill.active"));
  const sortCount = Math.max(selectedSorts.length, 1);
  const limit = parseInt(document.getElementById("limit").value, 10) || 500;
  const passes = Math.max(parseKeywords().length, 1);
  const scopeLabel = scope === "all" ? "the whole community" : scope === "range" ? "this time frame" : "the newest slice";

  document.getElementById("splitRow")?.classList.toggle("hidden", scope === "count");
  if (scope === "count") {
    const totalPosts = Math.min(limit * sortCount * passes, currentAnalysis.estimatedTotalUnique);
    renderEstimateBar(totalPosts, null, scopeLabel);
    const range = document.getElementById("estimateRange");
    if (range) range.textContent = passes > 1 ? `${limit.toLocaleString()} newest matches per keyword, ${sortCount} sort mode${sortCount > 1 ? "s" : ""}.` : `${limit.toLocaleString()} newest posts${sortCount > 1 ? ` per sort mode (${sortCount})` : ""}.`;
    return;
  }

  renderEstimateBar(null, null, scopeLabel);
  // A previous count may have disabled the button ("more than 100,000") and
  // would otherwise size the next run; that verdict belongs to the old
  // scope — this one starts open and unsized until its own count lands.
  scrapeBtn.disabled = false;
  lastCount = null;

  const seq = ++countRequestSeq;
  countSelectedWindow()
    .then((count) => {
      if (seq !== countRequestSeq) return; // a newer window superseded this one
      renderRangeCount(count);
    })
    .catch((err) => {
      if (seq !== countRequestSeq) return;
      const range = document.getElementById("estimateRange");
      if (range) range.textContent = `Could not count this range (${err.message}).`;
    });
}

// The prominent summary above the Squeeze button. null = still counting.
const SQUEEZE_NOTE_DEFAULT = document.getElementById("squeezeNote")?.textContent || "";

function renderEstimateBar(posts, comments, scopeLabel) {
  const el = document.getElementById("collectionEstimate");
  const includeComments = document.getElementById("includeComments").checked;
  const known = posts !== null;
  const eta = known ? formatDuration(estimateTime(posts, includeComments, comments)) : "…";
  el.innerHTML = `
    <div class="estimate-bar">
      <div class="estimate-item">
        <span class="estimate-number">${known ? posts.toLocaleString() : "…"}</span>
        <span class="estimate-label">${scopeLabel === "the newest slice" ? "newest posts to collect" : "posts in " + scopeLabel}</span>
      </div>
      ${comments !== null && comments !== undefined ? `<div class="estimate-divider"></div>
      <div class="estimate-item">
        <span class="estimate-number">${comments.toLocaleString()}</span>
        <span class="estimate-label">comments (Reddit's count)</span>
      </div>` : ""}
      <div class="estimate-divider"></div>
      <div class="estimate-item">
        <span class="estimate-number">${eta}</span>
        <span class="estimate-label">estimated time${includeComments ? " (with comments)" : ""}</span>
      </div>
    </div>
    <p class="estimate-range" id="estimateRange">${known ? "" : "Counting… you can start now; the count only sizes the estimate and the run collects every match either way."}</p>
    <p class="estimate-hint">Progress is saved automatically — you can close this tab and resume later.</p>
  `;
  // The button is always a plain call to action; "count still running" in its
  // label read as "the scrape is running" and nobody clicked it.
  const label = scrapeBtn.querySelector(".btn-text");
  if (label) {
    label.textContent = known
      ? `Squeeze ${posts.toLocaleString()} posts · ${eta}${includeComments ? " with comments" : ""}`
      : "Squeeze Data";
  }
  const note = document.getElementById("squeezeNote");
  if (note) {
    note.textContent = known
      ? SQUEEZE_NOTE_DEFAULT
      : "The post count is still loading — click Squeeze anyway; the count only sizes the estimate, the run collects every match.";
  }
}

let lastCount = null;

function renderRangeCount(count) {
  const range = document.getElementById("estimateRange");
  lastCount = count || null;
  if (!range) return;
  if (!count) {
    range.textContent = "Pick a start date to count posts in a custom range.";
    return;
  }
  // Whole-community and time-frame scopes collect everything counted: set the
  // limit for the run and show the figures prominently.
  const scope = getScope();
  if (scope !== "count") {
    const perPass = count.perKeyword ? Math.max(...count.perKeyword.map((p) => p.posts)) : count.posts;
    document.getElementById("limit").value = String(Math.max(1, Math.min(perPass, MAX_POSTS_PER_SORT)));
    renderEstimateBar(count.posts, count.comments, scope === "all" ? "the whole community" : "this time frame");
    const summary = document.getElementById(scope === "all" ? "scopeAllSummary" : "scopeRangeSummary");
    if (summary) summary.innerHTML = `<strong>${(count.exact ? "" : "≈ ") + fmtN(count.posts)}</strong> posts · ${(count.exact ? "" : "≈ ") + fmtN(count.comments)} comments · ${scopeTime(count.posts, count.comments)}`;
  }
  const approx = count.exact ? "" : "≈ ";
  let qualifier = count.all
    ? "in the whole archive"
    : count.exact ? "in this time range (exact)" : count.rough ? "in this time range (rough estimate from three sampled weeks — the run collects every match regardless)" : "in this time range (estimate, typically within ±15%)";
  if (count.keywords) {
    const breakdown = count.perKeyword.map((p) => `${escapeHtml(p.keyword)}: ${approx}${p.posts.toLocaleString()}`).join(" · ");
    qualifier = `matching your ${count.keywords} keyword${count.keywords > 1 ? "s" : ""} ${qualifier}` +
      (count.keywords > 1 ? ` (${breakdown}; a post matching several is kept once)` : "");
  }
  // Comment counts come from Reddit's counter at the archive's ~36h re-fetch,
  // so a window that reaches into the last 36 hours under-reports comments.
  const win = selectedWindow();
  const recent = win && !win.all && win.before > Date.now() / 1000 - 36 * 3600
    ? " Comment count is low for posts under ~36 hours old."
    : "";
  const n = count.posts;
  const rangeEl = document.getElementById("estimateRange"); // re-rendered above; the first handle is detached
  const segments = win ? splitWindow(win.all ? { after: currentAnalysis.archive?.earliest_post || 1104537600, before: win.before } : win, getSplitBy()) : [win];
  const perRun = count.perKeyword ? Math.max(...count.perKeyword.map((p) => p.posts)) : n;
  const tooMany = perRun / segments.length > MAX_POSTS_PER_SORT;
  const batchNote = segments.length > 1
    ? `<span class="estimate-batch">Runs as ${segments.length} runs back-to-back: ${segments.map(segmentLabel).join(", ")}.</span>`
    : "";
  rangeEl.innerHTML = `
    ${approx}${n.toLocaleString()} posts · ${approx}${count.comments.toLocaleString()} comments ${qualifier}.${recent}
    ${batchNote}
    ${tooMany ? `<span class="estimate-warn">${segments.length > 1 ? `About ${Math.round(perRun / segments.length).toLocaleString()} posts per run is more` : "More"} than ${MAX_POSTS_PER_SORT.toLocaleString()} — one run cannot hold this; choose a finer split above (per half-year or per quarter) or a narrower time frame.</span>` : ""}
    ${count.perKeyword ? `<span class="estimate-warn">Limit set to the largest keyword's count per pass, so every match is collected.</span>` : ""}
  `;
  if (tooMany) scrapeBtn.disabled = true; else scrapeBtn.disabled = false;
}

// Wire settings changes to update the estimate live
document.getElementById("limit").addEventListener("input", () => {
  if (getScope() !== "count") document.getElementById("scopeCount").checked = true;
  applyScope();
});
document.getElementById("includeComments").addEventListener("change", updateCollectionEstimate);
sortPills.forEach((pill) => pill.addEventListener("click", () => setTimeout(updateCollectionEstimate, 0)));
timeFilterSelect.addEventListener("change", updateCollectionEstimate);
let keywordsTimer = null;
document.getElementById("keywords").addEventListener("input", () => {
  clearTimeout(keywordsTimer);
  keywordsTimer = setTimeout(updateCollectionEstimate, 600);
});
dateFromInput.addEventListener("change", updateCollectionEstimate);
dateToInput.addEventListener("change", updateCollectionEstimate);
document.getElementById("splitBy")?.addEventListener("change", updateCollectionEstimate);

// --- Scrape Orchestration ---
scrapeBtn.addEventListener("click", () => startScrape());

// --- Post-ID list mode ---
// Accepts bare ids, t3_ ids, reddit.com / redd.it links, one per line or
// separated by commas/spaces; CSV files contribute their post_id (or id) column.
function parseIdList(text) {
  const out = [];
  const seen = new Set();
  const add = (id) => { id = String(id).toLowerCase().replace(/^t3_/, ""); if (/^[a-z0-9]{5,8}$/.test(id) && !seen.has(id)) { seen.add(id); out.push(id); } };
  const trimmed = text.replace(/^\uFEFF/, "");
  const firstLine = trimmed.split(/\r?\n/, 1)[0] || "";
  const cols = firstLine.split(/[,;\t]/).map((x) => x.trim().replace(/^"|"$/g, "").toLowerCase());
  const colIdx = cols.indexOf("post_id") >= 0 ? cols.indexOf("post_id") : cols.indexOf("id");
  if (cols.length > 1 && colIdx >= 0) {
    for (const row of parseCsvRows(trimmed).slice(1)) if (row[colIdx]) add(row[colIdx]);
    return out;
  }
  for (const tok of trimmed.split(/[\s,;]+/)) {
    if (!tok) continue;
    const m = tok.match(/comments\/([a-z0-9]{5,8})/i) || tok.match(/redd\.it\/([a-z0-9]{5,8})/i);
    add(m ? m[1] : tok.replace(/^["']|["']$/g, ""));
  }
  return out;
}

// Minimal RFC 4180 reader: quoted fields may hold commas, quotes and newlines.
function parseCsvRows(text) {
  const rows = [];
  let row = [], field = "", q = false;
  const sep = (text.split(/\r?\n/, 1)[0] || "").includes("\t") ? "\t" : (text.split(/\r?\n/, 1)[0] || "").includes(";") && !(text.split(/\r?\n/, 1)[0] || "").includes(",") ? ";" : ",";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

let idsParsed = [];
function refreshIdCount() {
  idsParsed = parseIdList(document.getElementById("idsText").value);
  const n = idsParsed.length;
  document.getElementById("idsCount").textContent = n ? `${n.toLocaleString()} post ID${n > 1 ? "s" : ""} · ${Math.ceil(n / 1000)} batch${n > 1000 ? "es" : ""} · about ${formatDuration(estimateTime(n, document.getElementById("idsComments").checked))}` : "Paste or upload IDs to begin.";
  document.getElementById("idsBtn").disabled = n === 0 || !!abortController;
}
document.getElementById("idsText").addEventListener("input", refreshIdCount);
document.getElementById("idsComments").addEventListener("change", refreshIdCount);
document.getElementById("idsFile").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const ta = document.getElementById("idsText");
  ta.value = (ta.value.trim() ? ta.value.trim() + "\n" : "") + parseIdList(text).join("\n");
  refreshIdCount();
  e.target.value = "";
});
// Author panel: everything the listed accounts posted in one community. User names stay in this
// browser (they are needed to query the archive); exports of such a run are pseudonymised by default.
function startAuthorRun(subreddit, authors, { includeComments = false, design = null } = {}) {
  const chunks = [];
  for (let i = 0; i < authors.length; i += 25) chunks.push({ i: chunks.length, after: null, before: null, authors: authors.slice(i, i + 25), status: "pending", posts: 0 });
  const run = {
    id: RunStore.newId(), subreddit, status: "running", createdAt: Date.now(), updatedAt: Date.now(),
    settings: { limit: MAX_POSTS_PER_SORT, includeComments, includeSelftext: true, skipNSFW: false, keywords: [] },
    plan: { scope: "authors", window: null, limit: MAX_POSTS_PER_SORT, queue: [{ sort: "new", label: "By author", query: "" }], expectedPosts: null, expectedComments: null, authorCount: authors.length },
    chunks, progress: { chunkIdx: 0, modeIdx: 0, after: null, modeFetched: 0, seq: 0 }, counts: { posts: 0, comments: 0 },
  };
  if (design) run.design = design;
  return startScrape({ run });
}

// Start a run that fetches exactly these posts. `design` (optional) records where the
// list came from: a sample or a matched design built in the Design panel.
function startIdRun(ids, { includeComments = true, design = null } = {}) {
  const chunks = [];
  for (let i = 0; i < ids.length; i += 1000) chunks.push({ i: chunks.length, after: null, before: null, ids: ids.slice(i, i + 1000), status: "pending", posts: 0 });
  const run = {
    id: RunStore.newId(),
    subreddit: "by-id",
    status: "running",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    settings: { limit: ids.length, includeComments, includeSelftext: true, skipNSFW: false, keywords: [] },
    plan: { scope: "ids", window: null, limit: ids.length, queue: [{ sort: "new", label: "By ID", query: "" }], expectedPosts: ids.length, expectedComments: null, idCount: ids.length },
    chunks,
    progress: { chunkIdx: 0, modeIdx: 0, after: null, modeFetched: 0, seq: 0 },
    counts: { posts: 0, comments: 0 },
  };
  if (design) run.design = design;
  return startScrape({ run });
}

document.getElementById("idsBtn").addEventListener("click", () => {
  refreshIdCount();
  if (!idsParsed.length) return;
  document.getElementById("idsBlock").open = false;
  startIdRun(idsParsed.slice(), { includeComments: document.getElementById("idsComments").checked });
});

let currentRun = null;

// reddit_<subreddit>[_<segment>] — batch runs get their segment ("2024_Q3") in the name
// Export names must never collide between runs on the same community, and
// should say what the file holds without opening it:
//   reddit_<subreddit>_<scope>[_kw-<keywords>]_<started YYYYMMDD-HHMM>_<kind>
// scope: "2023-09-18_to_2026-09-18", a batch segment such as "2024_Q3",
// or "newest-500". The start time makes a re-run of the same scope a new file.
function safeName(text, max = 40) {
  return String(text).normalize("NFKD").replace(/[^\w.+-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, max);
}
function stamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
function exportBaseName(run) {
  const plan = run.plan || {};
  let scope;
  if (plan.segment) scope = safeName(plan.segment.replace(/\s*→\s*/g, "_to_"));
  else if (plan.scope === "ids") scope = `ids-${plan.idCount || 0}`;
  else if (plan.scope === "authors") scope = `authors-${plan.authorCount || 0}`;
  else if (plan.scope === "count" || !plan.window) scope = `newest-${plan.limit || run.settings?.limit || 0}`;
  else scope = `${isoDay(plan.window.after)}_to_${isoDay(plan.window.before)}`;
  const kws = run.settings?.keywords || [];
  const kw = kws.length ? `_kw-${safeName(kws.slice(0, 3).map((k) => k.replace(/["']/g, "")).join("+"), 40)}${kws.length > 3 ? `+${kws.length - 3}more` : ""}` : "";
  return `reddit_${run.subreddit}_${scope}${kw}_${stamp(run.createdAt || Date.now())}`;
}
// Thread downloads and other run-less results: subreddit plus the moment of download.
function exportBaseNameFor(result) {
  return result.run ? exportBaseName(result.run) : `reddit_${result.subreddit}_${stamp(Date.now())}`;
}

function stripStoreFields(p) {
  const { runId: _r, seq: _s, comments_offloaded: _o, comments_counted: _c, ...post } = p;
  return post;
}

// Counts, completeness lists and a preview, read from the store in batches —
// a 100,000-post run never has to sit in memory at once.
async function runStats(runId, subreddit = "") {
  const st = { total_posts: 0, total_comments: 0, total_score: 0, incomplete: [], notFetched: [], archiveShort: [], reused: 0, preview: [], bytes: null, desc: null };
  const agg = window.RunStats ? window.RunStats.createRunStats() : null;
  await RunStore.iteratePosts(runId, 500, async (batch) => {
    if (st.bytes === null) {
      // extrapolate export sizes from the first batch
      const sample = batch.map(stripStoreFields);
      const k = st_total(sample);
      st.bytes = { sample_posts: sample.length, combined: combinedToCSV(sample, false, { subreddit }).length, posts: postsToCSV(sample, false, { subreddit }).length, comments: commentsToCSV(sample, false, { subreddit }).length, sample_comments: k };
    }
    for (const p of batch) {
      if (agg) agg.add(p);
      st.total_posts++;
      st.total_comments += p.comments?.length || 0;
      st.total_score += p.score || 0;
      if (p.comments_complete === false) {
        st.incomplete.push(p.id);
        if (p.comments_walked === true) st.archiveShort.push(p.id); else st.notFetched.push(p.id);
      }
      if (p.reused) st.reused++;
      if (st.preview.length < 5) st.preview.push(stripStoreFields(p));
    }
  });
  if (agg) st.desc = agg.result();
  return st;
}

function st_total(posts) { return posts.reduce((n, p) => n + (p.comments?.length || 0), 0); }

// Export sizes for the whole run, scaled from the sampled batch: post rows by
// posts, comment rows by comments.
function estimateExportBytes(st) {
  if (!st.bytes || !st.bytes.sample_posts) return null;
  const b = st.bytes;
  const postScale = st.total_posts / b.sample_posts;
  const commentScale = b.sample_comments ? st.total_comments / b.sample_comments : postScale;
  return {
    combined: Math.round(b.combined * (st.total_comments ? commentScale : postScale)),
    posts: Math.round(b.posts * postScale),
    comments: Math.round(b.comments * commentScale),
  };
}

function fmtBytes(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + " GB";
  if (n >= 1e6) return Math.round(n / 1e6) + " MB";
  return Math.max(1, Math.round(n / 1e3)) + " KB";
}

const GZIP_DEFAULT_FROM_BYTES = 200e6;

function statsToSummary(st) {
  return {
    total_posts: st.total_posts,
    total_comments: st.total_comments,
    total_score: st.total_score,
    posts_with_incomplete_comments: st.incomplete.length,
    posts_not_fully_fetched: st.notFetched.length,
    posts_archive_below_reddit_count: st.archiveShort.length,
  };
}

// Build the file in parts straight from the store: no whole-file string (the
// browser caps a single string around 500 MB) and no whole run in memory.
const EXPORTERS = {
  combined: { fn: combinedToCSV, suffix: "combined.csv", mime: "text/csv" },
  posts: { fn: postsToCSV, suffix: "posts.csv", mime: "text/csv" },
  comments: { fn: commentsToCSV, suffix: "comments.csv", mime: "text/csv" },
  // conversation structure (web/lib/threads.js): who replied to what, and one summary row per thread
  edges: { fn: (posts, _kw, opts) => window.Threads.edgesToCSV(posts, opts), suffix: "reply_edges.csv", mime: "text/csv" },
  threads: { fn: (posts, _kw, opts) => window.Threads.threadsToCSV(posts, opts), suffix: "thread_summaries.csv", mime: "text/csv" },
};

// Two ways to hand over a file that may be hundreds of MB:
// - from a click, Chrome/Edge can stream straight to disk via the save-file
//   API — no in-memory file at all (a "Save as" dialog appears);
// - otherwise (automatic download, other browsers) the file is assembled as
//   Blob parts and the link is kept alive until the browser has taken it.
async function exportRun(run, kind, opts = {}) {
  return exportRuns([run], kind, opts);
}

// What a merged file calls each run: the batch segment or the scope, plus keywords.
function runLabel(run) {
  const kws = run.settings?.keywords || [];
  return `${run.plan?.segment || scopeText(run.plan || {})}${kws.length ? ` · kw: ${kws.join(" | ")}` : ""}`;
}

function mergedBaseName(runs) {
  const subs = Array.from(new Set(runs.map((r) => r.subreddit)));
  return `reddit_${subs.length === 1 ? subs[0] : subs.length + "subs"}_merged-${runs.length}runs_${stamp(Date.now())}`;
}

// One file from one or several runs. With several, every row carries
// run_label and run_id so the runs can be told apart (and `query` says
// which keyword found the post).
async function exportRuns(runs, kind, { gesture = false, gzip = false } = {}) {
  const run = runs[0];
  const merged = runs.length > 1;
  if (!RunLog.current()) RunLog.attach(run);
  const subtitle = document.getElementById("resultsSubtitle");
  const previous = subtitle.textContent;
  const status = (msg) => { subtitle.textContent = msg; };
  const isJson = kind === "json";
  const canGzip = gzip && typeof CompressionStream === "function";
  const base = merged ? mergedBaseName(runs) : exportBaseName(run);
  const plainName = isJson ? `${base}_full.json` : `${base}_${EXPORTERS[kind].suffix}`;
  const filename = canGzip ? plainName + ".gz" : plainName;
  const mime = canGzip ? "application/gzip" : (isJson ? "application/json" : EXPORTERS[kind].mime);
  const encoder = new TextEncoder();

  // Columns a study design attached to its posts (sample_group, match_post_id, flag_*): the union over the runs in this file.
  const designOnly = Array.from(new Set(runs.flatMap((r) => r.design?.columns || [])));
  // Optional analysis columns, derived from what is already in the row: what is left of each body.
  const analysis = !!document.getElementById("analysisToggle")?.checked && window.Design;
  const designCols = analysis ? [...designOnly, "post_body_state", ...(kind === "combined" || kind === "comments" ? ["comment_body_state"] : [])] : designOnly;
  const postExtras = (ann) => (ann || analysis) ? (p) => ({ ...(ann ? ann[p.id] || {} : {}), ...(analysis ? { post_body_state: window.Design.bodyState(p.selftext) } : {}) }) : undefined;
  const commentExtras = analysis ? (c) => ({ comment_body_state: window.Design.bodyState(c.body) }) : undefined;

  // Pseudonymise authors on the way out (never in the store): SHA-256 of salt + name, as in the CLI.
  const pseudo = document.getElementById("pseudoToggle")?.checked && window.Pseudo ? window.Pseudo.createPseudonymiser(window.Pseudo.loadOrCreateSalt(localStorage).salt) : null;
  const outPosts = async (batch) => { const posts = batch.map(stripStoreFields); return pseudo ? pseudo.apply(posts) : posts; };

  // Produce the file as a sequence of text pieces.
  async function produce(emit) {
    let n = 0;
    const where = (k) => merged ? `run ${k + 1} of ${runs.length} · ` : "";
    if (isJson) {
      await emit("[\n");
      let first = true;
      for (let k = 0; k < runs.length; k++) {
        const r = runs[k];
        const tag = merged ? { run_label: runLabel(r), run_id: r.id } : {};
        const ann = r.design?.annotations || null;
        await RunStore.iteratePosts(r.id, 500, async (batch) => {
          for (const p of await outPosts(batch)) { await emit((first ? "" : ",\n") + JSON.stringify({ ...p, ...tag, ...(ann ? ann[p.id] || {} : {}) }, null, 2)); first = false; }
          n += batch.length;
          status(`Preparing download… ${where(k)}${n.toLocaleString()} posts`);
        });
      }
      await emit("\n]\n");
    } else {
      const { fn } = EXPORTERS[kind];
      let first = true;
      for (let k = 0; k < runs.length; k++) {
        const r = runs[k];
        const extra = merged ? { run_label: runLabel(r), run_id: r.id } : undefined;
        const ann = r.design?.annotations || null;
        await RunStore.iteratePosts(r.id, 500, async (batch) => {
          const text = fn(await outPosts(batch), false, { header: first, subreddit: r.subreddit, extra, extraCols: designCols, extraFor: postExtras(ann), extraForComment: commentExtras });
          if (text) await emit(text + "\n"); // an empty batch must not leave a blank line
          first = false;
          n += batch.length;
          status(`Preparing download… ${where(k)}${n.toLocaleString()} posts`);
        });
      }
      if (first) await emit(fn([], false, { subreddit: run.subreddit, extra: merged ? { run_label: "", run_id: "" } : undefined, extraCols: designCols }) + "\n");
    }
  }

  try {
    // Streaming to disk: must start inside the click, before any await.
    if (gesture && typeof window.showSaveFilePicker === "function") {
      let handle;
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [canGzip
            ? { description: "gzip", accept: { "application/gzip": [".gz"] } }
            : { description: isJson ? "JSON" : "CSV", accept: { [mime]: [isJson ? ".json" : ".csv"] } }],
        });
      } catch (err) {
        if (err && err.name === "AbortError") return; // user cancelled the dialog
        handle = null; // API refused (e.g. cross-origin iframe): fall back to a Blob
      }
      if (handle) {
        const writable = await handle.createWritable();
        try {
          if (canGzip) {
            // compress on the way to disk; nothing is held in memory
            const cs = new CompressionStream("gzip");
            const piping = cs.readable.pipeTo(writable);
            const w = cs.writable.getWriter();
            await produce((text) => w.write(encoder.encode(text)));
            await w.close();
            await piping;
          } else {
            await produce((text) => writable.write(text));
            await writable.close();
          }
        } catch (err) {
          try { await writable.abort(); } catch { /* ignore */ }
          throw err;
        }
        status(`Saved ${filename}.`);
        RunLog.event("info", "export", { kind, filename, gzip: canGzip, via: "save-file dialog", runs: runs.length, pseudonymised: !!pseudo });
        setTimeout(() => { if (subtitle.textContent === `Saved ${filename}.`) subtitle.textContent = previous; }, 6000);
        return;
      }
    }
    const parts = [];
    if (canGzip) {
      const cs = new CompressionStream("gzip");
      const reading = (async () => { const r = cs.readable.getReader(); for (;;) { const { value, done } = await r.read(); if (done) break; parts.push(value); } })();
      const w = cs.writable.getWriter();
      await produce((text) => w.write(encoder.encode(text)));
      await w.close();
      await reading;
    } else {
      await produce((text) => { parts.push(text); });
    }
    downloadFile(parts, filename, mime);
    RunLog.event("info", "export", { kind, filename, gzip: canGzip, via: "download", parts: parts.length, runs: runs.length, pseudonymised: !!pseudo });
  } catch (err) {
    RunLog.event("error", "export_error", { kind, filename, ...RunLog.errorInfo(err) });
    showError(`The download failed: ${err.message || err}. Your data is still saved in Your runs — try again, or use Posts CSV for a smaller file.`);
  } finally {
    if (subtitle.textContent.startsWith("Preparing download")) subtitle.textContent = previous;
  }
}

// Posts as stored, without the store's own bookkeeping fields.
async function storedPosts(runId) {
  const posts = await RunStore.getPosts(runId);
  return posts.map(({ runId: _r, seq: _s, comments_offloaded: _o, comments_counted: _c, ...post }) => post);
}

// Chunk bounds are sent to the archive as `after`/`before`, which are EXCLUSIVE
// on both ends. Edges e_0..e_n partition the window; chunk k fetches
// created_utc in (e_k, e_{k+1}+1), i.e. [e_k+1, e_{k+1}] inclusive, so adjacent
// chunks meet with no gap and no overlap, and the window's own first and last
// seconds are included.
function makeChunks(window, expectedPosts) {
  if (!window) return [{ i: 0, after: null, before: null, status: "pending", posts: 0 }];
  // Without a count (still running, or failed) chunk by time instead: about a
  // month each, so progress, resume and the measured pace still work.
  const n = expectedPosts
    ? Math.min(MAX_CHUNKS, Math.max(1, Math.ceil(expectedPosts / CHUNK_TARGET_POSTS)))
    : Math.min(MAX_CHUNKS, Math.max(1, Math.ceil((window.before - window.after) / CHUNK_FALLBACK_SECONDS)));
  const lo = window.after - 1, hi = window.before + 1;
  const edge = (k) => (k === 0 ? lo : k === n ? hi - 1 : Math.floor(lo + ((hi - 1 - lo) * k) / n));
  const chunks = [];
  for (let i = 0; i < n; i++) {
    chunks.push({ i, after: edge(i), before: edge(i + 1) + 1, status: "pending", posts: 0 });
  }
  return chunks;
}

// Build a run from the current controls. The window is fixed now, so a resumed
// run — or the same run re-created from its manifest — covers the same posts.
async function planRunFromUI() {
  const subredditInput = document.getElementById("subreddit").value.trim();
  if (!subredditInput) { showError("Please enter a subreddit name or URL."); return null; }
  const sortModes = Array.from(document.querySelectorAll("#sortPills .pill.active")).map((p) => p.dataset.value);
  if (sortModes.length === 0) { showError("Please select at least one sort mode."); return null; }

  let limit = parseInt(document.getElementById("limit").value, 10) || 500;
  limit = Math.min(limit, MAX_POSTS_PER_SORT);
  const includeComments = document.getElementById("includeComments").checked;
  const includeSelftext = document.getElementById("includeSelftext").checked;
  const skipNSFW = document.getElementById("skipNSFW").checked;
  const keywords = parseKeywords();
  const scope = getScope();

  let window = null;
  if (scope !== "count") {
    const win = selectedWindow();
    if (!win) { showError("Please select a start date for your custom range."); return null; }
    window = win.all
      ? { after: currentAnalysis?.archive?.earliest_post || 1104537600, before: win.before }
      : { after: win.after, before: win.before };
  }

  let subreddit = subredditInput;
  const urlMatch = subreddit.match(/reddit\.com\/r\/([^/?\s]+)/);
  if (urlMatch) subreddit = urlMatch[1];
  subreddit = subreddit.replace(/^r\//, "");

  const queue = [];
  const passes = keywords.length ? keywords : [""];
  for (const query of passes) for (const mode of sortModes) {
    const tag = query ? ` "${query}"` : "";
    queue.push({ sort: mode, label: mode.charAt(0).toUpperCase() + mode.slice(1) + tag, query });
  }

  // Whole-community and time-frame scopes collect everything in the window:
  // size the chunks from the count when it is at hand and let every chunk walk
  // to exhaustion rather than stop at the limit box. The count is only for
  // sizing, so a slow one must not hold the run back: keyword counts on a big
  // community can take minutes (one full-text query per keyword) and start at
  // once; plain counts get a short wait, then the run chunks by time instead.
  let expected = null;
  let expectedComments = null;
  if (scope !== "count") {
    let count = lastCount;
    if (!count) {
      const pending = countSelectedWindow().catch(() => null);
      if (keywords.length === 0) {
        updateProgress("Counting the posts in this scope…", null);
        progressSection.classList.remove("hidden");
        count = await Promise.race([pending, new Promise((r) => setTimeout(() => r(null), COUNT_WAIT_MS))]);
      }
    }
    RunLog.event("info", "count", count
      ? { posts: count.posts, comments: count.comments, exact: !!count.exact, rough: !!count.rough, keywords: keywords.length }
      : { result: keywords.length ? "not waited for (keyword scope)" : "not available within the wait; chunking by time", keywords: keywords.length });
    expected = count ? count.posts : null;
    expectedComments = count ? count.comments : null;
    limit = MAX_POSTS_PER_SORT;
  }
  const makeRun = (win, exp, expC, extra = {}) => ({
    id: RunStore.newId(),
    subreddit,
    status: "running",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    settings: { limit, includeComments, includeSelftext, skipNSFW, keywords },
    plan: { scope, window: win, limit, queue, expectedPosts: exp, expectedComments: expC, ...extra },
    chunks: makeChunks(win, exp),
    progress: { chunkIdx: 0, modeIdx: 0, after: null, modeFetched: 0, seq: 0 },
    counts: { posts: 0, comments: 0 },
  });

  // A split scope becomes a batch: one run per segment, newest first, the
  // rest queued; each finished run starts the next by itself.
  const segments = window ? splitWindow(window, getSplitBy()) : [window];
  if (segments.length <= 1) return makeRun(window, expected, expectedComments);
  const batchId = RunStore.newId();
  const span = window.before - window.after;
  const runs = segments.map((seg, i) => {
    const frac = (seg.before - seg.after) / span; // counts are spread by time share
    const r = makeRun(seg, expected ? Math.max(1, Math.round(expected * frac)) : null, expectedComments ? Math.round(expectedComments * frac) : null, { segment: segmentLabel(seg) });
    r.batch = { id: batchId, index: i, total: segments.length };
    if (i > 0) r.status = "queued";
    return r;
  });
  for (const r of runs.slice(1)) await RunStore.saveRun(r);
  return runs[0];
}

async function startScrape(opts = {}) {
  const resumeId = opts.resumeId || null;
  let run;
  let allPosts = [];
  if (resumeId) {
    run = await RunStore.getRun(resumeId);
    if (!run) { showError("That run is no longer in this browser."); return; }
    allPosts = await RunStore.getPosts(resumeId);
    for (const p of allPosts) if (p.comments_complete !== undefined) p.comments_counted = true;
    // failed chunks get another go on resume; a finished-but-not-tailed run runs its tail
    for (const c of run.chunks) if (c.status === "failed") { c.status = "pending"; c.error = ""; }
    if (run.status === "complete" || run.status === "complete_with_gaps") run.progress = { ...run.progress, tail: "done" };
    run.status = "running";
    run.finishedAt = null;
  } else if (opts.run) {
    run = opts.run;
  } else {
    run = await planRunFromUI();
    if (!run) return;
  }
  currentRun = run;
  const { subreddit, settings, plan } = run;
  const { limit, includeComments, includeSelftext, skipNSFW } = settings;
  RunLog.attach(run);
  const runStartedAt = Date.now();
  const archiveStatsAt = { requests: Archive.stats.requests, retries: Archive.stats.retries, shed: Archive.stats.shed };
  RunLog.event("info", resumeId ? "resume" : "start", {
    subreddit, scope: plan.scope, window: plan.window ? `${isoDay(plan.window.after)} → ${isoDay(plan.window.before)}` : null,
    keywords: settings.keywords?.length || 0, sorts: plan.queue.map((q) => q.sort).join(","), include_comments: includeComments,
    chunks: run.chunks.length, expected_posts: plan.expectedPosts, batch: run.batch ? `${run.batch.index + 1}/${run.batch.total}` : undefined,
    posts_so_far: allPosts.length, direct_archive: Archive.isAvailable(), persistent_store: RunStore.isPersistent(), ...RunLog.env(),
  });
  const seenIds = new Set(allPosts.map((p) => p.id));
  const byId = new Map(allPosts.map((p) => [p.id, p]));
  const batchSize = includeComments ? 10 : 100;
  const expectedTotal = plan.expectedPosts || limit * plan.queue.length;

  // UI state
  abortController = new AbortController();
  progressSection.classList.remove("hidden");
  resultsSection.classList.add("hidden");
  errorSection.classList.add("hidden");
  scrapeBtn.classList.add("hidden");
  stopBtn.classList.remove("hidden");
  progressFill.style.width = "0%";
  updateProgress(resumeId && allPosts.length ? `Resuming… (${allPosts.length.toLocaleString()} posts already collected)` : run.batch ? `Starting run ${run.batch.index + 1} of ${run.batch.total} (${run.plan.segment})…` : "Starting squeeze…");
  await RunStore.saveRun(run);

  // Comment trees are written to IndexedDB and then dropped from memory, so the
  // tab's RAM stays bounded however large the run; exports re-read the store.
  let commentTotal = allPosts.reduce((n, p) => n + (p.comments?.length || 0), 0);
  const offload = (post) => {
    if (post.comments_offloaded) return;
    post.comments_offloaded = true;
    post.comments = [];
  };
  for (const p of allPosts) if (p.comments_complete === true) offload(p);

  const persistPosts = async (posts) => {
    if (!posts.length) return;
    await RunStore.putPosts(run.id, posts, run.progress.seq);
    let n = run.progress.seq;
    for (const p of posts) if (p.seq === undefined) p.seq = n++;
    run.progress.seq = n;
    for (const p of posts) {
      if (p.comments_complete !== undefined && !p.comments_offloaded && !p.comments_counted) { commentTotal += p.comments?.length || 0; p.comments_counted = true; }
      if (p.comments_complete !== undefined) offload(p);
    }
    run.counts = { ...run.counts, posts: allPosts.length, comments: commentTotal };
    await RunStore.saveRun(run);
  };

  const chunkLabel = (c) => run.chunks.length > 1
    ? (c.authors ? `Batch ${c.i + 1}/${run.chunks.length} (${c.authors.length.toLocaleString()} authors) · ` : c.ids ? `Batch ${c.i + 1}/${run.chunks.length} (${c.ids.length.toLocaleString()} IDs) · ` : `Chunk ${c.i + 1}/${run.chunks.length} (${isoDay(c.after + 1)} → ${isoDay(c.before - 1)}) · `)
    : "";

  // Time left: from the measured pace of chunks finished in this session; before
  // the first one finishes, from the pre-run estimate scaled to what is left.
  const chunkTimes = [];
  let chunkStartedAt = Date.now();
  const etaLeft = (c) => {
    const remainingChunks = run.chunks.filter((x) => x.status !== "done" && x.i > c.i).length;
    let seconds;
    if (chunkTimes.length) {
      const avg = chunkTimes.reduce((a, b) => a + b, 0) / chunkTimes.length / 1000;
      const currentElapsed = (Date.now() - chunkStartedAt) / 1000;
      seconds = remainingChunks * avg + Math.max(avg - currentElapsed, avg * 0.15);
    } else if (plan.expectedPosts || plan.scope === "count") {
      const doneChunks = run.chunks.filter((x) => x.status === "done").length;
      const share = Math.max(0.05, 1 - doneChunks / Math.max(run.chunks.length, 1));
      seconds = estimateTime(Math.round(expectedTotal * share), includeComments, plan.expectedComments != null ? Math.round(plan.expectedComments * share) : null);
    } else {
      return null; // no count and nothing measured yet
    }
    return formatDuration(Math.max(5, Math.round(seconds)));
  };
  const leftText = (c) => { const t = etaLeft(c); return t ? `${t} left` : "time estimate after the first chunk"; };
  const overallPct = (c) => {
    const done = run.chunks.filter((x) => x.status === "done").length;
    return Math.min(99, ((done + 0.5) / Math.max(run.chunks.length, 1)) * 100);
  };

  const progressLine = (c, mode, extra) => {
    const done = allPosts.length;
    updateProgress(`${chunkLabel(c)}${mode.label}: ${done.toLocaleString()} posts collected · ${leftText(c)}${extra || ""}`, overallPct(c));
  };

  // One chunk: every queue mode, paginated, from the saved cursor.
  const runChunk = async (c) => {
    if (c.ids || c.authors) throw new Error("This kind of run needs the archive reachable from this browser; it is not right now. Resume later from Your runs.");
    const p = run.progress;
    for (let modeIdx = p.modeIdx; modeIdx < plan.queue.length; modeIdx++) {
      const mode = plan.queue[modeIdx];
      let after = modeIdx === p.modeIdx ? p.after : null;
      let modeFetched = modeIdx === p.modeIdx ? p.modeFetched : 0;
      while (modeFetched < limit) {
        progressLine(c, mode);
        const reqBody = {
          subreddit, sort: mode.sort, batchSize: Math.min(batchSize, limit - modeFetched), after,
          includeComments, skipIds: Array.from(seenIds).slice(-200), timeFilter: "all", query: mode.query || "",
        };
        if (c.after) reqBody.afterEpoch = c.after;
        if (c.before) reqBody.beforeEpoch = c.before;
        const batchResp = await apiCall(reqBody);

        if (mode.query) {
          for (const post of batchResp.posts) {
            const existing = byId.get(post.id);
            if (existing && existing.query && !existing.query.split(";").includes(mode.query)) existing.query += ";" + mode.query;
            post.query = mode.query;
          }
        }
        let newPosts = batchResp.posts.filter((post) => !seenIds.has(post.id));
        if (skipNSFW) newPosts = newPosts.filter((post) => !post.over_18);
        if (!includeSelftext) newPosts.forEach((post) => { post.selftext = ""; });
        for (const post of newPosts) { seenIds.add(post.id); byId.set(post.id, post); allPosts.push(post); modeFetched++; c.posts++; }

        if (includeComments) {
          for (const post of newPosts) {
            await completeComments(post, (n) => progressLine(c, mode, ` — finishing a large thread (${n.toLocaleString()} of ~${(post.num_comments || 0).toLocaleString()} comments)`));
          }
        }

        // persistPosts writes the posts BEFORE the run record that carries this
        // advanced cursor, so a crash between the two re-fetches a batch (deduped)
        // rather than skipping one. Keep that order.
        run.progress = { ...run.progress, chunkIdx: c.i, modeIdx, after: batchResp.after, modeFetched };
        await persistPosts(newPosts);

        if (batchResp.done || newPosts.length === 0) break;
        after = batchResp.after;
      }
      run.progress = { ...run.progress, modeIdx: modeIdx + 1, after: null, modeFetched: 0 };
    }
  };

  // ---- Direct path: the browser pages the archive itself ----
  const signal = abortController.signal;
  const sweepable = plan.scope !== "count" && plan.scope !== "ids" && plan.scope !== "authors" && !plan.queue.some((m) => m.query);
  const idSubs = new Set(allPosts.map((p) => p.subreddit).filter(Boolean));
  const nowTs = Math.floor(Date.now() / 1000);
  let reuse = new Map();
  if (includeComments && !resumeId) {
    try { reuse = await RunStore.reusablePosts(subreddit, nowTs - Archive.SETTLE_SECONDS, plan.window); } catch { reuse = new Map(); }
  }
  run.counts.reused = run.counts.reused || 0;

  const finishPost = (post, comments, walked) => {
    const unique = []; const seen = new Set();
    for (const c of comments) if (c.id && !seen.has(c.id)) { seen.add(c.id); delete c.link; unique.push(c); }
    assignDepths(unique);
    post.comments = unique;
    // complete = the archive was walked to the end AND it holds at least 95% of
    // Reddit's count. `comments_walked` separates "we stopped short" from "the
    // archive has less than Reddit reports" (comments deleted before archiving).
    post.comments_walked = walked;
    post.comments_complete = walked && (post.num_comments <= 0 || unique.length >= 0.95 * post.num_comments);
  };

  // Comments are swept ONCE over the run window (chunk by chunk, own window
  // only) and credited to whichever collected post they belong to, so a post
  // keeps receiving late comments from later chunks. A post is finalised once
  // the sweep frontier is 30 days past its creation — or at the very end.
  const openPosts = new Map();      // id → post whose tree is still accumulating
  const seenComments = new Map();   // id → Set of comment ids credited so far
  const openPost = (post) => {
    if (openPosts.has(post.id)) return;
    openPosts.set(post.id, post);
    post.comments = post.comments || [];
    seenComments.set(post.id, new Set(post.comments.map((cm) => cm.id)));
  };
  if (includeComments && sweepable) {
    for (const post of allPosts) {
      if (post.reused) continue;
      if (post.comments_complete === undefined || (post.comments_complete === false && post.comments_walked === false)) openPost(post);
    }
  }
  const creditComments = (comments) => {
    let credited = 0;
    for (const cm of comments) {
      const post = openPosts.get(cm.link);
      if (!post) continue;
      const seen = seenComments.get(post.id);
      if (seen.has(cm.id)) continue;
      seen.add(cm.id);
      delete cm.link;
      post.comments.push(cm);
      credited++;
    }
    return credited;
  };
  // A post may only be finalised once every chunk its settle window touches has
  // been swept. Failed chunks are holes: posts reaching into one stay open, and
  // at the end are persisted as "not fully fetched" so a retry re-opens them.
  const failedRanges = () => run.chunks.filter((x) => x.status === "failed" && x.after != null).map((x) => [x.after, x.before]);
  const touchesFailed = (post) => failedRanges().some(([a, b]) => post.created_utc < b && post.created_utc + Archive.SETTLE_SECONDS > a);
  const sweptThrough = (upTo) => {
    for (const x of run.chunks) { if (x.i >= upTo.i) break; if (x.status !== "done") return x.after; }
    return upTo.before;
  };

  // Finalise open posts whose settle window ended before `frontier` (all of them when force).
  const finalizeOpen = async (frontier, force, label) => {
    const ready = [];
    const heldBack = [];
    for (const post of openPosts.values()) {
      if (touchesFailed(post)) { if (force) heldBack.push(post); continue; }
      if (force || post.created_utc + Archive.SETTLE_SECONDS <= frontier) ready.push(post);
    }
    for (const post of heldBack) {
      post.comments_walked = false;
      post.comments_complete = false; // not fully fetched: a chunk its comments fall into failed
      openPosts.delete(post.id); seenComments.delete(post.id);
    }
    for (let i = 0; i < heldBack.length; i += 200) await persistPosts(heldBack.slice(i, i + 200));
    if (!ready.length) return 0;
    for (const post of ready) { finishPost(post, post.comments, true); openPosts.delete(post.id); seenComments.delete(post.id); }
    const settled = ready.filter((post) => post.comments_complete === true);
    for (let i = 0; i < settled.length; i += 200) await persistPosts(settled.slice(i, i + 200));
    const topups = ready.filter((post) => post.comments_complete !== true && (post.num_comments || 0) > 0);
    let done = 0;
    let batch = [];
    const flush = async () => { const b = batch; batch = []; await persistPosts(b); };
    try {
      await Archive.mapConcurrent(topups, 8, async (post) => {
        const { comments, done: walked } = await Archive.threadComments(post.id, { signal });
        finishPost(post, comments, walked);
        done++;
        batch.push(post);
        if (batch.length >= 25) await flush();
        if (done % 10 === 0 || done === topups.length) updateProgress(`${label}completing threads below Reddit's count — ${done.toLocaleString()} of ${topups.length.toLocaleString()}`, null);
      });
    } finally {
      await flush();
    }
    const rest = ready.filter((post) => !post.comments_offloaded && post.comments_complete !== undefined);
    for (let i = 0; i < rest.length; i += 200) await persistPosts(rest.slice(i, i + 200));
    return ready.length;
  };
  // A stop or crash mid-run must not lose credited comments: persist open posts' partial trees.
  const persistOpen = async () => {
    const open = Array.from(openPosts.values());
    for (let i = 0; i < open.length; i += 200) await persistPosts(open.slice(i, i + 200));
  };

  // Stage 1 for an ID list: the archive returns up to 500 posts per request
  // by id; 100 at a time keeps each request small and the cursor fine-grained.
  const idsStage1 = async (c) => {
    const p = run.progress;
    let done = c.i === p.chunkIdx ? (p.modeFetched || 0) : 0;
    run.missingIds = run.missingIds || [];
    while (done < c.ids.length) {
      const slice = c.ids.slice(done, done + 100);
      const raw = await Archive.get("posts/ids", { ids: slice.join(",") }, { signal });
      const found = new Set();
      const fresh = [];
      for (const r of raw) {
        if (!r || !r.id) continue;
        found.add(r.id);
        const post = window.Mappers.mapPost(r);
        if (seenIds.has(post.id)) continue;
        if (skipNSFW && post.over_18) continue;
        if (!includeSelftext) post.selftext = "";
        if (post.subreddit) idSubs.add(post.subreddit);
        const prior = includeComments ? reuse.get(post.id) : null;
        if (prior) { post.comments = prior.comments; post.comments_complete = true; post.reused = true; run.counts.reused++; }
        seenIds.add(post.id); byId.set(post.id, post); allPosts.push(post); fresh.push(post); c.posts++;
      }
      for (const id of slice) if (!found.has(id) && run.missingIds.length < 20000) run.missingIds.push(id);
      done += slice.length;
      run.progress = { ...run.progress, chunkIdx: c.i, modeIdx: 0, after: null, modeFetched: done };
      run.subreddit = idSubs.size === 1 ? Array.from(idSubs)[0] : idSubs.size > 1 ? "multiple-subreddits" : run.subreddit;
      await persistPosts(fresh);
      progressLine(c, plan.queue[0], ` · ${run.missingIds.length ? `${run.missingIds.length.toLocaleString()} IDs not in archive` : "all IDs found so far"}`);
    }
    run.progress = { ...run.progress, modeIdx: plan.queue.length, after: null, modeFetched: 0 };
  };

  // Stage 1 for an author panel: each author's posts in this community, oldest first
  // (ascending paging is the shape the archive answers fastest for author queries).
  const authorsStage1 = async (c) => {
    const p = run.progress;
    let done = c.i === p.chunkIdx ? (p.modeFetched || 0) : 0;
    while (done < c.authors.length) {
      const name = c.authors[done];
      let after = null;
      const fresh = [];
      for (;;) {
        const params = { author: name, subreddit, limit: 100, sort: "asc" };
        if (after != null) params.after = after;
        const raw = await Archive.get("posts/search", params, { signal });
        for (const r of raw) {
          if (!r || !r.id || seenIds.has(r.id)) continue;
          const post = window.Mappers.mapPost(r);
          if (skipNSFW && post.over_18) continue;
          if (!includeSelftext) post.selftext = "";
          seenIds.add(post.id); byId.set(post.id, post); allPosts.push(post); fresh.push(post); c.posts++;
        }
        if (raw.length < 100) break;
        const last = raw[raw.length - 1].created_utc;
        after = last - 1 === after ? last : last - 1; // re-cover the boundary second; ids dedupe
      }
      done++;
      run.progress = { ...run.progress, chunkIdx: c.i, modeIdx: 0, after: null, modeFetched: done };
      await persistPosts(fresh);
      progressLine(c, plan.queue[0], ` · author ${done} of ${c.authors.length}`);
    }
    run.progress = { ...run.progress, modeIdx: plan.queue.length, after: null, modeFetched: 0 };
  };

  const runChunkDirect = async (c) => {
    const p = run.progress;
    if (c.authors) { await authorsStage1(c); }
    else if (c.ids) { await idsStage1(c); }
    else
    // Stage 1: posts, newest first, cursor persisted per page
    for (let modeIdx = p.modeIdx; modeIdx < plan.queue.length; modeIdx++) {
      const mode = plan.queue[modeIdx];
      let cursor = modeIdx === p.modeIdx ? p.after : null;
      let modeFetched = modeIdx === p.modeIdx ? p.modeFetched : 0;
      let windowAfter = c.after, windowBefore = cursor ?? c.before;
      if (mode.sort === "hot") windowAfter = Math.max(windowAfter ?? 0, nowTs - 7 * 86400);
      if (mode.sort === "rising") windowAfter = Math.max(windowAfter ?? 0, nowTs - 86400);
      const collected = [];
      for await (const page of Archive.walkPostsDesc(subreddit, { after: windowAfter, before: windowBefore, query: mode.query || "", signal })) {
        progressLine(c, mode);
        let fresh = [];
        for (const post of page.posts) {
          if (mode.query) {
            const existing = byId.get(post.id);
            if (existing && existing.query && !existing.query.split(";").includes(mode.query)) existing.query += ";" + mode.query;
            post.query = mode.query;
          }
          if (seenIds.has(post.id)) continue;
          if (skipNSFW && post.over_18) continue;
          if (!includeSelftext) post.selftext = "";
          const prior = includeComments ? reuse.get(post.id) : null;
          if (prior) { post.comments = prior.comments; post.comments_complete = true; post.reused = true; run.counts.reused++; }
          else if (includeComments && sweepable) openPost(post);
          seenIds.add(post.id); byId.set(post.id, post); allPosts.push(post); fresh.push(post); collected.push(post); modeFetched++; c.posts++;
          if (modeFetched >= limit) break;
        }
        run.progress = { ...run.progress, chunkIdx: c.i, modeIdx, after: page.cursor, modeFetched };
        await persistPosts(fresh);
        if (page.done || modeFetched >= limit) break;
      }
      if ((mode.sort === "top" || mode.sort === "controversial") && plan.scope === "count") {
        const key = mode.sort === "top" ? "score" : "num_comments";
        collected.sort((x, y) => (y[key] || 0) - (x[key] || 0));
      }
      run.progress = { ...run.progress, modeIdx: modeIdx + 1, after: null, modeFetched: 0 };
    }

    if (!includeComments) return;
    run.direct = true;

    const tick = (extra) => {
      updateProgress(`${chunkLabel(c)}comments: ${extra} · ${leftText(c)}`, overallPct(c));
    };

    if (sweepable) {
      // Stage 2 (sweep path): comments created inside this chunk's own window,
      // credited to any open post — including posts from earlier chunks.
      let pages = 0, credited = 0;
      RunLog.event("debug", "sweep_start", { chunk: c.i + 1, open_posts: openPosts.size });
      await Archive.shardedSweep(subreddit, { after: c.after, before: c.before, shards: 4, signal, onPage: async (comments) => {
        pages++;
        credited += creditComments(comments);
        if (pages % 5 === 0) tick(`sweeping ${isoDay(c.after + 1)} → ${isoDay(c.before - 1)} — ${credited.toLocaleString()} comments credited · ${openPosts.size.toLocaleString()} posts awaiting their 30-day settle window`);
      } });
      const finalized = await finalizeOpen(sweptThrough(c), false, chunkLabel(c));
      RunLog.event("debug", "sweep_done", { chunk: c.i + 1, pages, comments_credited: credited, posts_finalised: finalized || 0, still_settling: openPosts.size });
      if (finalized) tick(`${finalized.toLocaleString()} posts finalised · ${openPosts.size.toLocaleString()} still settling`);
      await persistOpen();
      return;
    }

    // Stage 2 (per-post path, keyword and newest-N scopes)
    const idSet = c.ids ? new Set(c.ids) : null;
    const authorSet = c.authors ? new Set(c.authors) : null;
    const inChunk = (post) => authorSet ? authorSet.has(post.author) : idSet ? idSet.has(post.id) : (c.after == null || (post.created_utc > c.after && post.created_utc < c.before));
    const pending = allPosts.filter((post) => inChunk(post) && post.comments_complete !== true);
    for (const post of pending) if ((post.num_comments || 0) === 0) finishPost(post, post.comments || [], true);
    const topups = pending.filter((post) => post.comments_complete !== true);
    RunLog.event("debug", "threads_start", { chunk: c.i + 1, posts_in_chunk: pending.length, threads_to_fetch: topups.length });
    let done = 0;
    let batch = [];
    const flush = async () => { const b = batch; batch = []; await persistPosts(b); };
    try {
      await Archive.mapConcurrent(topups, 8, async (post) => {
        const { comments, done: walked } = await Archive.threadComments(post.id, { signal });
        finishPost(post, comments, walked);
        done++;
        batch.push(post);
        if (batch.length >= 25) await flush();
        if (done % 10 === 0 || done === topups.length) tick(`fetching threads — ${done.toLocaleString()} of ${topups.length.toLocaleString()}`);
      });
    } finally {
      await flush();
    }
    const rest = pending.filter((post) => !post.comments_offloaded && post.comments_complete !== undefined);
    for (let i = 0; i < rest.length; i += 200) await persistPosts(rest.slice(i, i + 200));
  };

  let outcome = "complete";
  let chainTo = null;
  try {
    // A Stop can land mid-thread; finish those before fetching anything new.
    for (const post of allPosts) {
      if (post.comments_complete !== false) continue;
      await completeComments(post, (n) => updateProgress(`Resuming: finishing comments for "${post.title.slice(0, 40)}" (${n.toLocaleString()} of ~${(post.num_comments || 0).toLocaleString()})`, null));
      await persistPosts([post]);
    }

    for (const c of run.chunks) {
      if (c.status === "done") continue;
      if (c.i !== run.progress.chunkIdx) run.progress = { ...run.progress, chunkIdx: c.i, modeIdx: 0, after: null, modeFetched: 0 };
      c.status = "running";
      chunkStartedAt = Date.now();
      let attempt = 0;
      const chunkTag = { chunk: `${c.i + 1}/${run.chunks.length}`, from: c.after === null ? null : isoDay(c.after + 1), to: c.before === null ? null : isoDay(c.before - 1) };
      const postsBefore = allPosts.length;
      const reqBefore = Archive.stats.requests;
      RunLog.event("info", "chunk_start", { ...chunkTag, resumed_at: run.progress.after ? isoDay(run.progress.after) : undefined });
      while (true) {
        try {
          if (Archive.isAvailable()) {
            try { await runChunkDirect(c); }
            catch (err) {
              if (err.name === "ArchiveUnavailable") { run.progress = { ...run.progress, modeIdx: 0, after: null, modeFetched: 0 }; await runChunk(c); }
              else throw err;
            }
          } else {
            await runChunk(c);
          }
          c.status = "done";
          c.error = "";
          chunkTimes.push(Date.now() - chunkStartedAt);
          RunLog.event("info", "chunk_done", { ...chunkTag, ms: Date.now() - chunkStartedAt, posts: allPosts.length - postsBefore, posts_total: allPosts.length, comments_total: run.counts.comments, requests: Archive.stats.requests - reqBefore, path: run.direct ? "browser→archive" : "server", attempts: attempt + 1 });
          break;
        } catch (err) {
          if (err.name === "AbortError") throw err;
          attempt++;
          c.error = String(err.message || err).slice(0, 200);
          RunLog.event("error", "chunk_error", { ...chunkTag, attempt, ...RunLog.errorInfo(err), posts_total: allPosts.length });
          if (attempt >= CHUNK_ATTEMPTS) {
            c.status = "failed";
            outcome = "complete_with_gaps";
            RunLog.event("error", "chunk_failed", { ...chunkTag, after_attempts: attempt });
            break;
          }
          const wait = 20000 * attempt;
          updateProgress(`${chunkLabel(c)}problem (${c.error}) — retrying in ${wait / 1000}s (attempt ${attempt + 1} of ${CHUNK_ATTEMPTS})…`, null);
          await new Promise((resolve, reject) => {
            const signal = abortController.signal;
            const onAbort = () => { clearTimeout(t); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); };
            const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, wait);
            signal.addEventListener("abort", onAbort, { once: true });
          });
        }
      }
      run.progress = { ...run.progress, chunkIdx: c.i + 1, modeIdx: 0, after: null, modeFetched: 0 };
      await RunStore.saveRun(run);
      renderRunsPanel();
    }

    // Tail: comments that arrived after the run window closed, for posts still settling.
    if (includeComments && sweepable && run.direct && Archive.isAvailable() && plan.window && run.progress.tail !== "done") {
      const tailAfter = plan.window.before;
      const tailBefore = Math.min(nowTs + 1, plan.window.before + Archive.SETTLE_SECONDS + 1);
      if (openPosts.size > 0 && tailBefore > tailAfter + 1) {
        let pages = 0, credited = 0;
        await Archive.shardedSweep(subreddit, { after: tailAfter, before: tailBefore, shards: 4, signal, onPage: async (comments) => {
          pages++;
          credited += creditComments(comments);
          if (pages % 5 === 0) updateProgress(`Late comments after the window: ${credited.toLocaleString()} credited to ${openPosts.size.toLocaleString()} settling posts`, 99);
        } });
      }
      await finalizeOpen(Infinity, true, "");
      run.progress = { ...run.progress, tail: "done" };
      await RunStore.saveRun(run);
    }

    run.status = outcome;
    run.finishedAt = Date.now();
    const st = await runStats(run.id, subreddit);
    run.counts = { ...run.counts, posts: st.total_posts, comments: st.total_comments };
    RunLog.event("info", "finished", { status: outcome, posts: st.total_posts, comments: st.total_comments, incomplete_comment_posts: st.incomplete.length, session_min: Math.round((Date.now() - runStartedAt) / 60000),
      archive_requests: Archive.stats.requests - archiveStatsAt.requests, archive_retries: Archive.stats.retries - archiveStatsAt.retries, archive_shed: Archive.stats.shed - archiveStatsAt.shed, waited_min: Math.round((run.logStats?.waitMs || 0) / 60000) });
    run.manifest = buildManifest(run, st);
    await RunStore.saveRun(run);
    updateProgress(outcome === "complete" ? "Done — every chunk finished." : "Done with gaps — some chunks failed; see the run status below.", 100);
    scrapeResult = { subreddit, posts: null, preview: st.preview, keywordsEnabled: false, summary: statsToSummary(st), stats: st, run };
    showResults(scrapeResult);
    // The file is what the researcher must not lose: hand it over without asking.
    const est = estimateExportBytes(st);
    if (st.total_posts > 0) await exportRun(run, "combined", { gzip: !!(est && est.combined >= GZIP_DEFAULT_FROM_BYTES) });
    chainTo = await nextQueuedRun(run);
    if (chainTo) RunLog.event("info", "chain", { next: chainTo.plan.segment || chainTo.id });
    if (chainTo) updateProgress(`Run ${run.batch.index + 1} of ${run.batch.total} done and downloaded — starting ${chainTo.plan.segment || "the next run"}…`, 100);
  } catch (err) {
    const stopped = err.name === "AbortError";
    try { await persistOpen(); } catch { /* best effort */ }
    run.status = stopped ? "stopped" : "failed";
    const st = await runStats(run.id, subreddit);
    run.counts = { ...run.counts, posts: st.total_posts, comments: st.total_comments };
    RunLog.event(stopped ? "warn" : "error", stopped ? "stopped" : "failed", { ...(stopped ? {} : RunLog.errorInfo(err)), posts: st.total_posts, comments: st.total_comments, chunk: run.progress.chunkIdx + 1, session_min: Math.round((Date.now() - runStartedAt) / 60000),
      archive_requests: Archive.stats.requests - archiveStatsAt.requests, archive_shed: Archive.stats.shed - archiveStatsAt.shed, waited_min: Math.round((run.logStats?.waitMs || 0) / 60000) });
    run.manifest = buildManifest(run, st);
    await RunStore.saveRun(run);
    if (!stopped) showError(err.message);
    if (st.total_posts > 0) {
      scrapeResult = { subreddit, posts: null, preview: st.preview, keywordsEnabled: false, summary: statsToSummary(st), stats: st, run };
      updateProgress(`${stopped ? "Stopped" : "Failed"} at ${allPosts.length.toLocaleString()} posts — saved; Resume continues from here.`, (allPosts.length / Math.max(expectedTotal, 1)) * 100);
      showResults(scrapeResult);
    } else {
      updateProgress(`${stopped ? "Stopped" : "Failed"} — no posts were collected yet.`, null);
    }
    if (!stopped) progressSection.classList.add("hidden");
  } finally {
    scrapeBtn.classList.remove("hidden");
    stopBtn.classList.add("hidden");
    abortController = null;
    try { await RunStore.saveRun(run); } catch { /* best effort */ }
    RunLog.detach();
    renderRunsPanel();
    if (scrapeResult && scrapeResult.run && scrapeResult.run.id === run.id) renderRunLog(run);
  }
  if (chainTo) {
    await new Promise((r) => setTimeout(r, 1500));
    await startScrape({ resumeId: chainTo.id });
  }
}

// Leaving the page while a run is active pauses it; browsers show their own
// confirmation when a handler sets returnValue, so the user can stay.
window.addEventListener("beforeunload", (e) => {
  if (!abortController) return;
  e.preventDefault();
  e.returnValue = "A collection is running in this tab. Leaving pauses it; you can resume from Your runs.";
});

stopBtn.addEventListener("click", () => {
  if (abortController) abortController.abort();
});

// While the archive sheds load the client backs off for up to half a minute
// per attempt; say so rather than leave the last progress line frozen.
if (typeof Archive !== "undefined") {
  Archive.onWait = (why, attempt, ms) => {
    RunLog.wait(why, attempt, ms);
    if (!abortController) return;
    const base = statusText.textContent.replace(/\s*·\s*archive busy.*$/, "");
    statusText.textContent = `${base} · archive busy (${why}), retry ${attempt} in ${Math.round(ms / 1000)}s`;
  };
}

renderRunsPanel();

// --- Study discovery: plain-text description -> verified communities + keywords ---
let pendingKeywords = null;
let discovery = null;

const discoverBtn = document.getElementById("discoverBtn");
const discoverResults = document.getElementById("discoverResults");

discoverBtn.addEventListener("click", async () => {
  const description = document.getElementById("studyDescription").value.trim();
  if (description.length < 20) {
    showError("Describe the study in at least a sentence: the phenomenon, who talks about it, and any time or language limits.");
    return;
  }
  errorSection.classList.add("hidden");
  discoverBtn.disabled = true;
  discoverBtn.querySelector(".btn-text").textContent = "Thinking… (10–20 s)";
  try {
    const resp = await fetch("/api/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `Server error (${resp.status})`);
    discovery = data;
    renderDiscovery(data);
  } catch (err) {
    showError(err.message);
  } finally {
    discoverBtn.disabled = false;
    discoverBtn.querySelector(".btn-text").textContent = "Suggest communities & keywords";
  }
});

function fmtCount(n) {
  if (!n) return "0";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e4) return Math.round(n / 1e3) + "k";
  return n.toLocaleString();
}

function renderDiscovery(data) {
  const verified = data.communities.filter((c) => c.exists);
  const missing = data.communities.filter((c) => !c.exists);
  const rows = data.communities.map((c, i) => {
    const since = c.earliest_post ? new Date(c.earliest_post * 1000).getFullYear() : "";
    return `<tr class="${c.exists ? "" : "missing"}">
      <td><input type="checkbox" class="disc-sub" data-i="${i}" ${c.exists && c.archived_posts > 0 ? "checked" : "disabled"} /></td>
      <td><strong>r/${escapeHtml(c.name)}</strong>${c.over18 ? ' <span class="badge">NSFW</span>' : ""}<br><span class="estimate-label" style="text-transform:none">${escapeHtml(c.role)} · ${escapeHtml(c.why)}</span></td>
      <td class="num">${c.exists ? fmtCount(c.subscribers) : "—"}</td>
      <td class="num">${c.exists ? fmtCount(c.archived_posts) : "not in archive"}</td>
      <td class="num">${c.exists ? fmtCount(c.archived_comments) : ""}</td>
      <td class="num">${since}</td>
      <td>${c.exists ? `<button type="button" class="link-button disc-analyze" data-name="${escapeHtml(c.name)}">Analyze</button>` : ""}</td>
    </tr>`;
  }).join("");

  // The archive has no OR: each alternative runs as its own search, so show it
  // as its own chip — a bare word like "wife" is then visible and can be unticked.
  const chips = [];
  data.keywords.forEach((k, i) => {
    for (const term of k.query.split(/\s+OR\s+/i)) {
      const t = term.trim();
      if (!t) continue;
      const bare = !/"/.test(t) && t.split(/\s+/).length === 1;
      chips.push({ i, term: t, why: k.why, bare });
    }
  });
  const keywords = chips.map((c, j) => `
    <label class="discover-keyword${c.bare ? " discover-keyword-bare" : ""}" title="${escapeHtml(c.why)}${c.bare ? " — single bare word: matches every post containing it" : ""}">
      <input type="checkbox" class="disc-kw" data-term="${escapeHtml(c.term)}" ${c.bare ? "" : "checked"} /> <code>${escapeHtml(c.term)}</code>${c.bare ? " <span class=\"badge\">bare word</span>" : ""}
    </label>`).join("");

  discoverResults.innerHTML = `
    <h3>Communities — ${verified.length} verified in the archive${missing.length ? `, ${missing.length} suggested but not found` : ""}</h3>
    <div class="discover-table-wrap"><table class="discover-table">
      <thead><tr><th></th><th>Community</th><th class="num">Members</th><th class="num">Archived posts</th><th class="num">Comments</th><th class="num">Since</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <h3>Keyword searches — ${chips.length} (each chip is one search; counts appear once you Analyze a community)</h3>
    <div class="discover-keywords">${keywords}</div>
    ${data.exclude_terms.length ? `<p class="limit-note">Suggested exclude terms for the CLI's --filter: ${data.exclude_terms.map(escapeHtml).join(", ")}</p>` : ""}
    ${data.caveats.length ? `<h3>Caveats to address in the methods</h3><ul class="discover-caveats">${data.caveats.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>` : ""}
    <div class="discover-actions">
      <button type="button" class="btn-analyze" id="discUseBtn"><span class="btn-text">Use selected keywords here</span></button>
      <button type="button" class="btn-analyze" id="discYamlBtn"><span class="btn-text">Download study file for the CLI</span></button>
      <span class="limit-note">The web app collects one community at a time; the study file runs all selected ones.</span>
    </div>
  `;
  discoverResults.classList.remove("hidden");

  discoverResults.querySelectorAll(".disc-analyze").forEach((btn) => {
    btn.addEventListener("click", () => {
      pendingKeywords = selectedKeywords();
      document.getElementById("subreddit").value = btn.dataset.name;
      analyzeBtn.click();
      document.getElementById("subreddit").scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });
  document.getElementById("discUseBtn").addEventListener("click", () => {
    const kws = selectedKeywords();
    if (optionsPanel.classList.contains("hidden")) {
      pendingKeywords = kws;
      showError("Keywords saved — now Analyze a community (click Analyze in the table) and they will be filled in.");
    } else {
      document.getElementById("keywords").value = kws.join("\n");
      updateCollectionEstimate();
      optionsPanel.scrollIntoView({ behavior: "smooth" });
    }
  });
  document.getElementById("discYamlBtn").addEventListener("click", () => {
    downloadFile(buildStudyYaml(data, selectedCommunities(), selectedKeywords()), "study.yaml", "text/yaml");
  });
}

function selectedKeywords() {
  return Array.from(discoverResults.querySelectorAll(".disc-kw:checked")).map((el) => el.dataset.term);
}

function selectedCommunities() {
  return Array.from(discoverResults.querySelectorAll(".disc-sub:checked")).map((el) => discovery.communities[Number(el.dataset.i)].name);
}

function yamlQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// A study file the command-line tool runs as-is; the description travels with it.
function buildStudyYaml(data, subs, keywords) {
  const lines = [
    "# Generated by LemonSqueeze study discovery on " + new Date().toISOString().slice(0, 10),
    "# Suggestions came from " + data.model + "; communities below were verified in the archive.",
    "# Description:",
    ...data.description.split(/\r?\n/).map((l) => "#   " + l),
    "",
    "name: my_study",
    "subreddits: [" + subs.join(", ") + "]",
    "queries:",
    ...keywords.map((q) => "  - " + yamlQuote(q)),
    "exclude_terms: [" + data.exclude_terms.map(yamlQuote).join(", ") + "]",
    "date_from: null            # e.g. 2024-01-01 or '2 years ago'",
    "date_to: null",
    "sources: [arctic_shift]",
    "comment_mode: settled",
    "comment_settle_hours: 72",
    "anonymise_authors: true",
    "",
  ];
  return lines.join("\n");
}

// --- Results display ---
const pctText = (x) => (x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0) + "%";

// What is left of the content: most text analyses silently run on the intact share only.
function renderContentAvailability(desc) {
  const box = document.getElementById("contentAvailability");
  if (!desc || !desc.posts) { box.classList.add("hidden"); return; }
  const b = desc.content.post_bodies, c = desc.content.comment_bodies;
  const low = b.intact_share < 0.5;
  document.getElementById("contentSummary").innerHTML =
    `<strong>Post bodies: ${pctText(b.intact_share)} intact</strong> · ${pctText(b.removed_share)} removed by moderators or Reddit · ${pctText(b.deleted_share)} deleted by the author · ${pctText(b.empty_share)} empty (title or link only)` +
    (desc.comments ? ` · <strong>comments: ${pctText(c.intact_share)} intact</strong>` : "") +
    ` · authors deleted: ${pctText(desc.content.post_author_deleted_share)} of posts` +
    (low ? ` <span class="estimate-warn">Fewer than half of the post bodies can be read. Report this share; text analyses describe the surviving posts, not the community.</span>` : "");
  document.getElementById("contentTable").innerHTML = `<table class="design-table"><thead><tr><th>month</th><th>posts</th><th>intact</th><th>removed</th><th>deleted</th><th>empty</th><th>intact share</th></tr></thead><tbody>` +
    desc.months.map((m) => `<tr><td>${escapeHtml(m.month)}</td><td>${m.posts.toLocaleString()}</td><td>${m.intact.toLocaleString()}</td><td>${m.removed.toLocaleString()}</td><td>${m.deleted.toLocaleString()}</td><td>${m.empty.toLocaleString()}</td><td>${pctText(m.intact_share)}</td></tr>`).join("") + `</tbody></table>`;
  box.classList.remove("hidden");
}

// Authors: concentration at a glance, pseudonymised exports, the authors table, and an author panel.
function renderAuthors(desc, run) {
  const box = document.getElementById("authorsBlock");
  if (!desc || !desc.authors || !desc.authors.unique || !run) { box.classList.add("hidden"); return; }
  const a = desc.authors;
  document.getElementById("authorsSummary").innerHTML = `<strong>Authors: ${a.unique.toLocaleString()}${a.truncated ? "+" : ""} accounts</strong> · the 10 most active wrote ${pctText(a.top10_share)} of all posts and comments · the top 1% wrote ${pctText(a.top1pct_share)}`;
  const panelOk = run.subreddit && !["by-id", "multiple-subreddits"].includes(run.subreddit);
  document.getElementById("authorPanelRow").classList.toggle("hidden", !panelOk);
  // an author panel is about individuals: its exports are pseudonymised unless the researcher decides otherwise
  if (run.plan.scope === "authors") document.getElementById("pseudoToggle").checked = true;
  updateSaltNote();
  updatePanelCount();
  box.dataset.runId = run.id;
  box.classList.remove("hidden");
}

function updateSaltNote() {
  const info = window.Pseudo.loadOrCreateSalt(localStorage);
  document.getElementById("saltNote").textContent = info.persistent
    ? "A secret salt in this browser makes the pseudonyms; the same salt gives the same pseudonym for the same account, here and in the command-line tool. Copy it somewhere safe and share it only with co-authors — without it, new data cannot be linked to old pseudonyms."
    : "Browser storage is blocked, so the salt lasts only until this tab closes: pseudonyms will not match between sessions.";
}

// name → { posts, comments } for one run, read from the store
async function authorTable(runId) {
  const agg = window.RunStats.createRunStats();
  await RunStore.iteratePosts(runId, 500, async (batch) => { for (const p of batch) agg.add(p); });
  return agg.authorRows();
}

let panelAuthors = [];
async function updatePanelCount() {
  const id = document.getElementById("authorsBlock").dataset.runId || (scrapeResult && scrapeResult.run && scrapeResult.run.id);
  const out = document.getElementById("authorPanelCount");
  if (!id) return;
  const min = Math.max(1, parseInt(document.getElementById("authorPanelMin").value, 10) || 1);
  // the table is read from the store asynchronously: a slower, older call must not overwrite a newer one
  const seq = (updatePanelCount.seq = (updatePanelCount.seq || 0) + 1);
  document.getElementById("authorPanelBtn").disabled = true;
  const table = await authorTable(id);
  if (seq !== updatePanelCount.seq) return;
  const rows = table.filter((r) => r.posts >= min).sort((x, y) => y.posts - x.posts);
  panelAuthors = rows.slice(0, 2000).map((r) => r.name);
  out.textContent = `${rows.length.toLocaleString()} account${rows.length === 1 ? "" : "s"}${rows.length > 2000 ? " (the 2,000 most active are used)" : ""}`;
  document.getElementById("authorPanelBtn").disabled = panelAuthors.length === 0 || !!abortController;
}

document.getElementById("authorPanelMin").addEventListener("input", () => { clearTimeout(updatePanelCount.t); updatePanelCount.t = setTimeout(updatePanelCount, 400); });
document.getElementById("authorPanelBtn").addEventListener("click", () => {
  const run = scrapeResult && scrapeResult.run;
  if (!run || !panelAuthors.length) return;
  if (!confirm(`Collect every post these ${panelAuthors.length.toLocaleString()} accounts made in r/${run.subreddit}?\n\nThis builds a record of what individual people wrote. Check that your ethics approval covers account-level data. Exports will be pseudonymised by default.`)) return;
  startAuthorRun(run.subreddit, panelAuthors.slice(), { includeComments: document.getElementById("authorPanelComments").checked,
    design: { kind: "author_panel", source_run: run.id, min_posts: Math.max(1, parseInt(document.getElementById("authorPanelMin").value, 10) || 1), authors: panelAuthors.length } });
});
document.getElementById("authorsCsv").addEventListener("click", async () => {
  const run = scrapeResult && scrapeResult.run;
  if (!run) return;
  const rows = (await authorTable(run.id)).sort((x, y) => (y.posts + y.comments) - (x.posts + x.comments));
  const usePseudo = document.getElementById("pseudoToggle").checked;
  let nameOf = (n) => n;
  if (usePseudo) { const p = window.Pseudo.createPseudonymiser(window.Pseudo.loadOrCreateSalt(localStorage).salt); await p.learn(rows.map((r) => r.name)); nameOf = p.of; }
  const total = rows.reduce((n, r) => n + r.posts + r.comments, 0) || 1;
  const lines = [["author", "posts", "comments", "total", "share_of_all", "pseudonymised"].join(",")];
  for (const r of rows) lines.push([nameOf(r.name), r.posts, r.comments, r.posts + r.comments, ((r.posts + r.comments) / total).toFixed(6), usePseudo ? "TRUE" : "FALSE"].map(csvEscape).join(","));
  downloadFile(lines.join("\n") + "\n", `${exportBaseName(run)}_authors.csv`, "text/csv");
});
document.getElementById("saltCopy").addEventListener("click", async () => {
  const salt = window.Pseudo.loadOrCreateSalt(localStorage).salt;
  const out = document.getElementById("saltStatus");
  try { await navigator.clipboard.writeText(salt); out.textContent = "Salt copied to the clipboard. Treat it like a password."; }
  catch { out.textContent = "Clipboard blocked — use Import to type a salt you already have instead."; }
});
document.getElementById("saltImport").addEventListener("click", () => {
  const v = prompt("Paste the salt (32–128 hexadecimal characters; the CLI keeps it in data/<study>/.salt). This replaces the salt in this browser.");
  if (v === null) return;
  const out = document.getElementById("saltStatus");
  try { window.Pseudo.importSalt(localStorage, v); out.textContent = "Salt replaced. New downloads use it."; } catch (e) { out.textContent = e.message; }
});

function renderRunLog(run) {
  const box = document.getElementById("runLog");
  if (!run || !run.log || !run.log.length) { box.classList.add("hidden"); return; }
  const sm = RunLog.summary(run);
  const parts = [`<strong>Run log</strong> — ${sm.events} events`];
  if (sm.errors) parts.push(`<strong>${sm.errors} error${sm.errors > 1 ? "s" : ""}</strong>`);
  if (sm.wall_time_min != null) parts.push(`${sm.wall_time_min} min wall time`);
  if (sm.archive_waits) parts.push(`archive back-offs: ${sm.archive_waits} (${sm.archive_waited_min} min waiting${sm.archive_shed ? `, ${sm.archive_shed} load-shed` : ""})`);
  if (sm.chunks_done) parts.push(`${sm.chunks_done} chunks, avg ${sm.chunk_avg_min} min${sm.slowest_chunk ? `, slowest ${sm.slowest_chunk.minutes} min (chunk ${sm.slowest_chunk.chunk})` : ""}`);
  if (sm.last_error) parts.push(`last error: ${escapeHtml(String(sm.last_error.error || sm.last_error.type).slice(0, 80))}`);
  document.getElementById("runLogSummary").innerHTML = parts.join(" · ");
  document.getElementById("runLogText").textContent = RunLog.text(run, 400);
  document.getElementById("runLogSent").textContent = "";
  box.classList.remove("hidden");
  box.dataset.runId = run.id;
}

document.getElementById("runLogDownload").addEventListener("click", async () => {
  const id = document.getElementById("runLog").dataset.runId;
  const run = (currentRun && currentRun.id === id) ? currentRun : await RunStore.getRun(id);
  if (!run) return;
  downloadFile(JSON.stringify(RunLog.report(run), null, 2), `${exportBaseName(run)}_run_log.json`, "application/json");
});
document.getElementById("runLogSend").addEventListener("click", async () => {
  const id = document.getElementById("runLog").dataset.runId;
  const run = (currentRun && currentRun.id === id) ? currentRun : await RunStore.getRun(id);
  const out = document.getElementById("runLogSent");
  if (!run) return;
  out.textContent = "Sending…";
  try {
    const resp = await fetch("/api/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(RunLog.report(run)) });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    out.textContent = `Sent — reference ${data.id}. Quote it when you report the problem.`;
    RunLog.event("info", "log_sent", { reference: data.id });
  } catch (err) {
    out.textContent = `Could not send (${err.message}). Download the log and attach it instead.`;
  }
});

function showResults(data) {
  resultsSection.classList.remove("hidden");
  const s = data.summary;

  const summaryDiv = document.getElementById("summary");
  let statsHtml = `
    <div class="stat-card"><div class="value">${s.total_posts.toLocaleString()}</div><div class="label">Posts</div></div>
    <div class="stat-card"><div class="value">${s.total_comments.toLocaleString()}</div><div class="label">Comments</div></div>
    <div class="stat-card"><div class="value">${s.total_score.toLocaleString()}</div><div class="label">Total score</div></div>
  `;
  if (s.posts_not_fully_fetched) {
    statsHtml += `<div class="stat-card"><div class="value">${s.posts_not_fully_fetched}</div><div class="label">Threads not fully fetched (resume to finish)</div></div>`;
  }
  if (s.posts_archive_below_reddit_count) {
    statsHtml += `<div class="stat-card"><div class="value">${s.posts_archive_below_reddit_count}</div><div class="label">Threads where the archive holds &lt;95% of Reddit's count (nothing more to fetch)</div></div>`;
  }
  if (s.posts_with_keyword_matches !== undefined) {
    statsHtml += `<div class="stat-card"><div class="value">${s.posts_with_keyword_matches}</div><div class="label">Keyword matches</div></div>`;
  }
  if (s.posts_per_category) {
    for (const [cat, count] of Object.entries(s.posts_per_category)) {
      statsHtml += `<div class="stat-card"><div class="value">${count}</div><div class="label">${formatCategory(cat)}</div></div>`;
    }
  }
  summaryDiv.innerHTML = statsHtml;

  const sizes = document.getElementById("exportSizes");
  const est = data.stats ? estimateExportBytes(data.stats) : null;
  const gz = document.getElementById("gzipToggle");
  if (est) {
    const big = est.combined >= GZIP_DEFAULT_FROM_BYTES;
    gz.checked = big;
    sizes.innerHTML = `Approximate sizes — <strong>Combined CSV ≈ ${fmtBytes(est.combined)}</strong> · Posts CSV ≈ ${fmtBytes(est.posts)} · Comments CSV ≈ ${fmtBytes(est.comments)}${big ? `. The combined file repeats each post's text on every comment row; for a run this size, <strong>Posts CSV + Comments CSV</strong> (join on <code>post_id</code>) hold the same 44 columns without the repetition.` : ""}`;
  } else {
    sizes.textContent = "";
    if (gz) gz.checked = false;
  }
  const statusEl = document.getElementById("runStatus");
  const run = data.run;
  renderRunLog(run);
  renderContentAvailability(data.stats ? data.stats.desc : null);
  renderAuthors(data.stats ? data.stats.desc : null, run);
  if (run) {
    const failed = run.chunks.filter((c) => c.status === "failed");
    const chunksNote = run.chunks.length > 1 ? ` ${run.chunks.filter((c) => c.status === "done").length} of ${run.chunks.length} time chunks finished.` : "";
    const gaps = failed.length ? ` Missing: ${failed.map((c) => `${isoDay(c.after + 1)} → ${isoDay(c.before - 1)}`).join(", ")} — use "Retry failed chunks" in Your runs.` : "";
    const saved = RunStore.isPersistent() ? " Saved in this browser; the combined CSV was downloaded automatically when the run finished." : "";
    statusEl.innerHTML = `<span class="run-badge ${statusClass(run.status)}">${statusLabel(run.status)}</span>r/${escapeHtml(run.subreddit)} · ${escapeHtml(scopeText(run.plan))}.${chunksNote}${gaps}${run.status === "complete" || run.status === "complete_with_gaps" ? saved : " Resume continues from the saved cursor."}`;
    document.getElementById("resultsSubtitle").textContent = run.status === "complete"
      ? "Your dataset is ready. Keep the run report with the data."
      : run.status === "complete_with_gaps" ? "Finished, but some time chunks are missing — retry them before you analyse."
      : "Partial dataset — you can download it now and resume later.";
  } else {
    statusEl.innerHTML = "";
  }

  // Preview
  const previewDiv = document.getElementById("preview");
  const previewPosts = data.preview || (data.posts || []).slice(0, 5);
  previewDiv.innerHTML = previewPosts
    .map(
      (p) => `
    <div class="preview-post">
      <h3><a href="${p.permalink}" target="_blank" rel="noopener">${escapeHtml(p.title)}</a></h3>
      <div class="meta">u/${escapeHtml(p.author)} &middot; ${p.score} pts &middot; ${p.num_comments} comments &middot; ${new Date(p.created_datetime).toLocaleDateString()}${p.link_flair_text ? ` &middot; <span class="badge">${escapeHtml(p.link_flair_text)}</span>` : ""}</div>
      ${
        p.matched_categories && p.matched_categories.length > 0
          ? `<div class="categories">${p.matched_categories.map((c) => `<span class="badge">${formatCategory(c)}</span>`).join("")}</div>`
          : ""
      }
    </div>
  `
    )
    .join("");
}

function formatCategory(cat) {
  return cat.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// --- Computed columns for analysis ---
function wordCount(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function toDateParts(isoString) {
  if (!isoString) return { date: "", day_of_week: "", hour: "" };
  const d = new Date(isoString);
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return {
    date: d.toISOString().slice(0, 10),
    day_of_week: days[d.getUTCDay()],
    hour: d.getUTCHours(),
  };
}

// --- Download Handlers ---
document.getElementById("downloadJson").addEventListener("click", async () => {
  if (!scrapeResult) return;
  if (scrapeResult.run) { await exportRun(scrapeResult.run, "json", { gesture: true, gzip: document.getElementById("gzipToggle").checked }); return; }
  downloadFile(JSON.stringify(scrapeResult.posts, null, 2), `${exportBaseNameFor(scrapeResult)}_full.json`, "application/json");
});

document.getElementById("downloadManifest").addEventListener("click", async () => {
  if (!scrapeResult) return;
  const run = scrapeResult.run;
  const manifest = run ? (run.manifest || buildManifest(run, await runStats(run.id))) : { note: "no run metadata (thread download)" };
  downloadFile(JSON.stringify(manifest, null, 2), `${exportBaseNameFor(scrapeResult)}_run_report.json`, "application/json");
});

document.getElementById("downloadCsv").addEventListener("click", async () => {
  if (!scrapeResult) return;
  if (scrapeResult.run) { await exportRun(scrapeResult.run, "posts", { gesture: true, gzip: document.getElementById("gzipToggle").checked }); return; }
  const csv = postsToCSV(scrapeResult.posts, scrapeResult.keywordsEnabled);
  downloadFile(csv, `${exportBaseNameFor(scrapeResult)}_posts.csv`, "text/csv");
});

document.getElementById("downloadCommentsCsv").addEventListener("click", async () => {
  if (!scrapeResult) return;
  if (scrapeResult.run) { await exportRun(scrapeResult.run, "comments", { gesture: true, gzip: document.getElementById("gzipToggle").checked }); return; }
  const csv = commentsToCSV(scrapeResult.posts, scrapeResult.keywordsEnabled);
  downloadFile(csv, `${exportBaseNameFor(scrapeResult)}_comments.csv`, "text/csv");
});

document.getElementById("downloadPack").addEventListener("click", async () => {
  if (!scrapeResult || !scrapeResult.run) return;
  await downloadMethodsPack([scrapeResult.run]);
});

for (const [buttonId, kind] of [["downloadEdges", "edges"], ["downloadThreads", "threads"]]) {
  document.getElementById(buttonId).addEventListener("click", async () => {
    if (!scrapeResult) return;
    if (scrapeResult.run) { await exportRun(scrapeResult.run, kind, { gesture: true, gzip: document.getElementById("gzipToggle").checked }); return; }
    const csv = EXPORTERS[kind].fn(scrapeResult.posts, false, {});
    downloadFile(csv + "\n", `${exportBaseNameFor(scrapeResult)}_${EXPORTERS[kind].suffix}`, "text/csv");
  });
}

document.getElementById("downloadCombinedCsv").addEventListener("click", async () => {
  if (!scrapeResult) return;
  if (scrapeResult.run) { await exportRun(scrapeResult.run, "combined", { gesture: true, gzip: document.getElementById("gzipToggle").checked }); return; }
  const csv = combinedToCSV(scrapeResult.posts, scrapeResult.keywordsEnabled);
  downloadFile(csv, `${exportBaseNameFor(scrapeResult)}_combined.csv`, "text/csv");
});

function downloadFile(content, filename, mimeType) {
  const blob = new Blob(Array.isArray(content) ? content : [content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  // Revoking at once breaks large downloads: the browser may not have started
  // reading the blob yet. Keep the URL alive well past the hand-over.
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 10 * 60 * 1000);
}

function csvEscape(val) {
  if (val === null || val === undefined) return "";
  const str = String(val);
  // a bare carriage return ends a record for every CSV reader, so it must be quoted too
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function postsToCSV(posts, keywordsEnabled, opts = {}) {
  const headers = [
    "id", "subreddit", "title", "selftext", "author",
    "created_utc", "created_datetime", "date", "day_of_week", "hour_utc",
    "score", "score_as_of", "upvote_ratio", "num_comments", "permalink",
    "link_flair_text", "over_18",
    "edited", "distinguished", "is_crosspost", "crosspost_subreddit",
    "total_awards_received", "gilded",
    "title_word_count", "selftext_word_count",
    "title_char_count", "selftext_char_count", "comment_count_actual", "comments_complete", "query",
  ];
  if (keywordsEnabled) {
    headers.push("relevance_score", "matched_categories", "matched_keywords");
  }

  // extra trailing columns: constant per file (opts.extra, e.g. run_label) and per post (opts.extraCols + opts.extraFor, e.g. sample_group)
  const extraBase = opts.extra || {};
  headers.push(...Object.keys(extraBase), ...(opts.extraCols || []));
  const rows = posts.map((p) => {
    const extra = opts.extraFor ? { ...extraBase, ...(opts.extraFor(p) || {}) } : extraBase;
    const dp = toDateParts(p.created_datetime);
    const row = {
      id: p.id,
      subreddit: p.subreddit ?? opts.subreddit ?? scrapeResult?.subreddit ?? "",
      title: p.title,
      selftext: p.selftext,
      author: p.author,
      created_utc: p.created_utc,
      created_datetime: p.created_datetime,
      date: dp.date,
      day_of_week: dp.day_of_week,
      hour_utc: dp.hour,
      score: p.score,
      score_as_of: p.score_as_of || "",
      upvote_ratio: p.upvote_ratio,
      num_comments: p.num_comments,
      permalink: p.permalink,
      link_flair_text: p.link_flair_text || "",
      over_18: p.over_18 || false,
      edited: p.edited || false,
      distinguished: p.distinguished || "",
      is_crosspost: p.is_crosspost || false,
      crosspost_subreddit: p.crosspost_subreddit || "",
      total_awards_received: p.total_awards_received || 0,
      gilded: p.gilded || 0,
      title_word_count: wordCount(p.title),
      selftext_word_count: wordCount(p.selftext),
      title_char_count: (p.title || "").length,
      selftext_char_count: (p.selftext || "").length,
      comment_count_actual: (p.comments || []).length,
      comments_complete: p.comments_complete === undefined ? "" : p.comments_complete,
      query: p.query || "",
    };
    if (keywordsEnabled) {
      row.relevance_score = p.relevance_score || 0;
      row.matched_categories = (p.matched_categories || []).join("; ");
      row.matched_keywords = JSON.stringify(p.matched_keywords || {});
    }
    return headers.map((h) => csvEscape(h in row ? row[h] : extra[h])).join(",");
  });

  return (opts.header === false ? rows : [headers.join(","), ...rows]).join("\n");
}

function combinedToCSV(posts, keywordsEnabled, opts = {}) {
  const headers = [
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
  ];
  if (keywordsEnabled) {
    headers.push("post_relevance_score", "post_matched_categories", "post_matched_keywords",
                  "comment_relevance_score", "comment_matched_categories", "comment_matched_keywords");
  }

  // extra trailing columns, e.g. run_label/run_id in a merged export
  const extraBase = opts.extra || {};
  headers.push(...Object.keys(extraBase), ...(opts.extraCols || []));
  const rows = [];
  for (const p of posts) {
    const extra = opts.extraFor ? { ...extraBase, ...(opts.extraFor(p) || {}) } : extraBase;
    const pdp = toDateParts(p.created_datetime);
    const postFields = {
      post_id: p.id,
      subreddit: p.subreddit ?? opts.subreddit ?? scrapeResult?.subreddit ?? "",
      post_title: p.title,
      post_selftext: p.selftext,
      post_author: p.author,
      post_created_utc: p.created_utc,
      post_created_datetime: p.created_datetime,
      post_date: pdp.date,
      post_day_of_week: pdp.day_of_week,
      post_hour_utc: pdp.hour,
      post_score: p.score,
      post_score_as_of: p.score_as_of || "",
      post_upvote_ratio: p.upvote_ratio,
      post_num_comments: p.num_comments,
      post_permalink: p.permalink,
      post_flair: p.link_flair_text || "",
      post_over_18: p.over_18 || false,
      post_edited: p.edited || false,
      post_distinguished: p.distinguished || "",
      post_is_crosspost: p.is_crosspost || false,
      post_crosspost_subreddit: p.crosspost_subreddit || "",
      post_total_awards: p.total_awards_received || 0,
      post_gilded: p.gilded || 0,
      post_title_word_count: wordCount(p.title),
      post_selftext_word_count: wordCount(p.selftext),
      post_comments_complete: p.comments_complete === undefined ? "" : p.comments_complete,
      query: p.query || "",
    };
    if (keywordsEnabled) {
      postFields.post_relevance_score = p.relevance_score || 0;
      postFields.post_matched_categories = (p.matched_categories || []).join("; ");
      postFields.post_matched_keywords = JSON.stringify(p.matched_keywords || {});
    }

    const comments = p.comments || [];
    if (comments.length === 0) {
      const row = { ...postFields, row_type: "post_only" };
      if (keywordsEnabled) {
        row.comment_relevance_score = "";
        row.comment_matched_categories = "";
        row.comment_matched_keywords = "";
      }
      rows.push(headers.map((h) => csvEscape(h in row ? row[h] : extra[h])).join(","));
    } else {
      for (const c of comments) {
        const cx = opts.extraForComment ? { ...extra, ...opts.extraForComment(c, p) } : extra;
        const cdp = toDateParts(c.created_datetime);
        const row = {
          ...postFields,
          comment_id: c.id,
          comment_body: c.body,
          comment_author: c.author,
          comment_created_utc: c.created_utc,
          comment_created_datetime: c.created_datetime,
          comment_date: cdp.date,
          comment_day_of_week: cdp.day_of_week,
          comment_hour_utc: cdp.hour,
          comment_score: c.score,
          comment_score_as_of: c.score_as_of || "",
          comment_parent_id: c.parent_id,
          comment_is_submitter: c.is_submitter,
          comment_depth: c.depth ?? "",
          comment_edited: c.edited || false,
          comment_distinguished: c.distinguished || "",
          comment_controversiality: c.controversiality || 0,
          comment_body_word_count: wordCount(c.body),
          row_type: "comment",
        };
        if (keywordsEnabled) {
          row.comment_relevance_score = c.relevance_score || 0;
          row.comment_matched_categories = (c.matched_categories || []).join("; ");
          row.comment_matched_keywords = JSON.stringify(c.matched_keywords || {});
        }
        rows.push(headers.map((h) => csvEscape(h in row ? row[h] : cx[h])).join(","));
      }
    }
  }

  return (opts.header === false ? rows : [headers.join(","), ...rows]).join("\n");
}

function commentsToCSV(posts, keywordsEnabled, opts = {}) {
  const headers = [
    "comment_id", "post_id", "subreddit", "post_title",
    "body", "author", "created_utc", "created_datetime",
    "date", "day_of_week", "hour_utc",
    "score", "score_as_of", "parent_id", "is_submitter",
    "depth", "edited", "distinguished", "controversiality",
    "body_word_count", "body_char_count", "query",
  ];
  if (keywordsEnabled) {
    headers.push("relevance_score", "matched_categories", "matched_keywords");
  }

  // extra trailing columns, e.g. run_label/run_id in a merged export
  const extraBase = opts.extra || {};
  headers.push(...Object.keys(extraBase), ...(opts.extraCols || []));
  const rows = [];
  for (const p of posts) {
    const extra = opts.extraFor ? { ...extraBase, ...(opts.extraFor(p) || {}) } : extraBase;
    for (const c of p.comments || []) {
      const cx = opts.extraForComment ? { ...extra, ...opts.extraForComment(c, p) } : extra;
      const dp = toDateParts(c.created_datetime);
      const row = {
        comment_id: c.id,
        post_id: p.id,
        subreddit: p.subreddit ?? opts.subreddit ?? scrapeResult?.subreddit ?? "",
        post_title: p.title,
        body: c.body,
        author: c.author,
        created_utc: c.created_utc,
        created_datetime: c.created_datetime,
        date: dp.date,
        day_of_week: dp.day_of_week,
        hour_utc: dp.hour,
        score: c.score,
        score_as_of: c.score_as_of || "",
        parent_id: c.parent_id,
        is_submitter: c.is_submitter,
        depth: c.depth ?? "",
        edited: c.edited || false,
        distinguished: c.distinguished || "",
        controversiality: c.controversiality || 0,
        body_word_count: wordCount(c.body),
        body_char_count: (c.body || "").length,
        query: p.query || "",
      };
      if (keywordsEnabled) {
        row.relevance_score = c.relevance_score || 0;
        row.matched_categories = (c.matched_categories || []).join("; ");
        row.matched_keywords = JSON.stringify(c.matched_keywords || {});
      }
      rows.push(headers.map((h) => csvEscape(h in row ? row[h] : cx[h])).join(","));
    }
  }

  return (opts.header === false ? rows : [headers.join(","), ...rows]).join("\n");
}
