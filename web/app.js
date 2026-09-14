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
const timeFilterBlock = document.getElementById("timeFilterBlock");
const timeFilterSelect = document.getElementById("timeFilter");
const timeFilterNote = document.getElementById("timeFilterNote");

const customDateRange = document.getElementById("customDateRange");
const dateFromInput = document.getElementById("dateFrom");
const dateToInput = document.getElementById("dateTo");

function updateTimeFilterState() {
  // Time range applies to all sorts now (archive-based)
  timeFilterSelect.disabled = false;
  timeFilterBlock.classList.remove("disabled");
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

// --- Save/Resume system ---
const STORAGE_KEY = "lemonsqueeze_progress";

const RESUME_SNAPSHOT_MAX_POSTS = 20000;

function saveProgress(data) {
  if (data.posts.length > RESUME_SNAPSHOT_MAX_POSTS) {
    if (!saveProgress.warned) {
      saveProgress.warned = true;
      showError(`This run is past ${RESUME_SNAPSHOT_MAX_POSTS.toLocaleString()} posts, so progress is no longer saved for Resume. Keep this tab open until it finishes, then download.`);
    }
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      timestamp: Date.now(),
      subreddit: data.subreddit,
      posts: data.posts,
      seenIds: Array.from(data.seenIds),
      sortQueue: data.sortQueue,
      currentSortIdx: data.currentSortIdx,
      currentAfter: data.currentAfter,
      currentModeFetched: data.currentModeFetched,
      settings: data.settings,
    }));
  } catch {
    if (!saveProgress.warned) {
      saveProgress.warned = true;
      showError("Browser storage is full, so progress can no longer be saved for Resume. Collection continues — download your data when it finishes rather than relying on Resume.");
    }
  }
}

function loadProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (Date.now() - data.timestamp > 24 * 60 * 60 * 1000) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function clearProgress() {
  localStorage.removeItem(STORAGE_KEY);
}

