// Local cross-check (needs the population files on disk; not part of CI):
// the JS filter logic must reproduce the AI Jealousy study's Python result — 4,937 BROAD posts.
import { createReadStream, readdirSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { homedir } from "node:os";
import { join } from "node:path";
import { CsvParser } from "../../../web/lib/csvstream.js";
import { parseFilters, compileFilters, applyFilters, postText, monthOf, matchControls } from "../../../web/lib/design.js";

const DIR = join(homedir(), "Downloads/LemonSqueeze/relationship_advice_2023-2026");
const FILTERS = String.raw`RIVAL = (\bai (girlfriend|boyfriend|gf|bf|wife|husband|companion|partner|lover|friend)\b
  |\bvirtual (girlfriend|boyfriend|partner|companion)\b
  |\breplika\b|\bcharacter\.?ai\b|\bc\.ai\b|\bjanitor ?ai\b|\bkindroid\b|\bnomi\b
  |\bchai\b|\btalkie\b|\bpolybuzz\b|\bcrushon\b|\bspicychat\b
  |in love with (an? )?(ai|chatbot|bot)\b|dating an? ai\b
  |\bai (porn|nudes|sexting)\b|\bdeepfake\b)
TOOL = (\bchatgpt\b|\bchat gpt\b|\bgpt\b|\bcopilot\b|\bperplexity\b|\bgemini\b
  |\bgrok\b|\bllm\b|\bdeepseek\b|\bbard\b|\bclaude\b)
BROAD = (\ba\.?i\.?\b|\bchatbot\b|\bchat bot\b|\bai app\b) OR RIVAL OR TOOL`;

const { filters, errors } = parseFilters(FILTERS);
if (errors.length) throw new Error(errors.join("; "));
const compiled = compileFilters(filters);
const files = readdirSync(DIR).filter((f) => f.endsWith("_combined.csv.gz") && !f.includes("_merged-")).sort();
const seen = new Set(); const records = []; const perMonth = {}; let broad = 0, rival = 0, tool = 0;
const t0 = Date.now();
for (const f of files) {
  await new Promise((resolve, reject) => {
    let header = null, ix = null;
    const parser = new CsvParser((row) => {
      if (!header) { header = row; ix = { id: row.indexOf("post_id"), title: row.indexOf("post_title"), body: row.indexOf("post_selftext"), ts: row.indexOf("post_created_utc"), nc: row.indexOf("post_num_comments") }; return; }
      const id = row[ix.id]; if (seen.has(id)) return; seen.add(id);
      const hit = applyFilters(compiled, postText({ title: row[ix.title], selftext: row[ix.body] }));
      const ts = Number(row[ix.ts]);
      records.push({ id, ts, nc: Number(row[ix.nc]) || 0, broad: hit.BROAD });
      if (hit.BROAD) { broad++; perMonth[monthOf(ts)] = (perMonth[monthOf(ts)] || 0) + 1; }
      rival += hit.RIVAL; tool += hit.TOOL;
    });
    createReadStream(join(DIR, f)).pipe(createGunzip()).setEncoding("utf8").on("data", (c) => parser.push(c)).on("end", () => { parser.finish(); resolve(); }).on("error", reject);
  });
}
console.log(`${seen.size.toLocaleString()} posts in ${((Date.now() - t0) / 1000).toFixed(0)}s | BROAD ${broad} RIVAL ${rival} TOOL ${tool}`);
console.log("per month:", Object.entries(perMonth).sort().map(([m, c]) => `${m}:${c}`).join(" "));
const targets = records.filter((r) => r.broad), candidates = records.filter((r) => !r.broad);
const mc = matchControls(targets, candidates, { k: 2, seed: 42, population: records });
console.log(`controls ${mc.controls.length}, shortfall ${mc.shortfall.length}`);
const ok = seen.size === 1559339 && broad === 4937 && mc.controls.length === 9874 && mc.shortfall.length === 0;
console.log(ok ? "CROSS-CHECK PASSED (matches the Python study run)" : "CROSS-CHECK FAILED");
process.exit(ok ? 0 : 1);
