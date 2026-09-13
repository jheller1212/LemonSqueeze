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

The app deploys to Netlify, but the site is **not** linked to GitHub — merging to main does not deploy. Ship with:

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
- **A community:** Analyze shows the archive's exact totals (posts and comments, with the date they were last counted). Pick a time range and the page counts what is inside it — exact for small ranges, a sampled estimate (typically within ±15%) for large ones — then click **Collect all N posts**. That sets the limit and switches to *New*, which walks every post in the range exactly once.
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
| `posts_comments.csv` | the web app's 44-column combined schema, unchanged, plus `study`, `query`, `source`, `sort`, `collected_at`, `flags` |
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

`post_comments_complete` is `true` when the tree was walked to its end **and** at least 95% of Reddit's `num_comments` was collected. Reddit's counter undercounts the archive (see above), so an upper bound is deliberately not applied. Every step rewrites the CSV from the SQLite store, so `--apply-flags` and `--filter` can be rerun at will; `--filter` marks posts excluded rather than deleting them.

## Built by

[Jonas Heller](https://jonasheller.info) — Assistant Professor of Marketing, Maastricht University.
