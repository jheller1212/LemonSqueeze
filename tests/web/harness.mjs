// Headless-Chrome harness for UI checks over the DevTools protocol. Lessons baked in:
// - every page expression runs inside an IIFE (a top-level `const` would persist and break the next step silently)
// - page exceptions and JS dialogs are captured/handled, never ignored
// - downloads go to a real directory so files can be inspected
// - checks ASSERT; a test that only prints cannot fail
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ port = 9400 + Math.floor(Math.random() * 400), downloadDir = null, windowSize = "1280,1400" } = {}) {
  const profile = join(tmpdir(), `ls-ui-${process.pid}-${port}`);
  rmSync(profile, { recursive: true, force: true });
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check", `--window-size=${windowSize}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  let target;
  for (let i = 0; i < 80 && !target; i++) { await sleep(250); try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === "page"); } catch { /* not up yet */ } }
  if (!target) throw new Error("Chrome did not start");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const errors = [], downloads = [];
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description?.split("\n")[0] || d.params.exceptionDetails.text);
    if (d.method === "Page.javascriptDialogOpening") send("Page.handleJavaScriptDialog", { accept: true });
    if (d.method === "Browser.downloadWillBegin") downloads.push(d.params.suggestedFilename);
  };
  await send("Runtime.enable"); await send("Page.enable");
  if (downloadDir) { rmSync(downloadDir, { recursive: true, force: true }); mkdirSync(downloadDir, { recursive: true }); await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir, eventsEnabled: true }); }

  // body is a function body; it may be async and must `return` a JSON-serialisable value
  const page = async (body, arg) => {
    const expr = `(async (arg) => { ${body} })(${JSON.stringify(arg ?? null)})`;
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error("page: " + (r.result.exceptionDetails.exception?.description?.split("\n")[0] || r.result.exceptionDetails.text));
    return r.result?.result?.value;
  };
  // Wait for the load event, not for a fixed time: deferred and module scripts have all run once readyState is "complete".
  const goto = async (url, settle = 400) => {
    await send("Page.navigate", { url });
    const t0 = Date.now();
    for (;;) {
      await sleep(150);
      let state = "";
      try { state = await page(`return document.readyState + "|" + location.href`); } catch { /* navigating */ }
      if (state.startsWith("complete|") && !state.endsWith("about:blank")) break;
      if (Date.now() - t0 > 30000) throw new Error(`page did not finish loading: ${url}`);
    }
    await sleep(settle);
  };
  const waitFor = async (body, { timeout = 60000, every = 500, arg } = {}) => {
    const t0 = Date.now();
    for (;;) { const v = await page(body, arg); if (v) return v; if (Date.now() - t0 > timeout) throw new Error(`waitFor timed out: ${body.slice(0, 80)}`); await sleep(every); }
  };
  const screenshot = async (path, clip) => { const { writeFileSync } = await import("node:fs"); const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) } /* clip is in document coordinates */); writeFileSync(path, Buffer.from(shot.result.data, "base64")); };
  // Chrome is still flushing its profile when it gets the signal; removal is best effort
  const close = () => { try { ws.close(); } catch { /* ignore */ } chrome.kill(); try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp dir; the OS cleans it */ } };
  const files = () => (downloadDir ? readdirSync(downloadDir).filter((f) => !f.endsWith(".crdownload")) : []);
  return { send, page, goto, waitFor, screenshot, close, errors, downloads, files };
}

let failures = 0;
export function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}
export function finish(browser) {
  if (browser) { check("no page exceptions", browser.errors.length === 0, browser.errors.slice(0, 3).join(" | ")); browser.close(); }
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}
