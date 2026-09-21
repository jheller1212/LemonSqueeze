// Study-design logic, free of DOM and network so it can be unit-tested in Node and
// run inside a Web Worker: named regex filters, strata, seeded sampling, matched controls.

// ---------------------------------------------------------------- filters
// One filter per line:   NAME = regex
// A line that starts with whitespace or "|" continues the previous regex (long
// alternations read better on several lines). "OR OTHER_NAME" at the end of a
// definition includes an earlier filter:   BROAD = (\bai\b|\bchatbot\b) OR RIVAL OR TOOL
export function parseFilters(text) {
  const filters = [];
  const errors = [];
  let current = null;
  const lines = String(text || "").split(/\r?\n/);
  lines.forEach((raw, i) => {
    if (!raw.trim() || raw.trim().startsWith("#")) return;
    const def = raw.match(/^([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (def && !/^\s/.test(raw)) {
      current = { name: def[1].toUpperCase(), body: def[2].trim(), line: i + 1 };
      filters.push(current);
    } else if (current && /^(\s|\|)/.test(raw)) {
      current.body += raw.trim();
    } else {
      errors.push(`Line ${i + 1}: expected "NAME = regex"`);
    }
  });
  const names = new Set();
  const out = [];
  for (const f of filters) {
    if (names.has(f.name)) { errors.push(`Line ${f.line}: filter ${f.name} is defined twice`); continue; }
    let source = f.body;
    const refs = [];
    for (;;) {
      const m = source.match(/\s+OR\s+([A-Za-z][A-Za-z0-9_]*)\s*$/);
      if (!m) break;
      refs.unshift(m[1].toUpperCase());
      source = source.slice(0, m.index);
    }
    for (const r of refs) if (!names.has(r)) errors.push(`Line ${f.line}: ${f.name} refers to ${r}, which is not defined above it`);
    if (!source.trim() && !refs.length) { errors.push(`Line ${f.line}: ${f.name} has no pattern`); continue; }
    if (source.trim()) {
      try { new RegExp(source, "i"); } catch (e) { errors.push(`Line ${f.line}: ${f.name} is not a valid regular expression (${e.message})`); continue; }
    }
    names.add(f.name);
    out.push({ name: f.name, source: source.trim(), refs });
  }
  return { filters: out, errors };
}

// JavaScript's \b is ASCII-only: "açai" would match \bai\b because "ç" counts as a
// non-word character. Python and R treat letters of every script as word
// characters, so the boundary is rewritten as Unicode-aware lookarounds and the
// pattern compiled in unicode mode. Patterns that are not valid in unicode mode
// fall back to the plain engine (ASCII boundaries) and are marked as such.
const W = "[\\p{L}\\p{N}_]";
const UNICODE_B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;
const UNICODE_NOT_B = `(?:(?<=${W})(?=${W})|(?<!${W})(?!${W}))`;
export function unicodeBoundaries(source) {
  let out = "";
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\" && i + 1 < source.length) {
      const next = source[i + 1];
      if (!inClass && next === "b") out += UNICODE_B;
      else if (!inClass && next === "B") out += UNICODE_NOT_B;
      else out += ch + next;
      i++;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    out += ch;
  }
  return out;
}

export function compileRegex(source, { caseSensitive = false } = {}) {
  const flags = caseSensitive ? "" : "i";
  try { return { regex: new RegExp(unicodeBoundaries(source), flags + "u"), unicode: true }; }
  catch { return { regex: new RegExp(source, flags), unicode: false }; }
}

export function compileFilters(filters, opts = {}) {
  return filters.map((f) => (f.source ? { ...f, ...compileRegex(f.source, opts) } : { ...f, regex: null, unicode: true }));
}

// The text a filter sees: title and body, the way researchers usually define it.
export function postText(post) {
  return (post.title || "") + " \n " + (post.selftext || "");
}

// -> { NAME: true|false } ; refs are resolved in definition order
export function applyFilters(compiled, text) {
  const hit = {};
  for (const f of compiled) {
    hit[f.name] = (f.regex ? f.regex.test(text) : false) || f.refs.some((r) => hit[r]);
  }
  return hit;
}

// A short excerpt around the first match, split so the caller can escape and highlight it.
export function snippet(compiled, name, text, radius = 90) {
  const f = compiled.find((x) => x.name === name);
  let m = f && f.regex ? f.regex.exec(text) : null;
  if (!m && f) for (const r of f.refs) { const s = snippet(compiled, r, text, radius); if (s) return s; }
  if (!m) return null;
  const start = Math.max(0, m.index - radius), end = Math.min(text.length, m.index + m[0].length + radius);
  return { before: (start > 0 ? "…" : "") + text.slice(start, m.index), match: m[0], after: text.slice(m.index + m[0].length, end) + (end < text.length ? "…" : "") };
}

// ---------------------------------------------------------------- post attributes
export function monthOf(ts) {
  const d = new Date(Number(ts) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// What is left of the post body: the archive keeps the text it saw, Reddit's
// placeholders mark what was taken down before that.
export function bodyState(selftext) {
  const t = String(selftext ?? "").trim();
  if (t === "") return "empty";
  if (t === "[removed]") return "removed";
  if (t === "[deleted]") return "deleted";
  return "intact";
}

// ---------------------------------------------------------------- seeded randomness
export function mulberry32(seed) {
  let a = (Number(seed) >>> 0) || 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------------------------------------------------------------- strata
// Quartile cut points are order statistics of the group's own values; a value's
// quartile is 1 + the number of cut points <= it (so ties stay together).
export function quartileCuts(values) {
  const v = values.slice().sort((a, b) => a - b);
  if (!v.length) return [0, 0, 0];
  return [0.25, 0.5, 0.75].map((f) => v[Math.min(v.length - 1, Math.floor(v.length * f))]);
}
export function quartileOf(cuts, value) {
  let q = 1;
  for (const c of cuts) if (value >= c) q++;
  return Math.min(q, 4);
}

// records: [{ id, ts, nc, score }]; by: subset of ["month", "comments_q", "score_q"].
// Quartiles are computed within the month when "month" is a stratifier, else overall.
export function strataKeys(records, by) {
  const useMonth = by.includes("month");
  const groups = new Map();
  for (const r of records) {
    const g = useMonth ? monthOf(r.ts) : "all";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  const cuts = new Map();
  for (const [g, rs] of groups) cuts.set(g, { nc: quartileCuts(rs.map((r) => r.nc || 0)), score: quartileCuts(rs.map((r) => r.score || 0)) });
  const keyOf = (r) => {
    const g = useMonth ? monthOf(r.ts) : "all";
    const parts = [];
    if (useMonth) parts.push(g);
    if (by.includes("comments_q")) parts.push("cq" + quartileOf(cuts.get(g).nc, r.nc || 0));
    if (by.includes("score_q")) parts.push("sq" + quartileOf(cuts.get(g).score, r.score || 0));
    return parts.join("|") || "all";
  };
  return { keyOf, cuts };
}

// ---------------------------------------------------------------- sampling
// Proportional allocation across strata (largest remainder), simple random
// sampling without replacement inside each stratum. Deterministic for a seed:
// strata are processed in sorted key order and records in sorted id order.
export function stratifiedSample(records, { n = null, fraction = null, by = [], seed = 42 } = {}) {
  const total = records.length;
  const want = Math.max(0, Math.min(total, n != null ? Math.round(n) : Math.round(total * (fraction || 0))));
  const { keyOf } = strataKeys(records, by);
  const strata = new Map();
  for (const r of records) { const k = keyOf(r); if (!strata.has(k)) strata.set(k, []); strata.get(k).push(r); }
  const keys = Array.from(strata.keys()).sort();
  const alloc = keys.map((k) => { const exact = (strata.get(k).length / Math.max(total, 1)) * want; return { k, size: strata.get(k).length, take: Math.floor(exact), rem: exact - Math.floor(exact) }; });
  let left = want - alloc.reduce((s, a) => s + a.take, 0);
  for (const a of alloc.slice().sort((x, y) => y.rem - x.rem || (x.k < y.k ? -1 : 1))) { if (left <= 0) break; if (a.take < a.size) { a.take++; left--; } }
  const rng = mulberry32(seed);
  const sample = [];
  for (const a of alloc) {
    const pool = strata.get(a.k).slice().sort((x, y) => (x.id < y.id ? -1 : 1));
    shuffle(pool, rng);
    for (const r of pool.slice(0, a.take)) sample.push({ id: r.id, stratum: a.k });
  }
  return { sample, strata: alloc.map(({ k, size, take }) => ({ stratum: k, population: size, sampled: take })), seed, requested: want };
}

// ---------------------------------------------------------------- matched controls
// For every target, k controls from the same stratum (month and/or quartile),
// drawn without replacement from the non-target candidates. Pools are shuffled
// once per stratum; targets are served in sorted id order.
export function matchControls(targets, candidates, { k = 2, by = ["month", "comments_q"], seed = 42, population = null } = {}) {
  const { keyOf } = strataKeys(population || targets.concat(candidates), by);
  const rng = mulberry32(seed);
  const pools = new Map();
  for (const c of candidates.slice().sort((x, y) => (x.id < y.id ? -1 : 1))) { const key = keyOf(c); if (!pools.has(key)) pools.set(key, []); pools.get(key).push(c); }
  for (const key of Array.from(pools.keys()).sort()) shuffle(pools.get(key), rng);
  const controls = [], shortfall = [];
  for (const t of targets.slice().sort((x, y) => (x.id < y.id ? -1 : 1))) {
    const key = keyOf(t);
    const pool = pools.get(key) || [];
    for (let i = 0; i < k; i++) {
      const c = pool.pop();
      if (c) controls.push({ id: c.id, match_post_id: t.id, stratum: key });
      else shortfall.push({ target: t.id, stratum: key });
    }
  }
  return { controls, shortfall, seed, k, by };
}

const api = { parseFilters, compileFilters, compileRegex, unicodeBoundaries, postText, applyFilters, snippet, monthOf, bodyState, mulberry32, shuffle, quartileCuts, quartileOf, strataKeys, stratifiedSample, matchControls };
if (typeof window !== "undefined") window.Design = api;
export default api;
