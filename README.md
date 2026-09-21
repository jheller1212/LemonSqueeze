# LemonSqueeze

A web app for scraping Reddit posts and comments, built to make collecting data for research easier — no API keys, no authentication headaches.

## What it does

- Scrapes posts and complete comment trees (all replies, with depth) from any archived subreddit — including banned and quarantined ones
- Supports multiple sort modes (new, top, hot) in a single run
- Deduplicates posts across sort modes so you don't get repeats
- Optional keyword analysis — define your own categories and score posts by relevance
- Exports to CSV (opens right in Excel/Google Sheets) and JSON (for Python/R scripts)
- Everything runs in the browser, nothing gets stored on a server

## How it works

The frontend is a static site hosted on Netlify. When you hit "Squeeze," it sends requests to a serverless function that pulls data from [Arctic Shift](https://arctic-shift.photon-reddit.com) (a public Reddit archive). Posts come back to the browser where they get processed, analyzed (if you turned on keywords), and packaged into downloadable files.

No Reddit API credentials needed. No account setup. Just enter a subreddit and go.

## Running locally

You need Node.js and the Netlify CLI:

```bash
npm install -g netlify-cli
netlify dev
```

This starts a local dev server at `http://localhost:8888` with the serverless functions wired up.

## Deploying

The site is linked to GitHub: every merge to `main` builds and publishes on Netlify within a minute or two, and every pull request gets a deploy preview. A manual deploy is only needed to publish something that is not on `main`:

```bash
netlify deploy --prod --dir web --functions netlify/functions
```

The config lives in `netlify.toml` — it publishes the `web/` folder and bundles the functions from `netlify/functions/`.

## Project structure

```
web/
  index.html    — the UI
  app.js        — scraping logic, keyword analysis, CSV/JSON export
  style.css     — styling
  favicon.svg   — lemon icon

netlify/
  functions/
    scrape.mjs  — serverless function that talks to Arctic Shift
```

## Keyword analysis (optional)

If you turn on keyword analysis in the UI, you can define categories with lists of keywords. Each post and comment gets scored by how many keywords it matches. The scores and matched categories show up as extra columns in the CSV export.

You can customize the categories to whatever you're researching — the defaults are just examples.

## How much is there, and how do I take all of it?

- **A thread:** paste its URL and click Analyze — the whole comment tree is collected, nothing to configure. The card shows the archive count (authoritative) next to Reddit's own counter (undercounts).
- **Don't know the communities or keywords yet?** Open *Describe your study* at the top of the web app and write what you are studying in plain text. A language model proposes communities (core, adjacent, contrast) and keyword queries; the archive then verifies every community — only ones that exist are selectable, with members, archived posts and comments, and the year they start. Click *Analyze* on a community to load it with the keywords, or download a study file that runs all selected communities in the CLI. Treat the suggestions as a starting point: the counts and the recall check are what justify the corpus. This feature needs an `ANTHROPIC_API_KEY` environment variable on the Netlify site; without one the rest of the app works unchanged.
- **Keywords in the web app:** after Analyze, the *Keywords* box takes one search per line — plain words, `"quoted phrases"`, `a OR b` for alternatives. Each line is its own newest-first pass over the archive; a post found by several lines is kept once and the `query` column lists them `;`-separated. The count line sizes each keyword before you run.
- **A community:** Analyze shows the archive's exact totals (posts and comments, with the date they were last counted). Pick a time range and the page counts what is inside it — exact for small ranges, a sampled estimate (typically within ±15%) for large ones — then click **Collect all N posts**. That sets the limit and switches to *New*, which walks every post in the range exactly once.
- **Speed.** The browser talks to the archive directly (it allows cross-origin requests), so there is no serverless time limit. Whole-community and time-frame scopes fetch comments as a *sweep* — every comment in the subreddit over the window is fetched exactly once, 100 per request in parallel shards, and credited to whichever collected post it belongs to; a post is finalised when the sweep is 30 days past its creation (or at the end, after a final sweep of the 30-day margin past the window), and only posts below 95% of Reddit's count are then walked individually. Measured on r/MyBoyfriendIsAI: the sweep and per-post fetching returned identical comment sets on the 40 largest threads; the sweep needs ~8× fewer requests. Keyword and newest-N scopes use per-post walks with 8 in parallel. Posts whose threads were already collected completely in an earlier finished run of the same community (and are older than the settle margin) are reused rather than re-fetched. If the archive stops answering the browser, the run falls back to the server path automatically.
- **Long runs are chunked and saved as they go.** A scope above ~1,000 posts is split into time chunks; a chunk that fails is retried three times and, if it still fails, skipped and listed — the run finishes as *complete with gaps* and *Retry failed chunks* fills them in. Every batch is written to the browser's IndexedDB, so a crash, reload or closed tab loses nothing: *Your runs* at the top lists every run with its status (complete / complete with gaps / stopped / failed), and lets you resume or download again. On completion the combined CSV downloads automatically; download the *Run report (JSON)* too — it records the exact time window, chunks, counts and any posts with incomplete comments. Runs live in the browser that made them.
- **The combined CSV is big by design** — one row per comment with the post's full text repeated on each, so a busy community's year runs to a gigabyte or more. The results view shows the approximate size of each export before you click. Two ways to keep it manageable: tick **Compress downloads (.gz)** (on by default for large runs; 5–10× smaller; `read.csv("file.csv.gz")` in R and `pd.read_csv("file.csv.gz")` in pandas read it directly, Excel does not), or download **Posts CSV + Comments CSV** and join them on `post_id` — the same 44 columns without the repetition.
- **Test your search terms offline.** "Design a study from a population you already hold" takes runs saved in the browser or CSV / CSV.gz files from disk (read locally, never uploaded) and applies named regex filters to title + body: `NAME = regex`, indented lines continue a long alternation, `OR NAME` includes an earlier filter. You get hit counts and shares per month, the share of intact bodies, and 20 random hits at a time with the match highlighted, to catch false positives ("chai", "gemini") before committing to a term list. Word boundaries are Unicode-aware, as in Python and R (JavaScript's own `\b` would match "ai" inside "açai"). Filters run in a worker with a time limit, so a runaway pattern is stopped instead of freezing the tab. 1.5 million posts take about half a minute.
- **Draw a sample with a recorded seed.** After loading a population (filters optional), step 4 samples from the whole population, the hits of a filter, or its non-hits: a number of posts or a percentage, stratified by month, comment-count quartile and/or score quartile (quartiles are computed within the month when month is a stratifier), proportional allocation, simple random sampling without replacement inside each stratum. The seed makes it reproducible and is written to the manifest CSV (post_id, stratum, seed, one flag column per filter, body state) and into the run report when you fetch the sampled posts.
- **Methods and ethics pack.** One click (per run under "Other formats", or "Methods pack" on a batch card) writes a Markdown document from the run report(s): a paste-ready methods paragraph with the real numbers and wording for what was actually done (source, window, keywords, the study design with its regexes, k, strata and seed, completeness rule and rate, missing time spans, intact-body share, score snapshot, pseudonymisation), the limitations to state, a run table, a short data dictionary, how to cite the tool and the archive, and a data-management and ethics checklist (ethics review, legal basis, pseudonymisation, names inside text, quotations, vulnerable groups, storage, sharing ids rather than text, deletion requests, platform terms, AoIR guidelines). It is a starting point, not legal advice.
- **Conversation structure, ready to analyse.** Under "Other formats": the **reply edge list** (one row per comment: `parent_id`, `parent_type` post/comment, `parent_in_data`, `depth`, `author`, `parent_author`, `is_submitter`, `seconds_since_post`, `seconds_since_parent`, score, word count — load it straight into igraph or networkx) and **thread summaries** (one row per post: top-level comments vs replies, maximum and mean depth, unique commenters, whether and how often the original poster took part, deleted-author and orphan comments, largest sub-thread, first and median reply time, thread duration). Both stream like every other export, so they honour gzip, pseudonymisation, merged batch downloads and study-design columns.
- **Author-level data, pseudonymised.** The results view reports how concentrated activity is (accounts, share written by the 10 most active and by the top 1 %). "Pseudonymise authors in every download" replaces `post_author` / `comment_author` by SHA-256(salt + name), the same function as the command-line tool, so with the same salt both produce the same pseudonym and files can be linked without storing a user name; the salt lives in this browser (copy or import it, treat it like a password). "Download authors table" gives one row per account. The **author panel** collects every post that accounts with at least k posts in a run made in that community (optionally with comment trees), for longitudinal and account-level designs; it asks for confirmation, keeps user names out of the run report, and pseudonymises its exports by default.
- **What is left of the content is shown, not assumed.** Under the run status: the share of post bodies that are intact, removed by moderators or Reddit, deleted by the author, or empty; the same for comments; and a month-by-month table. In r/relationship_advice only about a quarter of post bodies survive, so a text analysis describes the surviving posts, not the community — the run report records these shares (`content_availability`). "Add analysis columns" appends `post_body_state` and `comment_body_state` to any export without touching the 45 schema columns.
- **Match a control group.** Step 5 of the Design panel takes the posts matching one filter as targets and draws k controls per target (default 2) from the same month and/or comment-count or score quartile, without replacement, among posts that do not match an exclusion filter (default: your broadest filter, so no control is a near-miss). Seeded and reproducible; a stratum that runs out is reported as a shortfall, never filled from elsewhere. "Fetch targets + controls" collects both groups with full comment trees, and every export of that run carries `sample_group`, `match_post_id` and one `flag_<filter>` column per filter as trailing columns; the run report records the whole design.
- **Fetch by post ID.** "Have a list of post IDs?" under the search bar takes bare IDs, `t3_` IDs or reddit links (paste, or upload a .txt/.csv — the `post_id`/`id` column is used) and collects exactly those posts with complete comment trees, in batches of 1,000, resumable like any run; the run report lists IDs the archive does not hold. This is the second half of the two-step workflow for very large scopes: collect the whole community without comments (split per month for a big community), filter locally, then fetch comments for the matched IDs only.
- **Your runs stays out of the way.** However many runs exist, the panel is one status line under the header (runs, what is running now, queued, paused or failed) until you open it; open, the list scrolls in its own box, each batch is a single card with progress, totals and batch actions (Download all, Merged only, Continue batch, Delete batch), and "37 runs" unfolds the individual runs. Sort by newest, community or status; filter by community or keyword. The search field never moves.
- **A batch downloads with one click.** Runs that belong together — a batch, or several runs of the same community — are grouped in *Your runs* with **Download all (N files + merged)**: one merged CSV first (every row carries `run_label`, e.g. "2024 Q3 · kw: jealous | cheating", and `run_id`; `query` still says which keyword found the post), then each run's own file. *Merged only* skips the individual files. The browser asks once whether the site may download several files.
- **Files are named after the run**: `reddit_<subreddit>_<scope>[_kw-<keywords>]_<start time>_<kind>`, e.g. `reddit_relationship_advice_2023-09-18_to_2026-09-18_kw-jealous+cheating_20260918-1432_combined.csv.gz` or `reddit_relationship_advice_2024_Q3_20260918-1432_posts.csv`. The start time makes a re-run of the same scope a new file instead of a name clash; the run report, run log and every export of one run share the same base name.
- **Every run keeps a log.** Under the run status, "Run log" lists each step with timings: when every chunk started and finished and how many posts it found, every back-off the archive forced (with the reason), counts, exports, and every error with its stack. The summary line says at a glance where the time went (e.g. "archive back-offs: 143 (38 min waiting)"). *Download log (JSON)* keeps it with the data; *Send log to the maintainer* posts it (no post content) so a slow or failed run can be diagnosed — quote the reference it returns. The run report also carries a log summary.
- **Several years in one go.** Pick "Past 2/3/5 years" or a custom range and set **Run this scope as** to one run per year, half-year or quarter. The runs are queued and execute back-to-back in the tab, newest first: each finishes, downloads its file (named by segment, e.g. 2024 H1) and the next starts by itself. A Stop pauses the batch; the queued runs wait in Your runs with a Start now button, and a resumed run continues the chain when it finishes. Each run must still fit the 100,000-post cap; the estimate line says when a finer split is needed.
- **Squeeze never waits for a slow count.** The post count above the button only sizes the estimate. Keyword counts on a big community take a full-text query per keyword and can run for minutes; the run starts at once and chunks the time frame by month, and the remaining-time display switches to the measured pace after the first chunk. Several keywords go in one run: one line each, one pass per keyword, a post matching several is kept once and its `query` column lists the keywords that found it.
- **Big downloads work.** In Chrome and Edge a download you click is streamed straight to disk through a "Save as" dialog — no in-memory file, however large; elsewhere (and for the automatic download when a run finishes) the file is assembled in parts. Either way the page never holds the whole run in memory; a "Preparing download… N posts" note shows progress. Files are large: the combined CSV for a year of a busy community can be 500 MB+.
- **The browser tab does the work.** Closing the tab pauses the run — nothing is lost, every batch is already saved and *Your runs* resumes it — and a tab in the background keeps going, only slower. A run that must finish unattended (overnight, on a laptop that sleeps) belongs in the command-line tool below, which runs on your own computer and writes to disk as it goes.
- **Ceiling per run is 100,000 posts.** A browser tab holds that comfortably without comments; with comments, expect a few gigabytes and many hours for big communities. For anything larger, split by date range — one run per month or year — and concatenate the files in R or pandas. Runs above 20,000 posts stop saving Resume snapshots, so keep the tab open.
- Comment counts for posts younger than ~36 hours are under-reported (see scores below), so an estimate for "today" will look low on comments.

## Data completeness (read this before you cite the data)

- **Comments are collected exhaustively.** A thread is paged through the archive until it is finished, however large; a 5,800-comment thread takes about 30 seconds. Every exported post carries `comments_complete` (`post_comments_complete` in the combined CSV). It is only `false` if you pressed Stop or an error interrupted a thread — treat those rows as partial.
- **`comment_count_actual` will differ from `num_comments`.** `num_comments` is Reddit's own counter at archive time and routinely undercounts (it excludes some removed comments and lags behind late replies). The archive count is the authoritative one.
- **`depth` is derived from `parent_id`**: 0 for a top-level comment, 1 for a reply to it, and so on. `null` means the parent comment was not in the archive, so the depth is unknown rather than 0. `parent_id` lets you rebuild the full tree in R or Python.
- **Removed and deleted content** is kept as `[removed]` / `[deleted]` bodies with the author `[deleted]` — do not drop these rows silently, they are part of the conversation structure.
- **Sort modes are archive-based, not Reddit's front page.** *Newest* is exact. *Top* and *Most discussed* rank by score / comment count **within each fetched time window**, not across all of Reddit history — the archive cannot sort by score. *Recent & popular* is the last 7 days, *Latest* the last 24 hours.
- **Scores are a snapshot, and the snapshot is dated.** The archive ingests a post or comment within minutes (when its score is still ~1) and re-fetches it once about 36 hours later; that second fetch is the score you get, and it is never updated again. Every row carries `score_as_of` (ISO timestamp of that fetch). Items younger than ~36 hours have not had their second fetch yet, so their scores are near zero — filter on `score_as_of` if score matters to your analysis.

## Limits

- Arctic Shift returns at most 100 items per request, so large scrapes take a while: each post's comments need at least one request
- Netlify functions time out after 26 seconds; long threads are continued automatically across requests

## Command line: studies, search mode, stream mode

The web app is for one community at a time. The command line runs a *study*: any set of subreddits and keyword queries over any time window, written to its own folder with a request log so the corpus can be described exactly. Nothing about a topic is hard-coded — a study is a YAML file.

```bash
pip install -r requirements.txt
cp studies/example.yaml studies/my_study.yaml     # edit name, subreddits, queries
python main.py --mode search --study studies/my_study.yaml --dry-run   # prints the request plan, no requests
python main.py --mode search --study studies/my_study.yaml             # collect posts
python main.py --collect-comments --study studies/my_study.yaml        # after comment_settle_hours (default 72h)
python main.py --apply-flags --filter --report --study studies/my_study.yaml
```

Stream mode (walk one subreddit chronologically, same output):

```bash
python main.py --mode stream --subreddit replika --date-from "90 days ago" --limit 2000
python main.py --collect-comments --subreddit replika
```

Output per study, in `data/<name>/`:

| File | What |
|---|---|
| `posts_comments.csv` | the web app's 45-column combined schema, unchanged (its last column `query` names the keyword(s) that found the post), plus `study`, `source`, `sort`, `collected_at`, `flags` |
| `run_log.jsonl` | one line per request: timestamp, source, subreddit, query, sort, page, results, HTTP status |
| `report.json` | unique posts per subreddit per query, posts per source, share of complete comment trees, flag counts |
| `study.yaml` + `study.sha256` | the config that produced the data, so the run can be repeated |
| `study.sqlite`, `.salt` | local only (gitignored): the store, and the salt + author mapping for pseudonymisation |

A post found by several queries or sources appears once; `query`, `source` and `sort` list everything that found it, `;`-separated.

### Study config keys

| Key | Default | Meaning |
|---|---|---|
| `name` | required | output folder `data/<name>/` |
| `subreddits` | required | list; `all` allowed only with `reddit_search` |
| `queries` | required | one search each. Quoted phrases work on both sources; `a OR b` is split into two Arctic Shift searches |
| `exclude_terms` | `[]` | `--filter` drops posts whose title+body contain any (whole word, case-insensitive) |
| `date_from`, `date_to` | `null` | ISO date, or `30 days ago`; null = full history |
| `sources` | `[arctic_shift]` | `arctic_shift` (full archive, no credentials) and/or `reddit_search` (needs `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`; each listing ≈250 results, so every query runs per sort) |
| `sorts` | `[relevance, new, top]` | `reddit_search` only |
| `comment_mode` | `settled` | `settled`: comments fetched by `--collect-comments` once a post is older than `comment_settle_hours`; `immediate`: at discovery; `none` |
| `comment_settle_hours` | `72` | |
| `comment_source` | `arctic_shift` | `arctic_shift` returns the flat complete tree; `reddit_search` fetches the live tree and expands every collapsed `more` node |
| `min_score`, `min_comments` | `null` | applied by `--filter` |
| `flags` | `[]` | `name`, regex `pattern`, optional `near` regex that must occur within `window` characters, `scope: posts|comments|both`; `--apply-flags` writes matching names to `flags` |
| `anonymise_authors` | `true` | authors exported as SHA-256(salt + name); salt and mapping stay in `data/<name>/` |

### For the paper

```bash
python main.py --study studies/my_study.yaml --recall-sample 100   # 100 random posts per subreddit, drawn WITHOUT keywords
#   code the `relevant` column (1/0) by hand, then:
python main.py --study studies/my_study.yaml --recall-score        # recall + precision of the keyword list, 95% CI
python main.py --study studies/my_study.yaml --methods             # a methods paragraph with the study's real numbers
```

Every column is defined in [DATA_DICTIONARY.md](DATA_DICTIONARY.md), with its caveats. Keyword search is literal matching (no stemming, no relevance ranking), so report the recall check: it is the only evidence that the keyword list captured the phenomenon. The sample is uniform over the window's posts — the window is walked once, so it is exact; windows above 100,000 posts are refused (sample month by month instead) rather than approximated — and a "hit" means the study's collection actually retrieved the post, not a re-implementation of the archive's matching.

### Web tests

- `node --test "tests/web/unit/*.test.mjs"` — pure logic in `web/lib/` (filters, strata, seeded sampling, matched controls, CSV streaming). Runs in CI.
- `node tests/web/ui/<check>.mjs` — headless-Chrome UI checks (`tests/web/harness.mjs`) against a local dev server (`tests/web/devserver.mjs`, serves `web/` under the production CSP and proxies `/api` to the live functions). They need Chrome and the network, so they run locally, before every PR. Pass a URL to run one against a deployed site.
- `node tests/web/local/study_crosscheck.mjs` — reproduces a finished study (4,937 regex targets, 9,874 matched controls) from population files on disk; a regression check for the filter engine.

### Tests

```bash
pip install pytest && python -m pytest -q
```

CI runs the suite on Python 3.9 and 3.12 and syntax-checks the web app on every push. The suite covers the archive cursor logic (boundary seconds, one-second pages), the completeness rule, depth reconstruction, filters, flags, pseudonymisation, recall scoring, and the web/CLI column parity.

`post_comments_complete` is `true` when the tree was walked to its end **and** at least 95% of Reddit's `num_comments` was collected. Reddit's counter undercounts the archive (see above), so an upper bound is deliberately not applied. Every step rewrites the CSV from the SQLite store, so `--apply-flags` and `--filter` can be rerun at will; `--filter` marks posts excluded rather than deleting them.

## Built by

[Jonas Heller](https://jonasheller.info) — Assistant Professor of Marketing, Maastricht University.
