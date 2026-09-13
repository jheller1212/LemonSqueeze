"""A methods paragraph with the study's actual numbers, ready to edit."""
import json
import os
import time

from .schema import iso

ARCTIC_CITATION = ("Arctic Shift (https://arctic-shift.photon-reddit.com), a public archive of Reddit "
                   "submissions and comments maintained by the photon-reddit project")


def retrieval_window(out_dir):
    path = os.path.join(out_dir, "run_log.jsonl")
    if not os.path.exists(path):
        return None, None, 0
    first = last = None
    n = 0
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            try:
                ts = json.loads(line).get("timestamp")
            except ValueError:
                continue
            n += 1
            if ts:
                first = ts if first is None or ts < first else first
                last = ts if last is None or ts > last else last
    return first, last, n


def methods_paragraph(study, report, out_dir, recall=None):
    first, last, n_requests = retrieval_window(out_dir)
    subs = ", ".join("r/" + s for s in study["subreddits"])
    window = "from %s to %s" % (
        (iso(study.get("date_from_ts"))[:10] if study.get("date_from_ts") else "the earliest archived post"),
        (iso(study.get("date_to_ts"))[:10] if study.get("date_to_ts") else "the retrieval date"))
    sources = []
    if "arctic_shift" in study["sources"]:
        sources.append(ARCTIC_CITATION)
    if "reddit_search" in study["sources"]:
        sources.append("Reddit's search API (OAuth)")
    queries = study["queries"]
    parts = []
    parts.append("Data were collected with LemonSqueeze (study configuration `%s`, SHA-256 %s) from %s, "
                 "covering posts created %s." % (
                     study["name"], _config_digest(out_dir), " and ".join(sources) or "the configured sources", window))
    if queries:
        parts.append("Posts were retrieved with %d full-text quer%s (%s) against %s; a post matched by several "
                     "queries was retained once, and the query or queries that retrieved it are recorded per post." % (
                         len(queries), "y" if len(queries) == 1 else "ies",
                         "; ".join(q if q.startswith('"') else "“%s”" % q for q in queries), subs))
    else:
        parts.append("Every post in %s within the window was retrieved." % subs)
    if first:
        parts.append("Retrieval ran between %s and %s in %d archive requests, each logged." % (first[:10], last[:10], n_requests))
    parts.append("The corpus comprises %d posts%s and %d comments." % (
        report["posts_included"],
        " (%d further posts were excluded: %s)" % (
            report["posts_total"] - report["posts_included"],
            ", ".join("%s %d" % kv for kv in sorted(report["excluded_by_reason"].items()))) if report["posts_total"] > report["posts_included"] else "",
        report["comments_total"]))
    if report["posts_with_comments_attempted"]:
        parts.append("Comment trees were retrieved in full for %d of %d posts (%.1f%%); a tree counts as complete when "
                     "the archive was walked to its end and at least 95%% of Reddit's reported comment count was obtained "
                     "(Reddit's counter omits removed comments and lags behind late replies)." % (
                         report["posts_comments_complete"], report["posts_with_comments_attempted"],
                         100 * (report["share_comments_complete"] or 0)))
    if report.get("posts_removed"):
        parts.append("%d posts (%.1f%%) had their body removed or deleted at archive time; their metadata and comment "
                     "structure are retained." % (report["posts_removed"], 100 * report["posts_removed"] / max(1, report["posts_total"])))
    parts.append("Post and comment scores are those captured by the archive at its second retrieval, about 36 hours "
                 "after creation, and are not updated thereafter; the capture time is recorded per row.")
    if study.get("anonymise_authors", True):
        parts.append("Author names were replaced by salted SHA-256 pseudonyms; the salt was not retained with the dataset.")
    if recall and recall.get("recall") is not None:
        lo, hi = recall["recall_ci95"]
        parts.append("A recall check on a time-stratified random sample of %d posts drawn without keywords found that "
                     "the keyword list captured %.0f%% of relevant posts (95%% CI %.0f–%.0f%%)." % (
                         recall["coded"], 100 * recall["recall"], 100 * lo, 100 * hi))
    return " ".join(parts)


def _config_digest(out_dir):
    path = os.path.join(out_dir, "study.sha256")
    if not os.path.exists(path):
        return "n/a"
    with open(path, "r", encoding="utf-8") as f:
        return f.read().split()[0][:12] + "…"
