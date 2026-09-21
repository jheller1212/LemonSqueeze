// Study design on a population you already hold: test regex filters offline, then
// sample, match controls, and send the chosen posts to the comment fetch.
// A population is either runs saved in this browser or CSV / CSV.gz files from disk;
// files are read locally and never uploaded.
import { parseFilters, monthOf, bodyState, stratifiedSample } from "./lib/design.js";
import { readCsvFile } from "./lib/csvstream.js";

const $ = (id) => document.getElementById(id);
const BATCH = 2000;
const BATCH_TIMEOUT_MS = 20000; // a batch of 2,000 posts takes well under a second; this only trips on runaway patterns
const PREVIEW_KEEP = 200;       // snippets kept per filter (reservoir), shown 20 at a time

export const state = { records: [], filters: [], hits: {}, snippets: {}, source: null, engines: [], sourceLabel: "" };
window.DesignState = state;

// ---------------------------------------------------------------- population sources
async function refreshSources() {
  const sel = $("designSource");
  let runs = [];
  try { runs = await RunStore.listRuns(); } catch { runs = []; }
  const groups = groupRuns(runs.filter((r) => (r.counts?.posts || 0) > 0));
  const opts = ['<option value="">— choose —</option>'];
  for (const g of groups) {
    const posts = g.runs.reduce((n, r) => n + (r.counts?.posts || 0), 0);
    if (g.runs.length > 1) opts.push(`<option value="group:${escapeHtml(g.key)}">r/${escapeHtml(g.subreddit)} · ${g.batch ? "batch" : "all runs"} (${g.runs.length} runs) · ${posts.toLocaleString()} posts</option>`);
    for (const r of g.runs) opts.push(`<option value="run:${escapeHtml(r.id)}">${g.runs.length > 1 ? "  └ " : ""}r/${escapeHtml(r.subreddit)} · ${escapeHtml(scopeText(r.plan))} · ${(r.counts?.posts || 0).toLocaleString()} posts</option>`);
  }
  sel.innerHTML = opts.join("");
  state.groups = groups;
}

function selectedRuns() {
  const v = $("designSource").value;
  if (!v) return [];
  if (v.startsWith("group:")) return (state.groups.find((g) => g.key === v.slice(6)) || { runs: [] }).runs;
  const id = v.slice(4);
  for (const g of state.groups) { const r = g.runs.find((x) => x.id === id); if (r) return [r]; }
  return [];
}

// Calls onPost({id,title,selftext,ts,nc,score,author,subreddit}) for every unique post.
async function iteratePopulation(onPost, onProgress) {
  const files = Array.from($("designFiles").files || []);
  const seen = new Set();
  if (files.length) {
    state.sourceLabel = `${files.length} file${files.length > 1 ? "s" : ""}: ${files.map((f) => f.name).slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""}`;
    let fi = 0;
    for (const file of files) {
      fi++;
      let ix = null;
      let missing = null;
      await readCsvFile(file, (row, header) => {
        if (!ix) {
          const col = (names) => names.map((n) => header.indexOf(n)).find((i) => i >= 0);
          ix = { id: col(["post_id", "id"]), title: col(["post_title", "title"]), body: col(["post_selftext", "selftext"]), ts: col(["post_created_utc", "created_utc"]),
                 nc: col(["post_num_comments", "num_comments"]), score: col(["post_score", "score"]), author: col(["post_author", "author"]), sub: col(["subreddit"]) };
          if (ix.id === undefined || ix.title === undefined || ix.ts === undefined) missing = `${file.name} has no post_id / post_title / post_created_utc columns`;
        }
        if (missing) return;
        const id = row[ix.id];
        if (!id || seen.has(id)) return; // combined files repeat the post on every comment row
        seen.add(id);
        onPost({ id, title: row[ix.title] || "", selftext: ix.body !== undefined ? row[ix.body] || "" : "", ts: Number(row[ix.ts]) || 0, nc: Number(row[ix.nc]) || 0, score: Number(row[ix.score]) || 0,
                 author: ix.author !== undefined ? row[ix.author] : "", subreddit: ix.sub !== undefined ? row[ix.sub] : "" });
      }, (read, total) => onProgress(`Reading file ${fi} of ${files.length} — ${Math.round((read / total) * 100)}% · ${seen.size.toLocaleString()} posts`));
      if (missing) throw new Error(missing);
    }
    return seen.size;
  }
  const runs = selectedRuns();
  if (!runs.length) throw new Error("Choose a population: saved runs from the list, or CSV files.");
  state.sourceLabel = $("designSource").selectedOptions[0].textContent.trim();
  let ri = 0;
  for (const run of runs) {
    ri++;
    await RunStore.iteratePosts(run.id, 500, async (batch) => {
      for (const p of batch) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        onPost({ id: p.id, title: p.title || "", selftext: p.selftext || "", ts: p.created_utc || 0, nc: p.num_comments || 0, score: p.score || 0, author: p.author || "", subreddit: p.subreddit || run.subreddit });
      }
      onProgress(`Reading run ${ri} of ${runs.length} — ${seen.size.toLocaleString()} posts`);
    });
  }
  return seen.size;
}

