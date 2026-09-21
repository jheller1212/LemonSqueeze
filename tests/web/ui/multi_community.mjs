// Several communities in one study: validation, one batch, automatic chaining, labelled merged file.
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../devserver.mjs";
import { launch, check, finish, sleep } from "../harness.mjs";
import { parseCsv } from "../../../web/lib/csvstream.js";

const external = process.argv[2];
const server = external ? null : await startServer(8799);
const url = external || "http://127.0.0.1:8799/";
const dl = join(tmpdir(), "ls-multi-dl");
const b = await launch({ downloadDir: dl });
await b.goto(url);
await b.page(`window.showSaveFilePicker = undefined; document.getElementById("subreddit").value = "MyBoyfriendIsAI"; document.getElementById("analyzeBtn").click();`);
await b.waitFor(`return document.getElementById("collectionEstimate").innerText.length > 0`, { timeout: 90000 });
const setup = async (extras) => b.page(`
  document.getElementById("scopeCount").checked = true; document.getElementById("scopeCount").dispatchEvent(new Event("change", { bubbles: true }));
  const l = document.getElementById("limit"); l.value = 30; l.dispatchEvent(new Event("input"));
  const ic = document.getElementById("includeComments"); ic.checked = false; ic.dispatchEvent(new Event("change"));
  document.getElementById("extraSubs").value = arg;`, extras);

// a name that does not exist stops the study before anything is created
await setup("replika, zzqx_nosuchsub_9");
await b.page(`document.getElementById("scrapeBtn").click();`);
await b.waitFor(`return !document.getElementById("error").classList.contains("hidden")`, { timeout: 60000 });
const err = await b.page(`return { text: document.getElementById("errorText").textContent, runs: (await RunStore.listRuns()).length, running: !!abortController }`);
check("an unknown community is reported and nothing starts", /zzqx_nosuchsub_9 was not found/.test(err.text) && err.runs === 0 && !err.running, err.text);
await setup("not a name!, replika");
await b.page(`document.getElementById("error").classList.add("hidden"); document.getElementById("scrapeBtn").click();`);
await b.waitFor(`return !document.getElementById("error").classList.contains("hidden")`, { timeout: 30000 });
check("malformed names are rejected with guidance", /Not a community name/.test(await b.page(`return document.getElementById("errorText").textContent`)));

// three communities, 30 newest posts each
await setup("replika, r/CharacterAI, https://www.reddit.com/r/replika/");
await b.page(`document.getElementById("error").classList.add("hidden"); document.getElementById("scrapeBtn").click();`);
await b.waitFor(`return (async () => { const rs = (await RunStore.listRuns()).filter(r => r.batch); return rs.length === 3 && rs.every(r => r.status === "complete") && !abortController; })()`, { timeout: 420000, every: 1500 });
await sleep(3000);
const runs = await b.page(`const rs = (await RunStore.listRuns()).filter(r => r.batch).sort((a, b) => a.batch.index - b.batch.index); const out = [];
  for (const r of rs) { const posts = await RunStore.getPosts(r.id); out.push({ sub: r.subreddit, n: posts.length, own: posts.every(p => String(p.subreddit).toLowerCase() === r.subreddit.toLowerCase()), comms: r.batch.communities, total: r.batch.total }); } return out;`);
check("one batch of three runs, duplicate community ignored", runs.length === 3 && runs.every((r) => r.total === 3) && runs.map((r) => r.sub.toLowerCase()).join(",") === "myboyfriendisai,replika,characterai", JSON.stringify(runs.map((r) => r.sub)));
check("each run holds its own community's posts", runs.every((r) => r.n === 30 && r.own), JSON.stringify(runs.map((r) => [r.sub, r.n, r.own])));
const perRun = b.files().filter((f) => f.endsWith("_combined.csv"));
check("each run downloaded its own file", perRun.length === 3 && ["MyBoyfriendIsAI", "replika", "CharacterAI"].every((s) => perRun.some((f) => f.toLowerCase().includes(s.toLowerCase()))), perRun.join(" | "));

await b.goto(url);
await b.page(`window.showSaveFilePicker = undefined; document.getElementById("runsBar").click();`);
await b.waitFor(`return !!document.querySelector(".run-group")`);
const card = await b.page(`const g = document.querySelector(".run-group"); g.querySelector(".group-toggle").click(); return { title: g.querySelector(".run-group-head .run-title").textContent, rows: [...g.querySelectorAll(".run-row .run-title")].map(e => e.textContent) }`);
check("the batch card names the communities and its rows say which is which", /r\/MyBoyfriendIsAI, r\/replika, r\/CharacterAI/i.test(card.title) && card.rows.length === 3 && card.rows.every((t) => /^r\//.test(t)), JSON.stringify(card));
await b.page(`document.querySelector(".run-group .group-merged").click();`);
await sleep(4000);
const merged = b.files().find((f) => /_3subs_merged-3runs_.*_combined\.csv$/.test(f));
check("merged file named for a multi-community study", !!merged, b.files().join(" | "));
if (merged) {
  const rows = parseCsv(readFileSync(join(dl, merged), "utf8")); const h = rows[0];
  const subs = new Set(rows.slice(1).map((r) => r[h.indexOf("subreddit")].toLowerCase())), labels = new Set(rows.slice(1).map((r) => r[h.indexOf("run_label")]));
  check("merged rows: 90 posts, three communities, run_label names the community", rows.length === 91 && subs.size === 3 && [...labels].every((l) => /^r\//.test(l)) && labels.size === 3, [...labels].join(" | "));
}
if (server) server.close();
finish(b);
