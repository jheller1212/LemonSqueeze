"""Recall check for keyword studies.

Keyword search is literal matching, so the corpus misses whatever the keyword
list misses. This draws a uniform random sample of posts from the window
*without* keywords, records whether the study's collection retrieved each one,
and leaves a `relevant` column for hand-coding. Scoring the coded file gives
recall with a confidence interval for the methods section.
"""
import csv
import math
import os
import random
import re

from .schema import iso

SAMPLE_FILE = "recall_sample.csv"
SAMPLE_COLUMNS = ["post_id", "subreddit", "created_datetime", "permalink", "title", "selftext",
                  "keyword_hit", "keyword_hit_local", "keywords_matched_local", "relevant", "coder_note"]


def compile_terms(queries):
    """Approximate the archive's matching locally: a quoted query is a phrase,
    an unquoted one requires every word; OR is split; all case-insensitive."""
    terms = []
    for q in queries:
        for alt in re.split(r"\s+OR\s+", q, flags=re.IGNORECASE):
            alt = alt.strip()
            if not alt:
                continue
            if len(alt) >= 2 and alt[0] == '"' and alt[-1] == '"':
                terms.append((alt, [re.compile(r"\b" + re.escape(alt[1:-1]) + r"\b", re.IGNORECASE)]))
            else:
                terms.append((alt, [re.compile(r"\b" + re.escape(w) + r"\b", re.IGNORECASE) for w in alt.split()]))
    return terms


def matched_terms(terms, text):
    return [label for label, patterns in terms if all(p.search(text) for p in patterns)]


UNIFORM_WALK_MAX = 100000


class WindowTooLarge(ValueError):
    pass


def draw_sample(source, subreddit, date_from, date_to, n, queries, seed=None, seen=None,
                collected_ids=frozenset(), max_walk=UNIFORM_WALK_MAX):
    """A uniform random sample of n posts from the window, drawn without keywords.

    The window's posts are walked once (100 per request) and sampled exactly.
    Windows above `max_walk` posts are refused rather than approximated —
    narrow the dates or sample per sub-window. `keyword_hit` is exact: whether
    the study's collection retrieved the post. `keyword_hit_local` is a regex
    approximation kept for reference."""
    rng = random.Random(seed)
    seen = seen if seen is not None else set()
    terms = compile_terms(queries)

    walked = []
    for post in source.list_posts(subreddit, date_from, date_to):
        walked.append(post)
        if len(walked) > max_walk:
            raise WindowTooLarge("r/%s has more than %d posts in this window; narrow date_from/date_to "
                                 "(or sample one month at a time) for an exact recall sample" % (subreddit, max_walk))
    pool = [p for p in walked if p["id"] not in seen]
    picks = rng.sample(pool, min(n, len(pool)))

    rows = []
    for post in picks:
        seen.add(post["id"])
        text = "%s\n%s" % (post["title"], post["selftext"])
        local = matched_terms(terms, text)
        rows.append({
            "post_id": post["id"],
            "subreddit": post["subreddit"],
            "created_datetime": iso(post["created_utc"]),
            "permalink": post["permalink"],
            "title": post["title"],
            "selftext": post["selftext"][:2000],
            "keyword_hit": post["id"] in collected_ids,
            "keyword_hit_local": bool(local),
            "keywords_matched_local": ";".join(local),
            "relevant": "",
            "coder_note": "",
        })
    return rows, len(walked)


def write_sample(rows, out_dir):
    path = os.path.join(out_dir, SAMPLE_FILE)
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=SAMPLE_COLUMNS)
        w.writeheader()
        w.writerows(rows)
    return path


def wilson(k, n, z=1.96):
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


def score_sample(out_dir):
    """Read the hand-coded sample back. `relevant` accepts 1/0, yes/no, y/n, true/false."""
    path = os.path.join(out_dir, SAMPLE_FILE)
    with open(path, "r", encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
    coded = []
    for r in rows:
        v = (r.get("relevant") or "").strip().lower()
        if v in ("1", "y", "yes", "true", "relevant"):
            coded.append((r, True))
        elif v in ("0", "n", "no", "false", "irrelevant"):
            coded.append((r, False))
    relevant = [r for r, rel in coded if rel]
    caught = [r for r in relevant if (r.get("keyword_hit") or "").lower() == "true"]
    hits_all = [r for r, _ in coded if (r.get("keyword_hit") or "").lower() == "true"]
    hits_relevant = [r for r in hits_all if r in relevant]
    result = {
        "sampled": len(rows),
        "coded": len(coded),
        "relevant": len(relevant),
        "relevant_caught_by_keywords": len(caught),
        "recall": (len(caught) / len(relevant)) if relevant else None,
        "recall_ci95": wilson(len(caught), len(relevant)) if relevant else None,
        "keyword_hits_in_sample": len(hits_all),
        "precision_in_sample": (len(hits_relevant) / len(hits_all)) if hits_all else None,
        "precision_ci95": wilson(len(hits_relevant), len(hits_all)) if hits_all else None,
        "base_rate": (len(relevant) / len(coded)) if coded else None,
    }
    return result


def format_score(r):
    if r["coded"] == 0:
        return "recall: no rows coded yet — fill the `relevant` column (1/0) in recall_sample.csv"
    lines = ["recall check: %d sampled, %d coded, %d relevant (base rate %.1f%%)" % (
        r["sampled"], r["coded"], r["relevant"], 100 * (r["base_rate"] or 0))]
    if r["recall"] is not None:
        lo, hi = r["recall_ci95"]
        lines.append("  recall of the keyword list:    %.1f%%  (95%% CI %.0f-%.0f%%; %d of %d relevant posts were retrieved by the collection)" % (
            100 * r["recall"], 100 * lo, 100 * hi, r["relevant_caught_by_keywords"], r["relevant"]))
    if r["precision_in_sample"] is not None:
        lo, hi = r["precision_ci95"]
        lines.append("  precision among keyword hits:  %.1f%%  (95%% CI %.0f-%.0f%%; %d hits in the sample)" % (
            100 * r["precision_in_sample"], 100 * lo, 100 * hi, r["keyword_hits_in_sample"]))
    return "\n".join(lines)