// ---------------------------------------------------------------- worker with a time limit
function makeWorker(filters, caseSensitive) {
  const worker = new Worker("filterworker.js", { type: "module" });
  const waiting = new Map();
  let ready;
  const readyP = new Promise((res, rej) => { ready = { res, rej }; });
  worker.onmessage = (e) => {
    if (e.data.type === "ready") ready.res(e.data.engines);
    if (e.data.type === "result") { const w = waiting.get(e.data.batch); if (w) { clearTimeout(w.timer); waiting.delete(e.data.batch); w.res(e.data); } }
  };
  worker.onerror = (e) => { const err = new Error(e.message || "filter worker failed"); ready.rej(err); for (const w of waiting.values()) { clearTimeout(w.timer); w.rej(err); } };
  worker.postMessage({ type: "init", filters, caseSensitive });
  let n = 0;
  return {
    ready: readyP,
    run(posts) {
      const batch = ++n;
      return new Promise((res, rej) => {
        const timer = setTimeout(() => { waiting.delete(batch); worker.terminate(); rej(new Error("A filter took more than 20 seconds on one batch of 2,000 posts and was stopped. That is almost always catastrophic backtracking — look for nested quantifiers such as (a+)+ or (.*)*.")); }, BATCH_TIMEOUT_MS);
        waiting.set(batch, { res, rej, timer });
        worker.postMessage({ type: "batch", batch, posts });
      });
    },
    close() { worker.terminate(); },
  };
}

