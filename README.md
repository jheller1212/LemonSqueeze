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

## Built by

[Jonas Heller](https://jonasheller.info) — Assistant Professor of Marketing, Maastricht University.
