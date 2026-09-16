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
const CHUNK_ATTEMPTS = 3;

function isoDay(ts) { return new Date(ts * 1000).toISOString().slice(0, 10); }

function statusLabel(status) {
  return { complete: "complete", complete_with_gaps: "complete with gaps", stopped: "stopped", failed: "failed", running: "unfinished" }[status] || status;
}
function statusClass(status) {
  return { complete: "complete", complete_with_gaps: "gaps", stopped: "stopped", failed: "failed", running: "running" }[status] || "stopped";
}

function scopeText(plan) {
  if (plan.scope === "count") return `${plan.limit.toLocaleString()} newest posts`;
  const w = plan.window;
  const range = w ? `${isoDay(w.after)} → ${isoDay(w.before)}` : "whole community";
  return plan.scope === "all" ? `whole community (${range})` : range;
}

function buildManifest(run, posts) {
  const incomplete = posts.filter((p) => p.comments_complete === false).map((p) => p.id);
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
    window_utc: run.plan.window ? { from: new Date(run.plan.window.after * 1000).toISOString(), to: new Date(run.plan.window.before * 1000).toISOString() } : null,
    keywords: run.settings.keywords || [],
    include_comments: run.settings.includeComments,
    include_selftext: run.settings.includeSelftext,
    skip_nsfw: run.settings.skipNSFW,
    sorts: Array.from(new Set(run.plan.queue.map((m) => m.sort))),
    chunks: run.chunks.map((c) => ({ index: c.i, from_utc: c.after === null ? null : new Date((c.after + 1) * 1000).toISOString(), to_utc: c.before === null ? null : new Date((c.before - 1) * 1000).toISOString(), status: c.status, posts: c.posts, error: c.error || undefined })),
    counts: { posts: posts.length, comments: posts.reduce((n, p) => n + (p.comments?.length || 0), 0), posts_with_incomplete_comments: incomplete.length },
    posts_with_incomplete_comments: incomplete,
    started_at: new Date(run.createdAt).toISOString(),
    finished_at: run.finishedAt ? new Date(run.finishedAt).toISOString() : null,
    source: "Arctic Shift archive (https://arctic-shift.photon-reddit.com)",
    note: "Reddit's num_comments undercounts the archive; scores are the archive's ~36h snapshot (score_as_of).",
  };
}

// --- Your runs panel ---
async function renderRunsPanel() {
  let runs = [];
  try { runs = await RunStore.listRuns(); } catch { runs = []; }
  const panel = document.getElementById("resumeBanner");
  const list = document.getElementById("runsList");
  if (!runs.length) { panel.classList.add("hidden"); return; }
  if (!RunStore.isPersistent()) {
    document.getElementById("runsNote").textContent = "Browser storage is unavailable here (private window?), so runs are kept only until this tab closes.";
  }
  list.innerHTML = runs.map((r) => {
    const when = new Date(r.updatedAt).toLocaleString();
    const canResume = r.status !== "complete";
    return `<div class="run-row" data-id="${r.id}">
      <span class="run-badge ${statusClass(r.status)}">${statusLabel(r.status)}</span>
      <span class="run-title">r/${escapeHtml(r.subreddit)}</span>
      <span class="run-meta">${escapeHtml(scopeText(r.plan))}${r.settings.keywords?.length ? ` · ${r.settings.keywords.length} keyword${r.settings.keywords.length > 1 ? "s" : ""}` : ""} · ${(r.counts?.posts || 0).toLocaleString()} posts${r.settings.includeComments ? ` · ${(r.counts?.comments || 0).toLocaleString()} comments` : ""} · ${when}</span>
      <span class="run-actions">
        ${canResume ? `<button type="button" class="link-button run-resume">${r.status === "complete_with_gaps" ? "Retry failed chunks" : "Resume"}</button>` : ""}
        <button type="button" class="link-button run-open">Open</button>
        <button type="button" class="link-button run-csv">Download CSV</button>
        <button type="button" class="link-button run-delete">Delete</button>
      </span>
    </div>`;
  }).join("");
  panel.classList.remove("hidden");
  list.querySelectorAll(".run-row").forEach((row) => {
    const id = row.dataset.id;
    row.querySelector(".run-resume")?.addEventListener("click", () => startScrape({ resumeId: id }));
    row.querySelector(".run-open").addEventListener("click", () => openRun(id));
    row.querySelector(".run-csv").addEventListener("click", async () => {
      const run = await RunStore.getRun(id);
      const posts = await RunStore.getPosts(id);
      downloadFile(combinedToCSV(posts, false), `reddit_${run.subreddit}_combined.csv`, "text/csv");
    });
    row.querySelector(".run-delete").addEventListener("click", async () => {
      if (!confirm("Delete this run and its data from this browser? Downloaded files are not affected.")) return;
      await RunStore.deleteRun(id);
      renderRunsPanel();
    });
  });
}

