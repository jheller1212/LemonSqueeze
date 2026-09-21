// Thread structure exports on a REAL thread set: fetch a few real posts with comments, export the edge list and the
// summaries, and cross-check them against the combined CSV of the same run.
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../devserver.mjs";
import { launch, check, finish, sleep } from "../harness.mjs";
import { parseCsv } from "../../../web/lib/csvstream.js";

const external = process.argv[2];
const server = external ? null : await startServer(8797);
const url = external || "http://127.0.0.1:8797/";
const dl = join(tmpdir(), "ls-threads-dl");
const b = await launch({ downloadDir: dl });
await b.goto(url);
// 12 real posts that have comments, fetched by id through the normal ID-run path
const ids = await b.page(`const batch = await Archive.get("posts/search", { subreddit: "MyBoyfriendIsAI", limit: 100, sort: "desc", before: Math.floor(Date.now() / 1000) - 40 * 86400 });
  return batch.filter(p => p.num_comments >= 5 && p.num_comments <= 60).slice(0, 12).map(p => p.id);`);
check("found real threads to fetch", ids.length >= 8, String(ids.length));
await b.page(`window.showSaveFilePicker = undefined; startIdRun(arg, { includeComments: true });`, ids);
await b.waitFor(`return /^Done/.test(document.getElementById("statusText").textContent)`, { timeout: 300000 });
await sleep(2500);
await b.page(`document.getElementById("gzipToggle").checked = false; document.querySelector(".other-formats").open = true; document.getElementById("downloadEdges").click();`); await sleep(2500);
await b.page(`document.getElementById("downloadThreads").click();`); await sleep(2500);
const files = b.files();
const fe = files.find((f) => f.endsWith("_reply_edges.csv")), ft = files.find((f) => f.endsWith("_thread_summaries.csv")), fc = files.find((f) => f.endsWith("_combined.csv"));
check("edge list, thread summaries and the combined CSV were written", !!fe && !!ft && !!fc, files.join(" | "));
const E = parseCsv(readFileSync(join(dl, fe), "utf8")), T = parseCsv(readFileSync(join(dl, ft), "utf8")), C = parseCsv(readFileSync(join(dl, fc), "utf8"));
const col = (rows, name) => rows[0].indexOf(name);
const comments = C.slice(1).filter((r) => r[col(C, "row_type")] === "comment");
check("one edge per comment in the combined file", E.length - 1 === comments.length, `${E.length - 1} edges, ${comments.length} comments`);
check("one summary per post", T.length - 1 === ids.length, `${T.length - 1} of ${ids.length}`);
// depth and parent agree with the combined CSV
const cById = new Map(comments.map((r) => [r[col(C, "comment_id")], r]));
const agree = E.slice(1).every((e) => { const c = cById.get(e[col(E, "comment_id")]); return c && String(c[col(C, "comment_depth")]) === String(e[col(E, "depth")]) && c[col(C, "comment_parent_id")].replace(/^t[13]_/, "") === e[col(E, "parent_id")]; });
check("depth and parent of every edge agree with the combined CSV", agree);
const topLevel = E.slice(1).filter((e) => e[col(E, "parent_type")] === "post");
check("top-level edges point at their post and have depth 0", topLevel.length > 0 && topLevel.every((e) => e[col(E, "parent_id")] === e[col(E, "post_id")] && e[col(E, "depth")] === "0"));
check("reply latencies are non-negative", E.slice(1).every((e) => e[col(E, "seconds_since_parent")] === "" || Number(e[col(E, "seconds_since_parent")]) >= 0));
const sumRetrieved = T.slice(1).reduce((n, r) => n + Number(r[col(T, "comments_retrieved")]), 0);
const sumTop = T.slice(1).reduce((n, r) => n + Number(r[col(T, "top_level_comments")]), 0);
check("summaries add up to the edge list", sumRetrieved === E.length - 1 && sumTop === topLevel.length, `${sumRetrieved} comments, ${sumTop} top-level`);
check("summaries carry depth, OP participation and timing", T.slice(1).every((r) => r[col(T, "max_depth")] !== "" && ["true", "false"].includes(r[col(T, "op_participated")]) && r[col(T, "first_reply_seconds")] !== ""));

// pseudonymised edge list: author and parent_author are hashes, and still line up
await b.page(`document.getElementById("pseudoToggle").checked = true; document.getElementById("downloadEdges").click();`); await sleep(2500);
// same run, same name: headless Chrome overwrites the earlier file, so read it again
const P = parseCsv(readFileSync(join(dl, fe), "utf8"));
const hashed = P.slice(1).every((e) => [e[col(P, "author")], e[col(P, "parent_author")]].every((a) => /^[0-9a-f]{64}$/.test(a) || ["[deleted]", "AutoModerator", ""].includes(a)));
const hadNames = E.slice(1).some((e) => !/^[0-9a-f]{64}$/.test(e[col(E, "author")]) && !["[deleted]", "AutoModerator", ""].includes(e[col(E, "author")]));
check("pseudonymised edge list: same rows, no user names (the first export had them)", hashed && hadNames && P.length === E.length);
// a reply's parent_author must be the pseudonym of the parent comment's author
const pAuthor = new Map(P.slice(1).map((e) => [e[col(P, "comment_id")], e[col(P, "author")]]));
check("pseudonyms still line up along the reply chain", P.slice(1).filter((e) => e[col(P, "parent_type")] === "comment" && e[col(P, "parent_in_data")] === "true").every((e) => pAuthor.get(e[col(P, "parent_id")]) === e[col(P, "parent_author")]));
if (server) server.close();
finish(b);
