// Regression for a trial-user blocker: after a REAL collection, the Design panel must offer that run as a population,
// however the panel was opened (real click on the summary, already open while the run finished, or after a reload).
import { startServer } from "../devserver.mjs";
import { launch, check, finish, sleep } from "../harness.mjs";

const external = process.argv[2];
const server = external ? null : await startServer(8802);
const url = external || "http://127.0.0.1:8802/";
const b = await launch();
await b.goto(url);
const options = () => b.page(`return [...document.getElementById("designSource").options].map(o => o.textContent.trim())`);
const clickSummary = async () => { // a real mouse click, as a person would do it
  const r = await b.page(`const s = document.querySelector("#designBlock > summary"); s.scrollIntoView({ block: "center" }); const q = s.getBoundingClientRect(); return { x: q.left + 40, y: q.top + 12 }`);
  await b.send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 });
  await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 1 });
  await sleep(600);
};

// the panel is open BEFORE and WHILE the collection runs
await clickSummary();
check("panel opens on a real click", await b.page(`return document.getElementById("designBlock").open`));
await b.page(`window.showSaveFilePicker = undefined; document.getElementById("subreddit").value = "MyBoyfriendIsAI"; document.getElementById("analyzeBtn").click();`);
await b.waitFor(`return document.getElementById("collectionEstimate").innerText.length > 0`, { timeout: 90000 });
await b.page(`document.getElementById("scopeCount").checked = true; document.getElementById("scopeCount").dispatchEvent(new Event("change", { bubbles: true }));
  const l = document.getElementById("limit"); l.value = 60; l.dispatchEvent(new Event("input"));
  const ic = document.getElementById("includeComments"); ic.checked = false; ic.dispatchEvent(new Event("change"));
  document.getElementById("scrapeBtn").click();`);
await b.waitFor(`return /^Done/.test(document.getElementById("statusText").textContent)`, { timeout: 240000 });
await sleep(1500);
let opts = await options();
check("a run that finished while the panel was open appears without reopening it", opts.some((o) => /MyBoyfriendIsAI/.test(o) && /60 posts/.test(o)), JSON.stringify(opts));

// after a reload, opened by a real click
await b.goto(url);
await clickSummary();
opts = await options();
check("after a reload the saved run is offered", opts.some((o) => /MyBoyfriendIsAI/.test(o)), JSON.stringify(opts));

// opened from script without any event (what an automated user does)
await b.goto(url);
await b.page(`document.getElementById("designBlock").open = true;`);
await sleep(1200);
opts = await options();
check("opened programmatically, the list still fills", opts.some((o) => /MyBoyfriendIsAI/.test(o)), JSON.stringify(opts));
if (server) server.close();
finish(b);
