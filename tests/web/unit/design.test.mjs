import test from "node:test";
import assert from "node:assert/strict";
import { parseFilters, compileFilters, compileRegex, applyFilters, postText, snippet, monthOf, bodyState, mulberry32, quartileCuts, quartileOf, stratifiedSample, matchControls } from "../../../web/lib/design.js";

const STUDY = `RIVAL = (\\bai (girlfriend|boyfriend|gf|bf|wife|husband|companion|partner|lover|friend)\\b
  |\\bvirtual (girlfriend|boyfriend|partner|companion)\\b
  |\\breplika\\b|\\bcharacter\\.?ai\\b|\\bdeepfake\\b)
TOOL = (\\bchatgpt\\b|\\bchat gpt\\b|\\bgpt\\b|\\bclaude\\b)
BROAD = (\\ba\\.?i\\.?\\b|\\bchatbot\\b|\\bchat bot\\b|\\bai app\\b) OR RIVAL OR TOOL`;

test("filters: multi-line definitions, OR references, case-insensitive by default", () => {
  const { filters, errors } = parseFilters(STUDY);
  assert.deepEqual(errors, []);
  assert.deepEqual(filters.map((f) => f.name), ["RIVAL", "TOOL", "BROAD"]);
  assert.deepEqual(filters[2].refs, ["RIVAL", "TOOL"]);
  const c = compileFilters(filters);
  const hit = (title, selftext = "") => applyFilters(c, postText({ title, selftext }));
  assert.deepEqual(hit("My AI girlfriend left me"), { RIVAL: true, TOOL: false, BROAD: true });
  assert.deepEqual(hit("I asked ChatGPT"), { RIVAL: false, TOOL: true, BROAD: true });
  assert.deepEqual(hit("", "he said A.I. is fine"), { RIVAL: false, TOOL: false, BROAD: true });
  assert.deepEqual(hit("Nothing here", "paid the bill, said hi"), { RIVAL: false, TOOL: false, BROAD: false });
  // a hit through a reference only (Replika is in RIVAL, not in BROAD's own pattern)
  assert.equal(hit("he talks to Replika").BROAD, true);
});

test("filters: errors are reported, never thrown", () => {
  const { filters, errors } = parseFilters("A = (unclosed\nB = ok OR MISSING\nnot a definition\nC = fine\nC = again");
  assert.equal(filters.some((f) => f.name === "A"), false);
  assert.ok(errors.some((e) => /A is not a valid regular expression/.test(e)));
  assert.ok(errors.some((e) => /refers to MISSING/.test(e)));
  assert.ok(errors.some((e) => /defined twice/.test(e)));
  assert.ok(filters.some((f) => f.name === "C"));
});

test("filters: case-sensitive option and snippets", () => {
  const c = compileFilters(parseFilters("X = \\bGPT\\b").filters, { caseSensitive: true });
  assert.equal(applyFilters(c, "gpt").X, false);
  assert.equal(applyFilters(c, "GPT").X, true);
  const s = snippet(compileFilters(parseFilters("X = replika").filters), "X", "a".repeat(200) + " Replika " + "b".repeat(200), 10);
  assert.equal(s.match, "Replika");
  assert.ok(s.before.startsWith("…") && s.after.endsWith("…"));
});

test("word boundaries are Unicode-aware, like Python and R", () => {
  const { regex, unicode } = compileRegex("\\bai\\b");
  assert.equal(unicode, true);
  assert.equal(regex.test("do you like açai?"), false); // ASCII \b would match "ai" after "ç"
  assert.equal(regex.test("my AI, honestly"), true);
  assert.equal(regex.test("said"), false);
  assert.equal(compileRegex("[\\b]x").regex.test("\bx"), true); // \b inside a class stays a backspace
  assert.equal(compileRegex("a\\Bb").regex.test("ab"), true);
  const fallback = compileRegex("\\-ai"); // an identity escape that unicode mode rejects
  assert.equal(fallback.unicode, false);
  assert.equal(fallback.regex.test("x-ai"), true);
});

