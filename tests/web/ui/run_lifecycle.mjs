// Trial-user regressions around a run's life: the panel shows a run at once, one run at a time (double Resume, second start),
// a batch WITH comments chains and is shown as running, and an empty result never looks like a downloaded dataset.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../devserver.mjs";
import { launch, check, finish, sleep } from "../harness.mjs";

const external = process.argv[2];
const server = external ? null : await startServer(8803);
const url = external || "http://127.0.0.1:8803/";
const dl = join(tmpdir(), "ls-lifecycle-dl");
const b = await launch({ downloadDir: dl });
const analyze = async (sub) => { await b.page(`window.showSaveFilePicker = undefined; document.getElementById("subreddit").value = arg; document.getElementById("analyzeBtn").click();`, sub); await b.waitFor(`return document.getElementById("collectionEstimate").innerText.length > 0`, { timeout: 90000 }); };
const chips = () => b.page(`return document.getElementById("runsChips").innerText.replace(/\\s+/g, " ")`);

// --- 1. the panel shows a run the moment it starts; a second start is refused ---
await b.goto(url);
await analyze("MyBoyfriendIsAI");
await b.page(`document.getElementById("scopeCount").checked = true; document.getElementById("scopeCount").dispatchEvent(new Event("change", { bubbles: true }));
  const l = document.getElementById("limit"); l.value = 1200; l.dispatchEvent(new Event("input")); document.getElementById("scrapeBtn").click();`);
await sleep(3000);
let c = await chips();
check("the runs panel shows the run within 3 s of starting", /1 run/.test(c) && /running now: r\/MyBoyfriendIsAI/.test(c), c);
await b.page(`startScrape();`); await sleep(800);
const second = await b.page(`return { err: document.getElementById("errorText").textContent, visible: !document.getElementById("error").classList.contains("hidden"), runs: (await RunStore.listRuns()).length }`);
check("starting again while one runs is refused with a message; no second run is created", second.visible && /already running/.test(second.err) && second.runs === 1, second.err);

// --- 2. stop, then a double-clicked Resume resumes once and keeps going ---
await sleep(4000);
await b.page(`document.getElementById("stopBtn").click();`);
await b.waitFor(`return !abortController`, { timeout: 60000 });
const stopped = await b.page(`const r = (await RunStore.listRuns())[0]; return { status: r.status, posts: r.counts.posts }`);
c = await chips();
check("a deliberate Stop reads as paused, not failed", stopped.status === "stopped" && /1 paused/.test(c) && !/failed/.test(c), c);
await b.page(`document.getElementById("error").classList.add("hidden"); if (!document.getElementById("resumeBanner").classList.contains("open")) document.getElementById("runsBar").click();`);
await b.waitFor(`return !!document.querySelector(".run-resume")`);
await b.page(`const btn = document.querySelector(".run-resume"); btn.click(); btn.click();`);
await sleep(9000);
const resumed = await b.page(`const rs = await RunStore.listRuns(); return { n: rs.length, active: !!abortController, posts: rs[0].counts.posts, memPosts: currentRun ? currentRun.counts.posts : 0, status: document.getElementById("statusText").textContent.slice(0, 90) }`);
check("after a double-clicked Resume exactly one run is active and still collecting", resumed.n === 1 && resumed.active, JSON.stringify(resumed));
await b.page(`document.getElementById("stopBtn").click();`);
await b.waitFor(`return !abortController`, { timeout: 60000 });
const after = await b.page(`const r = (await RunStore.listRuns())[0]; const posts = await RunStore.getPosts(r.id); return { posts: posts.length, unique: new Set(posts.map(p => p.id)).size }`);
check("resuming continued the same run without duplicating posts", after.posts > stopped.posts && after.posts === after.unique, `${stopped.posts} → ${after.posts} (${after.unique} unique)`);

// --- 3. a batch WITH comments chains by itself and the panel says which run is running ---
await b.page(`for (const r of await RunStore.listRuns()) await RunStore.deleteRun(r.id);`);
await b.goto(url);
await analyze("MyBoyfriendIsAI");
await b.page(`document.getElementById("scopeCount").checked = true; document.getElementById("scopeCount").dispatchEvent(new Event("change", { bubbles: true }));
  const l = document.getElementById("limit"); l.value = 25; l.dispatchEvent(new Event("input")); document.getElementById("includeComments").checked = true;
  document.getElementById("extraSubs").value = "replika"; document.getElementById("scrapeBtn").click();`);
let sawSecond = false;
for (let i = 0; i < 300; i++) {
  await sleep(1000);
  c = await chips();
  if (/running now: r\/replika/i.test(c)) sawSecond = true;
  const st = await b.page(`const rs = (await RunStore.listRuns()).filter(r => r.batch); return rs.length === 2 && rs.every(r => r.status === "complete") && !abortController`);
  if (st) break;
}
const batch = await b.page(`const rs = (await RunStore.listRuns()).filter(r => r.batch).sort((a, b) => a.batch.index - b.batch.index); return rs.map(r => [r.subreddit, r.status, r.counts.posts, r.counts.comments])`);
check("both runs of a with-comments batch finished on their own", batch.length === 2 && batch.every((r) => r[1] === "complete" && r[2] === 25 && r[3] > 0), JSON.stringify(batch));
check("while the second run collected, the panel said it was running (not queued)", sawSecond);

// --- 4. an empty result is called empty ---
await b.goto(url);
await analyze("MyBoyfriendIsAI");
await b.page(`document.getElementById("scopeRange").checked = true; document.getElementById("scopeRange").dispatchEvent(new Event("change", { bubbles: true }));
  const tf = document.getElementById("timeFilter"); tf.value = "week"; tf.dispatchEvent(new Event("change"));
  const k = document.getElementById("keywords"); k.value = "zzxqvnonexistentkeyword"; k.dispatchEvent(new Event("input")); document.getElementById("extraSubs").value = "";`);
await sleep(1000);
const filesBefore = b.files().length;
await b.page(`document.getElementById("scrapeBtn").click();`);
await b.waitFor(`return /^Done/.test(document.getElementById("statusText").textContent) && !abortController`, { timeout: 300000 });
await sleep(2000);
const empty = await b.page(`return { status: document.getElementById("runStatus").innerText, sub: document.getElementById("resultsSubtitle").textContent }`);
check("an empty run says so, explains keyword search, and does not claim a download", /No posts were found/.test(empty.status) && /not a census/.test(empty.status) && !/downloaded automatically/.test(empty.status) && /without finding any posts/.test(empty.sub), empty.status.slice(0, 260));
check("no file was written for an empty run", b.files().length === filesBefore);

// --- 5. the sticky Squeeze bar is opaque ---
const bg = await b.page(`return getComputedStyle(document.getElementById("squeezeBar")).backgroundColor`);
check("the sticky Squeeze bar has an opaque background", /^rgb\(/.test(bg), bg);
if (server) server.close();
finish(b);
