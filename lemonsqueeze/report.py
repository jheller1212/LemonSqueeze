"""Corpus summary for the methods section: what was found, by whom, how complete."""
from collections import Counter, defaultdict


def build_report(store, study):
    posts = store.posts(include_excluded=True)
    included = [p for p in posts if not p["excluded"]]
    per_sub_query = defaultdict(Counter)
    per_source = Counter()
    for p in included:
        attrs = store.attributions(p["id"])
        for a in attrs:
            per_sub_query[p["subreddit"]][a["query"] or "(stream)"] += 1
        for s in {a["source"] for a in attrs}:
            per_source[s] += 1
    attempted = [p for p in included if p["comments_complete"] is not None]
    complete = sum(1 for p in attempted if p["comments_complete"])
    flag_counts = Counter()
    for p in included:
        for name in (p["flags"] or "").split(";"):
            if name:
                flag_counts[name] += 1
    comment_flag_counts = Counter()
    comment_total = 0
    for row in store.db.execute("SELECT flags FROM comments"):
        comment_total += 1
        for name in (row["flags"] or "").split(";"):
            if name:
                comment_flag_counts[name] += 1
    excluded = Counter((p["exclude_reason"] or "").split(":")[0] for p in posts if p["excluded"])
    return {
        "posts_total": len(posts),
        "posts_included": len(included),
        "excluded_by_reason": dict(excluded),
        "unique_posts_per_subreddit_per_query": {k: dict(v) for k, v in per_sub_query.items()},
        "posts_per_source": dict(per_source),
        "comments_total": comment_total,
        "comments_pending": store.pending_count(),
        "posts_with_comments_attempted": len(attempted),
        "posts_comments_complete": complete,
        "share_comments_complete": (complete / len(attempted)) if attempted else None,
        "flag_counts_posts": dict(flag_counts),
        "flag_counts_comments": dict(comment_flag_counts),
    }


def format_report(r):
    lines = ["=== %d posts (%d included, %d excluded) ===" % (r["posts_total"], r["posts_included"], r["posts_total"] - r["posts_included"])]
    if r["excluded_by_reason"]:
        lines.append("excluded: " + ", ".join("%s=%d" % kv for kv in sorted(r["excluded_by_reason"].items())))
    lines.append("unique posts per subreddit per query:")
    for sub, qs in sorted(r["unique_posts_per_subreddit_per_query"].items()):
        for q, n in sorted(qs.items()):
            lines.append("  r/%-24s %-30s %d" % (sub, q, n))
    lines.append("posts per source: " + (", ".join("%s=%d" % kv for kv in sorted(r["posts_per_source"].items())) or "-"))
    share = r["share_comments_complete"]
    lines.append("comments: %d rows; %d posts still pending; complete trees %d/%d%s" % (
        r["comments_total"], r["comments_pending"], r["posts_comments_complete"], r["posts_with_comments_attempted"],
        "" if share is None else " (%.0f%%)" % (100 * share)))
    lines.append("flags on posts: " + (", ".join("%s=%d" % kv for kv in sorted(r["flag_counts_posts"].items())) or "-"))
    lines.append("flags on comments: " + (", ".join("%s=%d" % kv for kv in sorted(r["flag_counts_comments"].items())) or "-"))
    return "\n".join(lines)
