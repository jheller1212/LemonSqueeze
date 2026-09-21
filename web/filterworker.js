// Runs researcher-supplied regular expressions off the main thread. A pattern with
// catastrophic backtracking can hang a regex engine for minutes; in a worker the page
// stays responsive and the caller can terminate the worker when a batch overruns.
import { compileFilters, applyFilters, postText, snippet } from "./lib/design.js";

let compiled = [];

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "init") {
    compiled = compileFilters(msg.filters, { caseSensitive: !!msg.caseSensitive });
    self.postMessage({ type: "ready", engines: compiled.map((f) => ({ name: f.name, unicode: f.unicode })) });
    return;
  }
  if (msg.type === "batch") {
    const masks = new Uint32Array(msg.posts.length);
    const snippets = [];
    msg.posts.forEach((p, i) => {
      const text = postText(p);
      const hit = applyFilters(compiled, text);
      let mask = 0;
      compiled.forEach((f, bit) => {
        if (!hit[f.name]) return;
        mask |= 1 << bit;
        const s = snippet(compiled, f.name, text, 110);
        if (s) snippets.push({ i, name: f.name, ...s });
      });
      masks[i] = mask;
    });
    self.postMessage({ type: "result", batch: msg.batch, masks, snippets }, [masks.buffer]);
  }
};