test("post attributes", () => {
  assert.equal(monthOf(1706745600), "2024-02"); // 2024-02-01T00:00:00Z
  assert.equal(monthOf(1706745599), "2024-01");
  assert.equal(bodyState("[removed]"), "removed");
  assert.equal(bodyState(" [deleted] "), "deleted");
  assert.equal(bodyState(""), "empty");
  assert.equal(bodyState(null), "empty");
  assert.equal(bodyState("real text [removed] inside"), "intact");
});

test("rng is deterministic and roughly uniform", () => {
  const a = mulberry32(42), b = mulberry32(42), c = mulberry32(43);
  const xs = Array.from({ length: 5 }, () => a());
  assert.deepEqual(xs, Array.from({ length: 5 }, () => b()));
  assert.notDeepEqual(xs, Array.from({ length: 5 }, () => c()));
  const r = mulberry32(7); let s = 0; for (let i = 0; i < 20000; i++) s += r();
  assert.ok(Math.abs(s / 20000 - 0.5) < 0.01);
});

test("quartiles keep ties together", () => {
  const cuts = quartileCuts([0, 0, 0, 0, 1, 2, 3, 50]);
  assert.deepEqual(cuts, [0, 1, 3]);
  assert.equal(quartileOf(cuts, 0), 2); // 0 >= first cut (0): ties all land in the same quartile
  assert.equal(quartileOf(cuts, 1), 3);
  assert.equal(quartileOf(cuts, 50), 4);
});

const pop = [];
for (let m = 0; m < 3; m++) for (let i = 0; i < 400; i++) pop.push({ id: `p${m}_${String(i).padStart(3, "0")}`, ts: Date.UTC(2025, m, 1 + (i % 27)) / 1000, nc: i % 40, score: i % 7 });

test("stratified sample: exact size, proportional, reproducible, no duplicates", () => {
  const a = stratifiedSample(pop, { n: 120, by: ["month", "comments_q"], seed: 42 });
  const b = stratifiedSample(pop, { n: 120, by: ["month", "comments_q"], seed: 42 });
  const c = stratifiedSample(pop, { n: 120, by: ["month", "comments_q"], seed: 1 });
  assert.equal(a.sample.length, 120);
  assert.deepEqual(a.sample, b.sample);
  assert.notDeepEqual(a.sample.map((x) => x.id), c.sample.map((x) => x.id));
  assert.equal(new Set(a.sample.map((x) => x.id)).size, 120);
  const perMonth = {}; for (const s of a.sample) perMonth[s.stratum.split("|")[0]] = (perMonth[s.stratum.split("|")[0]] || 0) + 1;
  assert.deepEqual(Object.values(perMonth), [40, 40, 40]);
  assert.equal(a.strata.reduce((n, s) => n + s.sampled, 0), 120);
  assert.equal(stratifiedSample(pop, { fraction: 0.1, seed: 5 }).sample.length, 120);
  assert.equal(stratifiedSample(pop, { n: 99999, seed: 5 }).sample.length, pop.length); // capped at the population
});

test("matched controls: k per target, same stratum, without replacement, shortfall reported", () => {
  const targets = pop.filter((p, i) => i % 50 === 0);
  const candidates = pop.filter((p, i) => i % 50 !== 0);
  const r = matchControls(targets, candidates, { k: 2, seed: 42, population: pop });
  assert.equal(r.controls.length, targets.length * 2);
  assert.equal(r.shortfall.length, 0);
  assert.equal(new Set(r.controls.map((c) => c.id)).size, r.controls.length);
  const tIds = new Set(targets.map((t) => t.id));
  assert.ok(r.controls.every((c) => !tIds.has(c.id) && tIds.has(c.match_post_id)));
  const byId = new Map(pop.map((p) => [p.id, p]));
  assert.ok(r.controls.every((c) => monthOf(byId.get(c.id).ts) === monthOf(byId.get(c.match_post_id).ts)));
  assert.deepEqual(r.controls, matchControls(targets, candidates, { k: 2, seed: 42, population: pop }).controls);
  const starved = matchControls(targets, candidates.slice(0, 3), { k: 2, seed: 42, population: pop });
  assert.ok(starved.shortfall.length > 0);
  assert.equal(starved.controls.length + starved.shortfall.length, targets.length * 2);
});
