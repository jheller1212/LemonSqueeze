"""Post-collection filters. Posts are marked excluded with a reason, never deleted."""
import re

REMOVED_BODIES = ("[removed]", "[deleted]")


def exclusion_reason(post, study, comment_count=None):
    """Return why this post is excluded under the study's filters, or None."""
    text = "%s %s" % (post.get("title", ""), post.get("selftext", ""))
    for term in study.get("exclude_terms") or []:
        if re.search(r"\b" + re.escape(str(term)) + r"\b", text, re.IGNORECASE):
            return "exclude_term:" + str(term)
    if (post.get("selftext") or "").strip() in REMOVED_BODIES:
        return "body_" + post["selftext"].strip("[]")
    min_score = study.get("min_score")
    if min_score is not None and int(post.get("score") or 0) < int(min_score):
        return "min_score"
    min_comments = study.get("min_comments")
    if min_comments is not None:
        n = comment_count if comment_count is not None else int(post.get("num_comments") or 0)
        if n < int(min_comments):
            return "min_comments"
    return None
