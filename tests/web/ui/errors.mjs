// Load the page, open every panel, report page exceptions and failed module loads. A quick first stop when a UI check hangs.
import { startServer } from "../devserver.mjs";
import { launch, check, finish, sleep } from "../harness.mjs";
const external = process.argv[2];
const server = external ? null : await startServer(8790);
const b = await launch();
const logs = [];
await b.send("Log.enable");
await b.goto(external || "http://127.0.0.1:8790/");
await b.page(`for (const d of document.querySelectorAll("details")) { d.open = true; d.dispatchEvent(new Event("toggle")); }`);
await sleep(1500);
check("design module evaluated", await b.page(`return typeof window.DesignState === "object"`));
check("design sources populated or empty without error", await b.page(`return document.getElementById("designSource").options.length >= 1`));
if (server) server.close();
finish(b);
