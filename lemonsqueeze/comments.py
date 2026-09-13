"""Comment collection against the pending table.

``settled`` mode fetches a post's tree only once the post is older than
``comment_settle_hours``; ``immediate`` fetches at discovery. Either way the
fresh tree replaces any earlier rows for that post.
"""
import time

from .schema import assign_depths

# Reddit's num_comments is a live counter that undercounts the archive (removed
# comments are dropped from it, late replies lag), so completeness is one-sided:
# the walk reached the end AND we have at least 95% of what Reddit reports.
COMPLETE_RATIO = 0.95


def is_complete(walked_to_end, fetched, num_comments):
    if not walked_to_end:
        return False
    if num_comments <= 0:
        return True
    return fetched >= COMPLETE_RATIO * num_comments


def collect_for_post(source, store, post_id, num_comments):
    comments, walked = source.fetch_comments(post_id, num_comments)
    # Sources may hand back overlapping pages; keep one row per id.
    seen = set()
    unique = []
    for c in comments:
        if c["id"] and c["id"] not in seen:
            seen.add(c["id"])
            unique.append(c)
    assign_depths(unique)
    complete = is_complete(walked, len(unique), num_comments)
    store.replace_comments(post_id, unique, complete)
    return len(unique), complete


def collect_pending(source, store, settle_hours, progress=None):
    """Fetch trees for every pending post older than settle_hours. Returns (done, complete, failed)."""
    pending = store.pending(settle_hours)
    done = complete_n = failed = 0
    for i, row in enumerate(pending, 1):
        post = store.post(row["post_id"])
        if post is None:
            store.db.execute("DELETE FROM pending_comments WHERE post_id = ?", (row["post_id"],))
            store.commit()
            continue
        try:
            n, complete = collect_for_post(source, store, row["post_id"], int(post["num_comments"] or 0))
            done += 1
            complete_n += 1 if complete else 0
            if progress:
                progress("[%d/%d] %s: %d comments (%s)" % (
                    i, len(pending), row["post_id"], n, "complete" if complete else "INCOMPLETE"))
        except Exception as exc:  # keep going; the post stays pending for the next run
            failed += 1
            store.defer_pending(row["post_id"], exc)
            if progress:
                progress("[%d/%d] %s: failed (%s)" % (i, len(pending), row["post_id"], str(exc)[:120]))
    return done, complete_n, failed


def settle_wait_hint(store, settle_hours):
    """How long until the newest pending post is old enough, for the CLI message."""
    row = store.db.execute("SELECT MAX(discovered_at) AS m FROM pending_comments").fetchone()
    if not row or row["m"] is None:
        return None
    ready_at = row["m"] + settle_hours * 3600
    return max(0, int((ready_at - time.time()) / 3600))
