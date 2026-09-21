// Small inline SVG bar charts for the results view. No library, no network, no canvas: strings that the
// page inserts, themed through currentColor and CSS variables. Pure and unit-tested.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function niceNumber(v) {
  if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + "k";
  return String(Math.round(v * 10) / 10);
}

// items: [{ label, value }]; opts: title, format(value) → string, max (fix the scale, e.g. 1 for shares), highlight(i) → boolean
export function barChart(items, { title = "", format = niceNumber, max = null, width = 360, height = 170, highlight = null } = {}) {
  const data = items.filter((d) => Number.isFinite(d.value));
  const top = max ?? Math.max(1e-9, ...data.map((d) => d.value));
  const padL = 8, padR = 8, padT = 36, padB = 30; // headroom so the tallest bar's value label clears the title
  const w = width - padL - padR, h = height - padT - padB;
  const n = Math.max(data.length, 1);
  const step = w / n, bw = Math.max(1, Math.min(42, step * 0.72));
  const showEvery = Math.ceil(n / 8); // at most ~8 x labels so they never collide
  const bars = data.map((d, i) => {
    const bh = top > 0 ? Math.max(d.value > 0 ? 1 : 0, (d.value / top) * h) : 0;
    const x = padL + i * step + (step - bw) / 2, y = padT + h - bh;
    const label = i % showEvery === 0 || i === n - 1 ? `<text x="${(x + bw / 2).toFixed(1)}" y="${height - 12}" text-anchor="middle" class="chart-x">${esc(d.label)}</text>` : "";
    const value = n <= 12 ? `<text x="${(x + bw / 2).toFixed(1)}" y="${(y - 3).toFixed(1)}" text-anchor="middle" class="chart-v">${esc(format(d.value))}</text>` : "";
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" class="chart-bar${highlight && highlight(i) ? " chart-bar-hi" : ""}"><title>${esc(d.label)}: ${esc(format(d.value))}</title></rect>${label}${value}`;
  }).join("");
  const summary = data.length ? `${data.length} bars, from ${format(Math.min(...data.map((d) => d.value)))} to ${format(Math.max(...data.map((d) => d.value)))}` : "no data";
  return `<svg viewBox="0 0 ${width} ${height}" class="chart" role="img" aria-label="${esc(title)}: ${esc(summary)}"><text x="${padL}" y="14" class="chart-title">${esc(title)}</text>` +
    `<line x1="${padL}" y1="${padT + h}" x2="${width - padR}" y2="${padT + h}" class="chart-axis"/>${bars}</svg>`;
}

const pctFormat = (v) => (v * 100).toFixed(v > 0 && v < 0.1 ? 1 : 0) + "%";

// desc: the result of RunStats.result(). Returns [{ id, svg, note }] in display order.
export function descriptiveCharts(desc) {
  if (!desc || !desc.posts) return [];
  const out = [];
  const byDay = desc.days && desc.months.length <= 3 && desc.days.length > 1;
  const volume = byDay ? desc.days.map((d) => ({ label: d.day.slice(5), value: d.posts })) : desc.months.map((m) => ({ label: m.month.slice(2), value: m.posts }));
  if (volume.length > 1) out.push({ id: "volume", svg: barChart(volume, { title: byDay ? "Posts per day" : "Posts per month" }), note: "A sudden step or a hole usually means a gap in collection or in the archive, not in the community." });
  out.push({ id: "comments", svg: barChart(desc.comments_per_post.map((b) => ({ label: b.bucket, value: b.posts })), { title: desc.comments ? "Comments per post (retrieved)" : "Comments per post (Reddit's counter)" }), note: "Most threads are short; a few are very long. Medians describe this better than means." });
  if (desc.months.length > 1) out.push({ id: "intact", svg: barChart(desc.months.map((m) => ({ label: m.month.slice(2), value: m.intact_share })), { title: "Share of post bodies intact, by month", format: pctFormat, max: 1 }), note: "Older months have usually lost more text to removals and deletions." });
  if (desc.authors.top.length > 1) {
    const total = desc.posts + desc.comments;
    out.push({ id: "authors", svg: barChart(desc.authors.top.map((a, i) => ({ label: "#" + (i + 1), value: total ? a.total / total : 0 })), { title: "Ten most active accounts, share of all posts and comments", format: pctFormat }), note: `${desc.authors.unique.toLocaleString("en-US")} accounts in total; the ten most active wrote ${pctFormat(desc.authors.top10_share)}. Accounts are ranked, never named.` });
  }
  if (desc.keywords.length > 1) out.push({ id: "keywords", svg: barChart(desc.keywords.slice(0, 12).map((k) => ({ label: k.query.length > 10 ? k.query.slice(0, 9) + "…" : k.query, value: k.posts })), { title: "Posts found per keyword" }), note: "A post found by several keywords counts for each of them." });
  return out;
}

const api = { barChart, descriptiveCharts, niceNumber };
if (typeof window !== "undefined") window.Charts = api;
export default api;