// --- Time estimate helpers ---
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
async function apiCall(body, maxRetries = 3) {
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
    if (attempt < maxRetries && (resp.status === 429 || resp.status >= 500 || errMsg.includes("rate limit"))) {
      const wait = 5000 * 2 ** attempt;
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

// --- Analyze flow ---
analyzeBtn.addEventListener("click", async () => {
  const subredditInput = document.getElementById("subreddit").value.trim();
  if (!subredditInput) {
    showError("Please enter a subreddit name or URL.");
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
    showError(err.message);
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
  updateCollectionEstimate();
}

// --- Live collection estimate (updates when settings change) ---
const MAX_POSTS_PER_SORT = 100000;

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

  const selectedSorts = Array.from(document.querySelectorAll("#sortPills .pill.active"));
  const sortCount = Math.max(selectedSorts.length, 1);
  const limit = parseInt(document.getElementById("limit").value, 10) || 50;
  const includeComments = document.getElementById("includeComments").checked;
  const passes = Math.max(parseKeywords().length, 1);
  const totalPosts = Math.min(limit * sortCount * passes, currentAnalysis.estimatedTotalUnique);
  const etaSeconds = estimateTime(totalPosts, includeComments);

  el.innerHTML = `
    <div class="estimate-bar">
      <div class="estimate-item">
        <span class="estimate-number">${totalPosts.toLocaleString()}</span>
        <span class="estimate-label">posts to collect</span>
      </div>
      <div class="estimate-divider"></div>
      <div class="estimate-item">
        <span class="estimate-number">${formatDuration(etaSeconds)}</span>
        <span class="estimate-label">estimated time${includeComments ? " (with comments)" : ""}</span>
      </div>
    </div>
    <p class="estimate-range" id="estimateRange">Counting posts in this time range…</p>
    <p class="estimate-hint">Progress is saved automatically — you can close this tab and resume later.</p>
  `;

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

function renderRangeCount(count) {
  const range = document.getElementById("estimateRange");
  if (!range) return;
  if (!count) {
    range.textContent = "Pick a start date to count posts in a custom range.";
    return;
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
  const canTakeAll = n > 0 && n <= MAX_POSTS_PER_SORT;
  range.innerHTML = `
    <strong>${approx}${n.toLocaleString()} posts</strong> · ${approx}${count.comments.toLocaleString()} comments ${qualifier}.${recent}
    ${canTakeAll
      ? `<button type="button" class="link-button" id="collectAllBtn">Collect all ${n.toLocaleString()} ${count.keywords ? "matching " : ""}posts</button>`
      : n > MAX_POSTS_PER_SORT
        ? `<span class="estimate-warn">More than ${MAX_POSTS_PER_SORT.toLocaleString()} — choose a narrower time range to collect everything, one range per run.</span>`
        : ""}
  `;
  const btn = document.getElementById("collectAllBtn");
  if (btn) {
    btn.addEventListener("click", () => {
      // "All" means every post in the window: New already yields each one once,
      // the other sorts would only re-select from the same set.
      const perPass = count.perKeyword ? Math.max(...count.perKeyword.map((p) => p.posts)) : n;
      document.getElementById("limit").value = String(perPass);
      sortPills.forEach((p) => p.classList.toggle("active", p.dataset.value === "new"));
      const note = document.getElementById("keywordsNote");
      if (note && count.perKeyword) {
        note.textContent = `Limit set to ${perPass.toLocaleString()} per keyword — enough to collect every one of the ${n.toLocaleString()} matches.`;
      }
      updateCollectionEstimate();
      const limitInput = document.getElementById("limit");
      limitInput.focus();
      limitInput.blur();
    });
  }
}

// Wire settings changes to update the estimate live
document.getElementById("limit").addEventListener("input", updateCollectionEstimate);
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
scrapeBtn.addEventListener("click", () => startScrape(false));

async function startScrape(isResume) {
  const saved = isResume ? loadProgress() : null;

  let subreddit, sortQueue, limit, includeComments, includeSelftext, skipNSFW;
  let timeFilter, keywords = [];
  let customAfterEpoch = null, customBeforeEpoch = null;
  let allPosts = [], seenIds = new Set();
  let startSortIdx = 0, startAfter = null, startModeFetched = 0;

  if (saved) {
    subreddit = saved.subreddit;
    allPosts = saved.posts;
    seenIds = new Set(saved.seenIds);
    sortQueue = saved.sortQueue;
    startSortIdx = saved.currentSortIdx;
    startAfter = saved.currentAfter;
    startModeFetched = saved.currentModeFetched;
    limit = saved.settings.limit;
    includeComments = saved.settings.includeComments;
    includeSelftext = saved.settings.includeSelftext;
    skipNSFW = saved.settings.skipNSFW;
    timeFilter = saved.settings.timeFilter;
    keywords = saved.settings.keywords || [];
    customAfterEpoch = saved.settings.customAfterEpoch || null;
    customBeforeEpoch = saved.settings.customBeforeEpoch || null;
  } else {
    const subredditInput = document.getElementById("subreddit").value.trim();
    if (!subredditInput) {
      showError("Please enter a subreddit name or URL.");
      return;
    }

    const sortModes = Array.from(document.querySelectorAll("#sortPills .pill.active")).map(
      (p) => p.dataset.value
    );
    if (sortModes.length === 0) {
      showError("Please select at least one sort mode.");
      return;
    }

    limit = parseInt(document.getElementById("limit").value, 10) || 50;
    limit = Math.min(limit, MAX_POSTS_PER_SORT);
    includeComments = document.getElementById("includeComments").checked;
    includeSelftext = document.getElementById("includeSelftext").checked;
    skipNSFW = document.getElementById("skipNSFW").checked;
    timeFilter = document.getElementById("timeFilter").value;
    keywords = parseKeywords();
    if (timeFilter === "custom") {
      const fromVal = document.getElementById("dateFrom").value;
      const toVal = document.getElementById("dateTo").value;
      if (!fromVal) {
        showError("Please select a start date for your custom range.");
        return;
      }
      // Convert dates to epoch — "from" is start of day, "to" is end of day
      customAfterEpoch = Math.floor(new Date(fromVal + "T00:00:00Z").getTime() / 1000);
      customBeforeEpoch = toVal
        ? Math.floor(new Date(toVal + "T23:59:59Z").getTime() / 1000)
        : null;
    }
    subreddit = subredditInput;
    const urlMatch = subreddit.match(/reddit\.com\/r\/([^/?\s]+)/);
    if (urlMatch) subreddit = urlMatch[1];
    subreddit = subreddit.replace(/^r\//, "");

    // Build sort queue: with keywords, one pass per keyword per sort
    sortQueue = [];
    const passes = keywords.length ? keywords : [""];
    for (const query of passes) for (const mode of sortModes) {
      const tag = query ? ` "${query}"` : "";
      if (mode === "top" && limit > 1000 && currentAnalysis && !query) {
        sortQueue.push({ sort: "top", timeFilter: "all", label: "Top (All Time)", query });
        sortQueue.push({ sort: "top", timeFilter: "year", label: "Top (Year)", query });
        sortQueue.push({ sort: "top", timeFilter: "month", label: "Top (Month)", query });
      } else if (mode === "controversial" && limit > 1000 && currentAnalysis && !query) {
        sortQueue.push({ sort: "controversial", timeFilter: "all", label: "Controversial (All Time)", query });
        sortQueue.push({ sort: "controversial", timeFilter: "year", label: "Controversial (Year)", query });
        sortQueue.push({ sort: "controversial", timeFilter: "month", label: "Controversial (Month)", query });
      } else {
        // The selected range applies to every sort; the server derives the
        // window from the preset, or from the custom epochs sent alongside.
        sortQueue.push({ sort: mode, timeFilter, label: mode.charAt(0).toUpperCase() + mode.slice(1) + tag, query });
      }
    }
  }

  const batchSize = includeComments ? 10 : 100;
  const totalTarget = limit * sortQueue.length;

  // UI state
  abortController = new AbortController();
  progressSection.classList.remove("hidden");
  resultsSection.classList.add("hidden");
  errorSection.classList.add("hidden");
  resumeBanner.classList.add("hidden");
  scrapeBtn.classList.add("hidden");
  stopBtn.classList.remove("hidden");
  progressFill.style.width = "0%";
  updateProgress(isResume ? `Resuming... (${allPosts.length} posts already collected)` : "Starting squeeze...");

  const settings = { limit, includeComments, includeSelftext, skipNSFW, timeFilter, keywords, customAfterEpoch, customBeforeEpoch };

  try {
    // A Stop can land mid-thread; those posts are already in allPosts and
    // seenIds, so they would never be revisited by the batch loop below.
    for (const p of allPosts) {
      if (p.comments_complete !== false) continue;
      await completeComments(p, (n) => {
        updateProgress(`Resuming: finishing comments for "${p.title.slice(0, 40)}" (${n.toLocaleString()} of ~${(p.num_comments || 0).toLocaleString()})`, null);
      });
    }

    for (let modeIdx = startSortIdx; modeIdx < sortQueue.length; modeIdx++) {
      const mode = sortQueue[modeIdx];
      let after = modeIdx === startSortIdx ? startAfter : null;
      let modeFetched = modeIdx === startSortIdx ? startModeFetched : 0;

      while (modeFetched < limit) {
        const overallFetched = allPosts.length;
        const percent = (overallFetched / totalTarget) * 100;

        const remainingPosts = totalTarget - overallFetched;
        const etaStr = formatDuration(estimateTime(remainingPosts, includeComments));
        updateProgress(
          `${mode.label}: ${overallFetched} posts collected (${etaStr} remaining)`,
          percent
        );

        const reqBody = {
          subreddit,
          sort: mode.sort,
          batchSize: Math.min(batchSize, limit - modeFetched),
          after,
          includeComments,
          skipIds: Array.from(seenIds),
          timeFilter: mode.timeFilter,
          query: mode.query || "",
        };
        if (customAfterEpoch) reqBody.afterEpoch = customAfterEpoch;
        if (customBeforeEpoch) reqBody.beforeEpoch = customBeforeEpoch;
        const batchResp = await apiCall(reqBody);

        if (mode.query) {
          for (const p of batchResp.posts) {
            const existing = allPosts.find((x) => x.id === p.id);
            if (existing && existing.query && !existing.query.split(";").includes(mode.query)) existing.query += ";" + mode.query;
            p.query = mode.query;
          }
        }
        let newPosts = batchResp.posts.filter((p) => !seenIds.has(p.id));

        if (skipNSFW) {
          newPosts = newPosts.filter((p) => !p.over_18);
        }
        if (!includeSelftext) {
          newPosts.forEach((p) => { p.selftext = ""; });
        }

        for (const p of newPosts) {
          seenIds.add(p.id);
          allPosts.push(p);
          modeFetched++;
        }

        if (includeComments) {
          for (const p of newPosts) {
            await completeComments(p, (n) => {
              updateProgress(
                `${mode.label}: ${allPosts.length} posts collected — finishing a large thread (${n.toLocaleString()} of ~${(p.num_comments || 0).toLocaleString()} comments)`,
                percent
              );
            });
          }
        }

        // Save progress every batch
        saveProgress({
          subreddit,
          posts: allPosts,
          seenIds,
          sortQueue,
          currentSortIdx: modeIdx,
          currentAfter: batchResp.after,
          currentModeFetched: modeFetched,
          settings,
        });

        if (batchResp.done || newPosts.length === 0) break;
        after = batchResp.after;
      }
    }

    updateProgress("Done!", 100);
    clearProgress();

    scrapeResult = {
      subreddit,
      posts: allPosts,
      keywordsEnabled: false,
      summary: buildSummary(allPosts, false),
    };

    showResults(scrapeResult);
  } catch (err) {
    if (err.name === "AbortError") {
      // Show partial data on stop
      if (allPosts.length > 0) {
        scrapeResult = {
          subreddit,
          posts: allPosts,
          keywordsEnabled: false,
          summary: buildSummary(allPosts, false),
        };
        updateProgress(
          `Stopped at ${allPosts.length} posts. Partial data is available for download below.`,
          (allPosts.length / totalTarget) * 100
        );
        showResults(scrapeResult);
        document.getElementById("resultsSubtitle").textContent =
          `Scrape stopped early. ${allPosts.length} posts collected — you can still download this partial dataset.`;
      } else {
        updateProgress("Stopped — no posts were collected.", null);
      }
      // Save for resume
      saveProgress({
        subreddit,
        posts: allPosts,
        seenIds,
        sortQueue,
        currentSortIdx: startSortIdx,
        currentAfter: null,
        currentModeFetched: 0,
        settings,
      });
    } else {
      showError(err.message);
      // Even on error, show partial data if we have some
      if (allPosts.length > 0) {
        scrapeResult = {
          subreddit,
          posts: allPosts,
          keywordsEnabled: false,
          summary: buildSummary(allPosts, false),
        };
        showResults(scrapeResult);
        document.getElementById("resultsSubtitle").textContent =
          `Error occurred after collecting ${allPosts.length} posts. You can download the partial data below.`;
      }
      progressSection.classList.add("hidden");
    }
  } finally {
    scrapeBtn.classList.remove("hidden");
    stopBtn.classList.add("hidden");
    abortController = null;
  }
}

stopBtn.addEventListener("click", () => {
  if (abortController) abortController.abort();
});

// --- Resume banner ---
function checkForSavedProgress() {
  const saved = loadProgress();
  if (!saved) return;

  const ago = Math.round((Date.now() - saved.timestamp) / 60000);
  const agoStr = ago < 1 ? "just now" : ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`;

  document.getElementById("resumeDetails").textContent =
    `r/${saved.subreddit} — ${saved.posts.length} posts collected (saved ${agoStr})`;
  resumeBanner.classList.remove("hidden");
}

document.getElementById("resumeBtn").addEventListener("click", () => {
  resumeBanner.classList.add("hidden");
  startScrape(true);
});

document.getElementById("discardBtn").addEventListener("click", () => {
  clearProgress();
  resumeBanner.classList.add("hidden");
});

checkForSavedProgress();

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
