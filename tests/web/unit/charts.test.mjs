import test from "node:test";
import assert from "node:assert/strict";
import { barChart, descriptiveCharts, niceNumber } from "../../../web/lib/charts.js";
import { createRunStats } from "../../../web/lib/runstats.js";

test("bar chart: one rect per value, scaled, labelled, accessible", () => {
  const svg = barChart([{ label: "a", value: 10 }, { label: "b", value: 5 }, { label: "c", value: 0 }], { title: "Test" });
  assert.equal((svg.match(/<rect /g) || []).length, 3);
  const heights = [...svg.matchAll(/height="([\d.]+)" rx/g)].map((m) => Number(m[1]));
  assert.ok(Math.abs(heights[0] - 2 * heights[1]) < 0.2 && heights[2] === 0);
  assert.match(svg, /role="img" aria-label="Test: 3 bars, from 0 to 10"/);
  assert.match(svg, /<title>a: 10<\/title>/);
});

test("labels are escaped; many bars thin out their x labels; empty data does not throw", () => {
  const svg = barChart([{ label: '<img src=x onerror="1">', value: 1 }], { title: "x & y" });
  assert.ok(!svg.includes("<img") && svg.includes("&lt;img") && svg.includes("x &amp; y"));
  const many = barChart(Array.from({ length: 40 }, (_, i) => ({ label: "m" + i, value: i })), { title: "many" });
  assert.equal((many.match(/<rect /g) || []).length, 40);
  assert.ok((many.match(/class="chart-x"/g) || []).length <= 10);
  assert.ok((many.match(/class="chart-v"/g) || []).length === 0);
  assert.match(barChart([], { title: "none" }), /no data/);
});

test("number formatting", () => {
  assert.deepEqual([niceNumber(950), niceNumber(1500), niceNumber(25000), niceNumber(1559339), niceNumber(0.25)], ["950", "1.5k", "25k", "1.6M", "0.3"]);
});

test("descriptive charts follow the data: daily for short runs, monthly otherwise, keywords only when several", () => {
  const s = createRunStats();
  for (let i = 0; i < 60; i++) s.add({ id: "p" + i, author: "u" + (i % 5), selftext: i % 3 ? "text" : "[removed]", created_utc: Date.UTC(2025, 0, 1 + (i % 20)) / 1000, num_comments: i % 9, query: i % 2 ? "ai" : "gpt", comments: [] });
  const charts = descriptiveCharts(s.result());
  assert.deepEqual(charts.map((c) => c.id), ["volume", "comments", "authors", "keywords"]); // one month only → no intact-by-month chart
  assert.match(charts[0].svg, /Posts per day/);
  assert.equal((charts[0].svg.match(/<rect /g) || []).length, 20);
  assert.match(charts[2].note, /ranked, never named/);
  assert.ok(!charts[2].svg.includes("u0")); // no account name anywhere in the authors chart
  const long = createRunStats();
  for (let m = 0; m < 6; m++) for (let i = 0; i < 5; i++) long.add({ id: `q${m}_${i}`, author: "a", selftext: "t", created_utc: Date.UTC(2024, m, 5 + i) / 1000, num_comments: 1, comments: [] });
  const lc = descriptiveCharts(long.result());
  assert.deepEqual(lc.map((c) => c.id), ["volume", "comments", "intact"]);
  assert.match(lc[0].svg, /Posts per month/);
  assert.deepEqual(descriptiveCharts(createRunStats().result()), []);
});