// ---------------------------------------------------------------- run the filters
async function runFilters() {
  const status = $("designStatus"), errBox = $("designErrors"), btn = $("designRun");
  errBox.textContent = "";
  const { filters, errors } = parseFilters($("designFilters").value);
  if (errors.length) { errBox.textContent = errors.join(" · "); return; }
  if (filters.length > 30) { errBox.textContent = "At most 30 filters at a time."; return; }
  btn.disabled = true;
  $("designResults").classList.add("hidden");
  const worker = makeWorker(filters, $("designCase").checked);
  const t0 = Date.now();
  try {
    state.engines = await worker.ready;
    state.filters = filters;
    state.records = [];
    state.snippets = Object.fromEntries(filters.map((f) => [f.name, []]));
    const seenHits = Object.fromEntries(filters.map((f) => [f.name, 0]));
    let buffer = [];
    const inflight = [];
    const flush = async (posts) => {
      const base = state.records.length;
      for (const p of posts) state.records.push({ id: p.id, ts: p.ts, nc: p.nc, score: p.score, body: bodyState(p.selftext), author: p.author, sub: p.subreddit, mask: 0, title: null });
      const res = await worker.run(posts);
      res.masks.forEach((m, i) => { state.records[base + i].mask = m; });
      for (const s of res.snippets) {
        // reservoir sample: every hit has the same chance of being kept for the preview
        const k = ++seenHits[s.name];
        const keep = state.snippets[s.name];
        const item = { id: posts[s.i].id, title: posts[s.i].title, before: s.before, match: s.match, after: s.after, ts: posts[s.i].ts };
        if (keep.length < PREVIEW_KEEP) keep.push(item);
        else { const j = Math.floor(Math.random() * k); if (j < PREVIEW_KEEP) keep[j] = item; }
      }
    };
    const total = await iteratePopulation((post) => {
      buffer.push(post);
      if (buffer.length >= BATCH) { const b = buffer; buffer = []; inflight.push(flush(b)); }
    }, (msg) => { status.textContent = msg; });
    if (buffer.length) inflight.push(flush(buffer));
    await Promise.all(inflight);
    status.textContent = `${total.toLocaleString()} posts filtered in ${((Date.now() - t0) / 1000).toFixed(1)} s.`;
    renderResults();
    document.dispatchEvent(new CustomEvent("design:filtered"));
  } catch (err) {
    errBox.textContent = err.message || String(err);
    status.textContent = "";
  } finally {
    worker.close();
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- render
export function hitsOf(name) {
  const bit = state.filters.findIndex((f) => f.name === name);
  return bit < 0 ? [] : state.records.filter((r) => r.mask & (1 << bit));
}

function renderResults() {
  const recs = state.records, fs = state.filters;
  const months = new Map();
  const totals = fs.map(() => 0);
  for (const r of recs) {
    const m = monthOf(r.ts);
    if (!months.has(m)) months.set(m, { n: 0, intact: 0, hits: fs.map(() => 0) });
    const row = months.get(m);
    row.n++; if (r.body === "intact") row.intact++;
    fs.forEach((f, bit) => { if (r.mask & (1 << bit)) { row.hits[bit]++; totals[bit]++; } });
  }
  const pct = (a, b) => (b ? ((a / b) * 100).toFixed(a / b < 0.01 ? 2 : 1) + "%" : "–");
  const asciiOnly = state.engines.filter((e) => !e.unicode).map((e) => e.name);
  $("designTotals").innerHTML = `<strong>${recs.length.toLocaleString()}</strong> posts in ${escapeHtml(state.sourceLabel)} · ` +
    fs.map((f, i) => `<span class="design-chip"><strong>${escapeHtml(f.name)}</strong> ${totals[i].toLocaleString()} (${pct(totals[i], recs.length)})</span>`).join(" ") +
    (asciiOnly.length ? `<span class="design-warn">${escapeHtml(asciiOnly.join(", "))}: pattern is not valid in Unicode mode, so \\b uses ASCII word boundaries (e.g. "açai" matches \\bai\\b).</span>` : "");
  const keys = Array.from(months.keys()).sort();
  $("designTable").innerHTML = `<table class="design-table"><thead><tr><th>month</th><th>posts</th><th>intact body</th>${fs.map((f) => `<th>${escapeHtml(f.name)}</th>`).join("")}</tr></thead><tbody>` +
    keys.map((k) => { const r = months.get(k); return `<tr><td>${k}</td><td>${r.n.toLocaleString()}</td><td>${pct(r.intact, r.n)}</td>${r.hits.map((h) => `<td>${h.toLocaleString()} <span class="design-dim">${pct(h, r.n)}</span></td>`).join("")}</tr>`; }).join("") +
    `</tbody></table>`;
  const sel = $("designPreviewFilter");
  sel.innerHTML = fs.map((f) => `<option value="${escapeHtml(f.name)}">${escapeHtml(f.name)}</option>`).join("");
  document.querySelector(".design-preview-head").classList.toggle("hidden", fs.length === 0);
  $("designPreview").classList.toggle("hidden", fs.length === 0);
  if (fs.length) { sel.value = fs[fs.length - 1].name; renderPreview(); }
  $("designResults").classList.remove("hidden");
  renderSampleStep();
}

// ---------------------------------------------------------------- step 4: sample
function poolOf(value) {
  if (value === "all") return state.records;
  const [kind, name] = value.split(":");
  const bit = state.filters.findIndex((f) => f.name === name);
  return state.records.filter((r) => (kind === "hit") === !!(r.mask & (1 << bit)));
}

function renderSampleStep() {
  const opts = [`<option value="all">the whole population (${state.records.length.toLocaleString()})</option>`];
  for (const f of state.filters) {
    const n = hitsOf(f.name).length;
    opts.push(`<option value="hit:${escapeHtml(f.name)}">posts matching ${escapeHtml(f.name)} (${n.toLocaleString()})</option>`);
    opts.push(`<option value="miss:${escapeHtml(f.name)}">posts NOT matching ${escapeHtml(f.name)} (${(state.records.length - n).toLocaleString()})</option>`);
  }
  $("samplePool").innerHTML = opts.join("");
  $("sampleResult").classList.add("hidden");
  $("designSampleStep").classList.remove("hidden");
  state.sample = null;
}

function drawSample() {
  const pool = poolOf($("samplePool").value);
  const size = Math.max(1, Number($("sampleSize").value) || 0);
  const by = [];
  if ($("stratMonth").checked) by.push("month");
  if ($("stratComments").checked) by.push("comments_q");
  if ($("stratScore").checked) by.push("score_q");
  const seed = Math.max(0, Math.floor(Number($("sampleSeed").value) || 0));
  const opts = $("sampleUnit").value === "pct" ? { fraction: Math.min(size, 100) / 100, by, seed } : { n: size, by, seed };
  const res = stratifiedSample(pool, opts);
  const byId = new Map(pool.map((r) => [r.id, r]));
  state.sample = {
    kind: "sample", seed, stratify_by: by, pool: $("samplePool").selectedOptions[0].textContent.trim(), pool_size: pool.length, requested: res.requested,
    population: state.sourceLabel, filters: state.filters.map((f) => ({ name: f.name, regex: f.source, or: f.refs })), case_sensitive: $("designCase").checked,
    items: res.sample.map((x) => ({ id: x.id, group: "sample", stratum: x.stratum, match: "", rec: byId.get(x.id) })),
  };
  $("sampleSummary").innerHTML = `<strong>${res.sample.length.toLocaleString()}</strong> of ${pool.length.toLocaleString()} posts sampled · seed <strong>${seed}</strong> · ${by.length ? "stratified by " + by.map((b) => ({ month: "month", comments_q: "comment-count quartile", score_q: "score quartile" }[b])).join(" × ") : "simple random sample"}${$("sampleUnit").value === "n" && size > pool.length ? ` <span class="design-warn">You asked for ${size.toLocaleString()}; only ${pool.length.toLocaleString()} available, so this is the whole pool.</span>` : ""}`;
  $("sampleStrata").innerHTML = `<table class="design-table"><thead><tr><th>stratum</th><th>in pool</th><th>sampled</th><th>rate</th></tr></thead><tbody>` +
    res.strata.map((t) => `<tr><td>${escapeHtml(t.stratum)}</td><td>${t.population.toLocaleString()}</td><td>${t.sampled.toLocaleString()}</td><td>${t.population ? ((t.sampled / t.population) * 100).toFixed(1) + "%" : "–"}</td></tr>`).join("") + `</tbody></table>`;
  $("sampleResult").classList.remove("hidden");
}

export function manifestCsv(design) {
  const names = design.filters.map((f) => f.name);
  const head = ["post_id", "sample_group", "match_post_id", "stratum", "seed", ...names.map((n) => "flag_" + n.toLowerCase()), "post_created_utc", "post_num_comments", "post_score", "post_body_state"];
  const lines = [head.join(",")];
  for (const it of design.items) {
    const r = it.rec || {};
    lines.push([it.id, it.group, it.match || "", it.stratum, design.seed, ...names.map((_, bit) => (r.mask & (1 << bit) ? "TRUE" : "FALSE")), r.ts ?? "", r.nc ?? "", r.score ?? "", r.body ?? ""].map(csvEscape).join(","));
  }
  return lines.join("\n") + "\n";
}

function designStamp() { return stamp(Date.now()); }

$("sampleDraw").addEventListener("click", drawSample);
$("sampleManifest").addEventListener("click", () => {
  if (!state.sample) return;
  downloadFile(manifestCsv(state.sample), `design_sample_seed${state.sample.seed}_${state.sample.items.length}posts_${designStamp()}_manifest.csv`, "text/csv");
});
$("sampleFetch").addEventListener("click", () => {
  if (!state.sample || !state.sample.items.length) return;
  const d = state.sample;
  $("designBlock").open = false;
  startIdRun(d.items.map((x) => x.id), { includeComments: $("sampleComments").checked,
    design: { kind: d.kind, seed: d.seed, stratify_by: d.stratify_by, pool: d.pool, pool_size: d.pool_size, population: d.population, filters: d.filters, case_sensitive: d.case_sensitive, posts: d.items.length } });
});

function renderPreview() {
  const name = $("designPreviewFilter").value;
  const pool = (state.snippets[name] || []).slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const show = pool.slice(0, 20);
  $("designPreview").innerHTML = show.length
    ? show.map((s) => `<li><span class="design-dim">${new Date(s.ts * 1000).toISOString().slice(0, 10)} · ${escapeHtml(s.id)}</span> <strong>${escapeHtml(s.title.slice(0, 140))}</strong><br>${escapeHtml(s.before)}<mark>${escapeHtml(s.match)}</mark>${escapeHtml(s.after)}</li>`).join("")
    : `<li class="design-dim">No hits for ${escapeHtml(name)}.</li>`;
}

// ---------------------------------------------------------------- wiring
$("designBlock").addEventListener("toggle", () => { if ($("designBlock").open) refreshSources(); });
$("designRun").addEventListener("click", runFilters);
$("designPreviewFilter").addEventListener("change", renderPreview);
$("designPreviewMore").addEventListener("click", renderPreview);
$("designFiles").addEventListener("change", () => { if ($("designFiles").files.length) $("designSource").value = ""; });
$("designSource").addEventListener("change", () => { if ($("designSource").value) $("designFiles").value = ""; });
