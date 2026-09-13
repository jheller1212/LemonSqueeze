# Data dictionary — `posts_comments.csv`

One row per comment, joined to its post; a post without collected comments is one `post_only` row. The first 45 columns are identical between the web app's *Combined CSV* download and the command-line tool; the command-line tool appends five study columns.

Times are UTC. Booleans are `True`/`False`. Empty means *not available from the source*, never zero.

## Post columns (repeated on every comment row of that post)

| Column | Type | Meaning | Caveat |
|---|---|---|---|
| `post_id` | string | Reddit base-36 id (`1wcqv3p`) | Join key |
| `subreddit` | string | Community name without `r/` | |
| `post_title` | text | | |
| `post_selftext` | text | Body of a text post; empty for link posts | `[removed]` / `[deleted]` when moderators or the author removed it — the row is kept because the comment structure is still data |
| `post_author` | string | Username, or a salted SHA-256 pseudonym when anonymisation is on | `[deleted]` is kept literally; `AutoModerator` is never hashed |
| `post_created_utc` | integer | Epoch seconds | |
| `post_created_datetime` | ISO 8601 | Same, human-readable | |
| `post_date` | YYYY-MM-DD | | |
| `post_day_of_week` | string | Sunday…Saturday, UTC | |
| `post_hour_utc` | 0–23 | | |
| `post_score` | integer | Net upvotes | **Snapshot** taken by the archive ~36 h after creation and never updated; see `post_score_as_of`. Posts younger than ~36 h show ~1 |
| `post_score_as_of` | ISO 8601 | When the score was captured | Empty if the archive recorded no capture time |
| `post_upvote_ratio` | 0–1 | Share of upvotes | Same snapshot as the score; 0 when unavailable |
| `post_num_comments` | integer | Reddit's own comment counter at capture | **Undercounts** the archive by 4–10 % (removed comments drop out, late replies lag). Use `comment_count_actual` / the number of comment rows |
| `post_permalink` | URL | | |
| `post_flair` | string | Link flair text | |
| `post_over_18` | bool | NSFW flag | |
| `post_edited` | bool or epoch | `False`, or the edit time | |
| `post_distinguished` | string | `moderator` / `admin` / empty | |
| `post_is_crosspost` | bool | | |
| `post_crosspost_subreddit` | string | Origin community of a crosspost | |
| `post_total_awards` | integer | | Reddit retired awards in 2023; mostly 0 |
| `post_gilded` | integer | | Same |
| `post_title_word_count` | integer | Whitespace tokens | |
| `post_selftext_word_count` | integer | | |
| `post_comments_complete` | bool or empty | `True`: the tree was walked to its end and ≥ 95 % of `post_num_comments` was collected. `False`: collection was interrupted (Stop, error). Empty: comments were not requested | A one-sided rule on purpose — see `post_num_comments` |

## Comment columns (empty on `post_only` rows)

| Column | Type | Meaning | Caveat |
|---|---|---|---|
| `comment_id` | string | Base-36 id | |
| `comment_body` | text | | `[removed]` / `[deleted]` kept |
| `comment_author` | string | As `post_author` | |
| `comment_created_utc` | integer | | |
| `comment_created_datetime` | ISO 8601 | | |
| `comment_date` | YYYY-MM-DD | | |
| `comment_day_of_week` | string | | |
| `comment_hour_utc` | 0–23 | | |
| `comment_score` | integer | | Same ~36 h snapshot as posts |
| `comment_score_as_of` | ISO 8601 | | |
| `comment_parent_id` | string | `t3_<post_id>` for a top-level comment, `t1_<comment_id>` for a reply | Rebuild the tree from this |
| `comment_is_submitter` | bool | Written by the post's author | |
| `comment_depth` | integer or empty | 0 = top level, 1 = reply to a top-level comment, … Derived from `comment_parent_id`. Empty = the parent is not in the archive, so depth is unknown | Never a false 0 |
| `comment_edited` | bool or epoch | | |
| `comment_distinguished` | string | | |
| `comment_controversiality` | 0/1 | Reddit's flag for near-equal up/down votes | |
| `comment_body_word_count` | integer | | |
| `row_type` | `comment` / `post_only` | | Filter on this before counting posts |
| `query` | string | Keyword(s) that retrieved the post, `;`-separated; empty for a full-community run | A post found by several keywords appears once |

## Study columns (command-line tool only)

| Column | Meaning |
|---|---|
| `study` | Study name (= output folder) |
| `source` | `arctic_shift` and/or `reddit_search`, `;`-separated |
| `sort` | Listing sort(s) that surfaced the post (`new` for the archive; Reddit's sorts for `reddit_search`) |
| `collected_at` | When the post first entered the study (UTC) |
| `flags` | Names of the study's regex flags that matched, `;`-separated, post flags and comment flags combined on comment rows |

## Companion files (command-line tool)

- `run_log.jsonl` — one line per archive request (timestamp, source, subreddit, query, sort, page, results, HTTP status, retry attempt). Cite the retrieval dates from here.
- `report.json` — counts per subreddit and query, per source, completeness share, removed-body count, flag counts.
- `study.yaml` + `study.sha256` — the configuration that produced the data. `study.<hash>.yaml` backups appear if the config changed between runs.
- `recall_sample.csv` — created by `--recall-sample N`; code the `relevant` column and run `--recall-score`.
- `.salt`, `study.sqlite` — local only, never share: the salt and the author→pseudonym mapping.
