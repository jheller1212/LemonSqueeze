// Smoke check: the page loads under the production CSP, Analyze works end to end, nothing throws.
//   node tests/web/ui/smoke.mjs            (starts its own dev server)
//   node tests/web/ui/smoke.mjs <url>      (against a deployed site)
import { startServer } from "../devserver.mjs";
import { launch, check, finish } from "../harness.mjs";

const external = process.argv[2];
const server = external ? null : await startServer(8791);
const url = external || "http://127.0.0.1:8791/";
const b = await launch();
await b.goto(url);
check("page title", (await b.page(`return document.title`)).includes("LemonSqueeze"));
check("core modules loaded", await b.page(`return typeof RunStore === "object" && typeof Archive === "object" && typeof RunLog === "object" && typeof window.Mappers === "object"`));
await b.page(`document.getElementById("subreddit").value = "MyBoyfriendIsAI"; document.getElementById("analyzeBtn").click();`);
await b.waitFor(`return document.getElementById("collectionEstimate").innerText.length > 0`, { timeout: 90000 });
check("analysis shows scope cards", await b.page(`return !!document.getElementById("scopeRange") && document.getElementById("scopeAllSummary").innerText.length > 1`));
check("squeeze button enabled", await b.page(`return !document.getElementById("scrapeBtn").disabled`));
if (server) server.close();
finish(b);
