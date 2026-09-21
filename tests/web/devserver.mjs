// Local dev server for UI checks: serves web/ and proxies /api/* to the production functions,
// so a change can be exercised in a real browser in seconds without a deploy.
//   node tests/web/devserver.mjs [port]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "web");
const PROD = "https://redditscrapersbe.netlify.app";
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json" };

export function startServer(port = 8787) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/api/")) {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const upstream = await fetch(PROD + url.pathname + url.search, { method: req.method, headers: { "Content-Type": req.headers["content-type"] || "application/json" }, body: chunks.length ? Buffer.concat(chunks) : undefined });
        res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") || "application/json" });
        res.end(Buffer.from(await upstream.arrayBuffer()));
        return;
      }
      const rel = normalize(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
      const body = await readFile(join(ROOT, rel));
      // the same CSP as production, so a CSP violation shows up locally too
      res.writeHead(200, { "Content-Type": TYPES[extname(rel)] || "application/octet-stream", "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: https:; connect-src 'self' https://arctic-shift.photon-reddit.com; font-src 'self' https://fonts.gstatic.com" });
      res.end(body);
    } catch (err) {
      res.writeHead(404, { "Content-Type": "text/plain" }); res.end("not found");
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2]) || 8787;
  await startServer(port);
  console.log(`LemonSqueeze dev server on http://127.0.0.1:${port} (API proxied to ${PROD})`);
}