async function openRun(id) {
  const run = await RunStore.getRun(id);
  if (!run) return;
  const posts = await RunStore.getPosts(id);
  currentRun = run;
  scrapeResult = { subreddit: run.subreddit, posts, keywordsEnabled: false, summary: buildSummary(posts, false), run };
  showResults(scrapeResult);
  resultsSection.scrollIntoView({ behavior: "smooth" });
}

function estimateTime(postCount, includeComments) {
  if (includeComments) {
    const batches = Math.ceil(postCount / 10);
    const seconds = batches * 5;
    return seconds;
  } else {
    const batches = Math.ceil(postCount / 100);
    const seconds = batches * 2;
    return seconds;
  }
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
async function apiCall(body, maxRetries = 5) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch("/api/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abortController?.signal,
    });
    const data = await resp.json();
    if (resp.ok) return data;

    const errMsg = data.error || `Server error (${resp.status})`;
    if (attempt < maxRetries && (resp.status === 429 || resp.status >= 500 || /rate limit|timeout|slow down/i.test(errMsg))) {
      const wait = Math.min(5000 * 2 ** attempt, 60000);
      updateProgress(`Data source rate-limited. Waiting ${wait / 1000}s and retrying...`);
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
}

// A subreddit name is 2-21 letters/digits/underscores (optionally r/ or a
// reddit.com URL). Anything else — spaces, a sentence, a question — is a topic,
// and belongs in study discovery, which suggests communities to scrape.
function looksLikeSubreddit(text) {
  if (/reddit\.com\//i.test(text)) return true;
  return /^(\/?r\/)?[A-Za-z0-9_]{2,21}\/?$/.test(text);
}

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

function scopeTime(posts) {
  return formatDuration(estimateTime(posts, document.getElementById("includeComments").checked));
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
    all.innerHTML = `<strong>${fmtN(a.posts)}</strong> posts · ${fmtN(a.comments)} comments · ${scopeTime(a.posts)}`;
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
  const days = { day: 1, week: 7, month: 30, year: 365 }[tf];
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
      const request = apiCall({ action: "count", subreddit: currentAnalysis.info.name, afterEpoch: after, beforeEpoch: before, query })
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

  if (scope === "count") {
    const totalPosts = Math.min(limit * sortCount * passes, currentAnalysis.estimatedTotalUnique);
    renderEstimateBar(totalPosts, null, scopeLabel);
    const range = document.getElementById("estimateRange");
    if (range) range.textContent = passes > 1 ? `${limit.toLocaleString()} newest matches per keyword, ${sortCount} sort mode${sortCount > 1 ? "s" : ""}.` : `${limit.toLocaleString()} newest posts${sortCount > 1 ? ` per sort mode (${sortCount})` : ""}.`;
    return;
  }

  renderEstimateBar(null, null, scopeLabel);

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
function renderEstimateBar(posts, comments, scopeLabel) {
  const el = document.getElementById("collectionEstimate");
  const includeComments = document.getElementById("includeComments").checked;
  const known = posts !== null;
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
        <span class="estimate-number">${known ? formatDuration(estimateTime(posts, includeComments)) : "…"}</span>
        <span class="estimate-label">estimated time${includeComments ? " (with comments)" : ""}</span>
      </div>
    </div>
    <p class="estimate-range" id="estimateRange">${known ? "" : "Counting…"}</p>
    <p class="estimate-hint">Progress is saved automatically — you can close this tab and resume later.</p>
  `;
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
    if (summary) summary.innerHTML = `<strong>${(count.exact ? "" : "≈ ") + fmtN(count.posts)}</strong> posts · ${(count.exact ? "" : "≈ ") + fmtN(count.comments)} comments · ${scopeTime(count.posts)}`;
  }
  const approx = count.exact ? "" : "≈ ";
  let qualifier = count.all
    ? "in the whole archive"
    : count.exact ? "in this time range (exact)" : "in this time range (estimate, typically within ±15%)";
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
  const tooMany = n > MAX_POSTS_PER_SORT;
  range.innerHTML = `
    ${approx}${n.toLocaleString()} posts · ${approx}${count.comments.toLocaleString()} comments ${qualifier}.${recent}
    ${tooMany ? `<span class="estimate-warn">More than ${MAX_POSTS_PER_SORT.toLocaleString()} — one run cannot hold this; split it into narrower time frames, one run each.</span>` : ""}
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

// --- Scrape Orchestration ---
scrapeBtn.addEventListener("click", () => startScrape());

let currentRun = null;

// Chunk bounds are sent to the archive as `after`/`before`, which are EXCLUSIVE
// on both ends. Edges e_0..e_n partition the window; chunk k fetches
// created_utc in (e_k, e_{k+1}+1), i.e. [e_k+1, e_{k+1}] inclusive, so adjacent
// chunks meet with no gap and no overlap, and the window's own first and last
// seconds are included.
function makeChunks(window, expectedPosts) {
  if (!window) return [{ i: 0, after: null, before: null, status: "pending", posts: 0 }];
  const n = expectedPosts ? Math.min(MAX_CHUNKS, Math.max(1, Math.ceil(expectedPosts / CHUNK_TARGET_POSTS))) : 1;
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
  // size the chunks from the count (wait for it if it is still running) and
  // let every chunk walk to exhaustion rather than stop at the limit box.
  let expected = null;
  if (scope !== "count") {
    let count = lastCount;
    if (!count) {
      updateProgress("Counting the posts in this scope…", null);
      progressSection.classList.remove("hidden");
      try { count = await countSelectedWindow(); } catch { count = null; }
    }
    expected = count ? count.posts : null;
    limit = MAX_POSTS_PER_SORT;
  }
  return {
    id: RunStore.newId(),
    subreddit,
    status: "running",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    settings: { limit, includeComments, includeSelftext, skipNSFW, keywords },
    plan: { scope, window, limit, queue, expectedPosts: expected },
    chunks: makeChunks(window, expected),
    progress: { chunkIdx: 0, modeIdx: 0, after: null, modeFetched: 0, seq: 0 },
    counts: { posts: 0, comments: 0 },
  };
}

async function startScrape(opts = {}) {
  const resumeId = opts.resumeId || null;
  let run;
  let allPosts = [];
  if (resumeId) {
    run = await RunStore.getRun(resumeId);
    if (!run) { showError("That run is no longer in this browser."); return; }
    allPosts = await RunStore.getPosts(resumeId);
    // failed chunks get another go on resume
    for (const c of run.chunks) if (c.status === "failed") { c.status = "pending"; c.error = ""; }
    run.status = "running";
    run.finishedAt = null;
  } else {
    run = await planRunFromUI();
    if (!run) return;
  }
  currentRun = run;
  const { subreddit, settings, plan } = run;
  const { limit, includeComments, includeSelftext, skipNSFW } = settings;
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
  updateProgress(resumeId ? `Resuming… (${allPosts.length.toLocaleString()} posts already collected)` : "Starting squeeze…");
  await RunStore.saveRun(run);

  const persistPosts = async (posts) => {
    if (!posts.length) return;
    await RunStore.putPosts(run.id, posts, run.progress.seq);
    run.progress.seq += posts.filter((p) => p.seq === undefined).length;
    run.counts = { posts: allPosts.length, comments: allPosts.reduce((n, p) => n + (p.comments?.length || 0), 0) };
    await RunStore.saveRun(run);
  };

  const chunkLabel = (c) => run.chunks.length > 1 ? `Chunk ${c.i + 1}/${run.chunks.length} (${isoDay(c.after + 1)} → ${isoDay(c.before - 1)}) · ` : "";

  const progressLine = (c, mode, extra) => {
    const done = allPosts.length;
    const pct = Math.min(99, (done / Math.max(expectedTotal, 1)) * 100);
    const remaining = Math.max(expectedTotal - done, 0);
    updateProgress(`${chunkLabel(c)}${mode.label}: ${done.toLocaleString()} posts collected (${formatDuration(estimateTime(remaining, includeComments))} left)${extra || ""}`, pct);
  };

  // One chunk: every queue mode, paginated, from the saved cursor.
  const runChunk = async (c) => {
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

  let outcome = "complete";
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
      let attempt = 0;
      while (true) {
        try {
          await runChunk(c);
          c.status = "done";
          c.error = "";
          break;
        } catch (err) {
          if (err.name === "AbortError") throw err;
          attempt++;
          c.error = String(err.message || err).slice(0, 200);
          if (attempt >= CHUNK_ATTEMPTS) {
            c.status = "failed";
            outcome = "complete_with_gaps";
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
    }

    run.status = outcome;
    run.finishedAt = Date.now();
    run.counts = { posts: allPosts.length, comments: allPosts.reduce((n, p) => n + (p.comments?.length || 0), 0) };
    run.manifest = buildManifest(run, allPosts);
    await RunStore.saveRun(run);
    updateProgress(outcome === "complete" ? "Done — every chunk finished." : "Done with gaps — some chunks failed; see the run status below.", 100);
    scrapeResult = { subreddit, posts: allPosts, keywordsEnabled: false, summary: buildSummary(allPosts, false), run };
    showResults(scrapeResult);
    // The file is what the researcher must not lose: hand it over without asking.
    if (allPosts.length > 0) {
      downloadFile(combinedToCSV(allPosts, false), `reddit_${subreddit}_combined.csv`, "text/csv");
    }
  } catch (err) {
    const stopped = err.name === "AbortError";
    run.status = stopped ? "stopped" : "failed";
    run.counts = { posts: allPosts.length, comments: allPosts.reduce((n, p) => n + (p.comments?.length || 0), 0) };
    run.manifest = buildManifest(run, allPosts);
    await RunStore.saveRun(run);
    if (!stopped) showError(err.message);
    if (allPosts.length > 0) {
      scrapeResult = { subreddit, posts: allPosts, keywordsEnabled: false, summary: buildSummary(allPosts, false), run };
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
    renderRunsPanel();
  }
}

stopBtn.addEventListener("click", () => {
  if (abortController) abortController.abort();
});

renderRunsPanel();

// --- Results display ---
function showResults(data) {
  resultsSection.classList.remove("hidden");
  const s = data.summary;

  const summaryDiv = document.getElementById("summary");
  let statsHtml = `
    <div class="stat-card"><div class="value">${s.total_posts.toLocaleString()}</div><div class="label">Posts</div></div>
    <div class="stat-card"><div class="value">${s.total_comments.toLocaleString()}</div><div class="label">Comments</div></div>
    <div class="stat-card"><div class="value">${s.total_score.toLocaleString()}</div><div class="label">Total score</div></div>
  `;
  if (s.posts_with_incomplete_comments) {
    statsHtml += `<div class="stat-card"><div class="value">${s.posts_with_incomplete_comments}</div><div class="label">Posts with incomplete comments</div></div>`;
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

  const statusEl = document.getElementById("runStatus");
  const run = data.run;
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
  const previewPosts = data.posts.slice(0, 5);
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
document.getElementById("downloadJson").addEventListener("click", () => {
  if (!scrapeResult) return;
  downloadFile(
    JSON.stringify(scrapeResult.posts, null, 2),
    `reddit_${scrapeResult.subreddit}_full.json`,
    "application/json"
  );
});

document.getElementById("downloadManifest").addEventListener("click", () => {
  if (!scrapeResult) return;
  const run = scrapeResult.run;
  const manifest = run ? (run.manifest || buildManifest(run, scrapeResult.posts)) : { note: "no run metadata (thread download)" };
  downloadFile(JSON.stringify(manifest, null, 2), `reddit_${scrapeResult.subreddit}_run_report.json`, "application/json");
});

document.getElementById("downloadCsv").addEventListener("click", () => {
  if (!scrapeResult) return;
  const csv = postsToCSV(scrapeResult.posts, scrapeResult.keywordsEnabled);
  downloadFile(csv, `reddit_${scrapeResult.subreddit}_posts.csv`, "text/csv");
});

document.getElementById("downloadCommentsCsv").addEventListener("click", () => {
  if (!scrapeResult) return;
  const csv = commentsToCSV(scrapeResult.posts, scrapeResult.keywordsEnabled);
  downloadFile(csv, `reddit_${scrapeResult.subreddit}_comments.csv`, "text/csv");
});

document.getElementById("downloadCombinedCsv").addEventListener("click", () => {
  if (!scrapeResult) return;
  const csv = combinedToCSV(scrapeResult.posts, scrapeResult.keywordsEnabled);
  downloadFile(csv, `reddit_${scrapeResult.subreddit}_combined.csv`, "text/csv");
});

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function csvEscape(val) {
  if (val === null || val === undefined) return "";
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function postsToCSV(posts, keywordsEnabled) {
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

  const rows = posts.map((p) => {
    const dp = toDateParts(p.created_datetime);
    const row = {
      id: p.id,
      subreddit: scrapeResult.subreddit,
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
    return headers.map((h) => csvEscape(row[h])).join(",");
  });

  return [headers.join(","), ...rows].join("\n");
}

function combinedToCSV(posts, keywordsEnabled) {
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

  const rows = [];
  for (const p of posts) {
    const pdp = toDateParts(p.created_datetime);
    const postFields = {
      post_id: p.id,
      subreddit: scrapeResult.subreddit,
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
      rows.push(headers.map((h) => csvEscape(row[h])).join(","));
    } else {
      for (const c of comments) {
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
        rows.push(headers.map((h) => csvEscape(row[h])).join(","));
      }
    }
  }

  return [headers.join(","), ...rows].join("\n");
}

function commentsToCSV(posts, keywordsEnabled) {
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

  const rows = [];
  for (const p of posts) {
    for (const c of p.comments || []) {
      const dp = toDateParts(c.created_datetime);
      const row = {
        comment_id: c.id,
        post_id: p.id,
        subreddit: scrapeResult.subreddit,
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
      rows.push(headers.map((h) => csvEscape(row[h])).join(","));
    }
  }

  return [headers.join(","), ...rows].join("\n");
}
