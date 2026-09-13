"""Command line: collect (stream or search), then the post-collection steps."""
import argparse
import json
import os
import re
import sys
import time

from . import __version__
from .comments import collect_for_post, collect_pending, settle_wait_hint
from .filters import exclusion_reason
from .flags import compile_flags, evaluate
from .report import build_report, format_report
from .sources import make_source
from .store import Store
from .study import StudyError, load_study, persist_config, stream_study, study_dir
from .writer import write_csv


def build_parser():
    p = argparse.ArgumentParser(prog="lemonsqueeze", description="Collect Reddit posts and comments for research.")
    p.add_argument("--version", action="version", version=__version__)
    p.add_argument("--mode", choices=["stream", "search"], help="stream: walk one subreddit; search: run a study config")
    p.add_argument("--study", help="study YAML (search mode and all post-collection steps)")
    p.add_argument("--subreddit", help="stream mode: subreddit to walk")
    p.add_argument("--limit", type=int, default=None, help="stream mode: stop after this many posts")
    p.add_argument("--date-from", help="stream mode: ISO date or '30 days ago'")
    p.add_argument("--date-to", help="stream mode: ISO date")
    p.add_argument("--comment-mode", choices=["settled", "immediate", "none"], default=None, help="override the study's comment_mode")
    p.add_argument("--data-root", default="data", help="where data/<study>/ lives (default: data)")
    p.add_argument("--collect", action="store_true", help="collect posts even when post-collection steps are also given")
    p.add_argument("--dry-run", action="store_true", help="print the request plan and exit without any requests")
    p.add_argument("--count", action="store_true", help="measure the corpus: walk the posts only, write nothing, report sizes and time")
    p.add_argument("--collect-comments", action="store_true", help="fetch trees for pending posts older than comment_settle_hours")
    p.add_argument("--settle-hours", type=float, default=None, help="override comment_settle_hours for this run")
    p.add_argument("--apply-flags", action="store_true", help="evaluate the study's flags and write the flags column")
    p.add_argument("--filter", action="store_true", help="apply exclude_terms, min_score, min_comments, drop [removed]/[deleted]")
    p.add_argument("--report", action="store_true", help="print corpus statistics")
    return p


def say(msg):
    print(msg, flush=True)


def resolve_study(args):
    if args.study:
        study = load_study(args.study)
    elif args.subreddit:
        study = stream_study(re.sub(r"^(/?r/)", "", args.subreddit.strip()), args.date_from, args.date_to,
                             comment_mode=args.comment_mode or "settled")
    else:
        raise StudyError("Give --study <file.yaml> or --subreddit <name>")
    if args.comment_mode:
        study["comment_mode"] = args.comment_mode
    if args.settle_hours is not None:
        study["comment_settle_hours"] = args.settle_hours
    return study


# --- collection --------------------------------------------------------------

def request_plan(study, sources):
    plan = []
    for source in sources:
        sorts = [s for s in study["sorts"] if s in source.supports_sorts] or ["new"]
        for sub in study["subreddits"]:
            if sub.lower() == "all" and source.name != "reddit_search":
                continue
            for query in study["queries"]:
                for sort in sorts:
                    plan.append(source.plan(sub, query, study["date_from_ts"], study["date_to_ts"], sort))
    return plan


def run_search(study, store, sources):
    total_new = 0
    for source in sources:
        sorts = [s for s in study["sorts"] if s in source.supports_sorts] or ["new"]
        for sub in study["subreddits"]:
            if sub.lower() == "all" and source.name != "reddit_search":
                say("  skipping r/all for %s (needs a subreddit)" % source.name)
                continue
            for query in study["queries"]:
                for sort in sorts:
                    say("  %s r/%s %r sort=%s" % (source.name, sub, query, sort))
                    n_new = n_seen = 0
                    for post in source.search_posts(sub, query, study["date_from_ts"], study["date_to_ts"], sort):
                        n_seen += 1
                        if not _in_window(post, study):
                            continue
                        if store.upsert_post(post, query, source.name, sort, study["comment_mode"]):
                            n_new += 1
                            if study["comment_mode"] == "immediate":
                                _collect_now(source, store, post)
                    total_new += n_new
                    say("    %d results, %d new to the study" % (n_seen, n_new))
    return total_new


def run_stream(study, store, source, limit):
    sub = study["subreddits"][0]
    say("  %s r/%s newest first%s" % (source.name, sub, " (limit %d)" % limit if limit else ""))
    n = 0
    for post in source.list_posts(sub, study["date_from_ts"], study["date_to_ts"]):
        if store.upsert_post(post, "", source.name, "new", study["comment_mode"]):
            n += 1
            if study["comment_mode"] == "immediate":
                _collect_now(source, store, post)
            if n % 100 == 0:
                say("    %d posts" % n)
        if limit and n >= limit:
            break
    return n


def _collect_now(source, store, post):
    """immediate mode: one bad thread stays pending; the run goes on."""
    try:
        collect_for_post(source, store, post["id"], post["num_comments"])
    except Exception as exc:
        store.defer_pending(post["id"], exc)
        say("    comments for %s deferred (%s)" % (post["id"], str(exc)[:100]))


def _in_window(post, study):
    ts = post.get("created_utc") or 0
    if study["date_from_ts"] and ts < study["date_from_ts"]:
        return False
    if study["date_to_ts"] and ts > study["date_to_ts"]:
        return False
    return True


# --- count: measure before committing -----------------------------------------

class _NoStore:
    """Sources log through the store; --count keeps nothing."""
    def log_request(self, **record):
        pass


def _walks(study, sources):
    for source in sources:
        sorts = [s for s in study["sorts"] if s in source.supports_sorts] or ["new"]
        for sub in study["subreddits"]:
            if sub.lower() == "all" and source.name != "reddit_search":
                continue
            for query in study["queries"] or [""]:
                for sort in sorts:
                    yield source, sub, query, sort


def run_count(study, mode, limit=None):
    sources = [make_source(s, study, _NoStore()) for s in study["sources"]]
    seen = {}
    t0 = time.time()
    if mode == "search":
        for source, sub, query, sort in _walks(study, sources):
            n = 0
            for post in source.search_posts(sub, query, study["date_from_ts"], study["date_to_ts"], sort):
                if not _in_window(post, study):
                    continue
                n += 1
                seen.setdefault(post["id"], post)
            say("  %s r/%s %r sort=%s: %d posts" % (source.name, sub, query, sort, n))
    else:
        source = sources[0]
        n = 0
        for post in source.list_posts(study["subreddits"][0], study["date_from_ts"], study["date_to_ts"]):
            n += 1
            seen.setdefault(post["id"], post)
            if limit and n >= limit:
                break
    posts = list(seen.values())
    comments = sum(p["num_comments"] for p in posts)
    words = sum(len((p["title"] + " " + p["selftext"]).split()) for p in posts)
    removed = sum(1 for p in posts if p["selftext"].strip() in ("[removed]", "[deleted]"))
    if posts:
        first = min(p["created_utc"] for p in posts)
        last = max(p["created_utc"] for p in posts)
        days = max(1.0, (last - first) / 86400.0)
    else:
        first = last = days = 0
    # 1 req/s: one page per 100 posts, then one request per post plus one per further 100 comments
    requests_needed = (len(posts) + 99) // 100 + len(posts) + comments // 100
    say("")
    say("=== corpus measurement (nothing written) ===")
    say("unique posts:              %d%s" % (len(posts), "  (%d with body [removed]/[deleted])" % removed if removed else ""))
    if posts:
        say("span:                      %s .. %s  (%.0f days, %.1f posts/day)" % (
            time.strftime("%Y-%m-%d", time.gmtime(first)), time.strftime("%Y-%m-%d", time.gmtime(last)), days, len(posts) / days))
    say("comments (Reddit's count): %d  — the archive usually holds 4-10%% more" % comments)
    say("words in titles + bodies:  %d" % words)
    say("collection at 1 req/s:     ~%d requests, ~%d min including comments" % (requests_needed, requests_needed // 60 + 1))
    say("measured in %.0fs" % (time.time() - t0))
    return len(posts)


# --- post-collection steps --------------------------------------------------

def step_collect_comments(study, store):
    if study["comment_mode"] == "none":
        say("comment_mode is none; nothing to collect")
        return
    source = make_source(study["comment_source"], study, store)
    hours = float(study["comment_settle_hours"])
    pending_total = store.pending_count()
    done, complete, failed = collect_pending(source, store, hours, progress=say)
    say("comments: %d posts fetched (%d complete trees), %d failed, %d still pending"
        % (done, complete, failed, store.pending_count()))
    if store.pending_count() and done == 0 and pending_total:
        hint = settle_wait_hint(store, hours)
        if hint:
            say("  newest pending post settles in ~%dh (comment_settle_hours=%g); use --settle-hours 0 to fetch now" % (hint, hours))


def step_apply_flags(study, store):
    flags = compile_flags(study["flags"])
    if not flags:
        say("study has no flags")
        return
    post_hits = comment_hits = 0
    for prow in store.posts(include_excluded=True):
        post = json.loads(prow["data"])
        names = evaluate(flags, "%s\n%s" % (post.get("title", ""), post.get("selftext", "")), "posts")
        store.set_post_flags(prow["id"], names)
        post_hits += 1 if names else 0
        if any(f["scope"] in ("comments", "both") for f in flags):
            for crow in store.comments(prow["id"]):
                c = json.loads(crow["data"])
                cnames = evaluate(flags, c.get("body", ""), "comments")
                store.set_comment_flags(crow["id"], cnames)
                comment_hits += 1 if cnames else 0
    store.commit()
    say("flags: %d posts and %d comments matched at least one flag" % (post_hits, comment_hits))


def step_filter(study, store):
    excluded = 0
    for prow in store.posts(include_excluded=True):
        post = json.loads(prow["data"])
        # only a complete tree is an authoritative count; otherwise use Reddit's
        n_comments = len(store.comments(prow["id"])) if prow["comments_complete"] else None
        reason = exclusion_reason(post, study, comment_count=n_comments)
        store.set_excluded(prow["id"], reason is not None, reason)
        excluded += 1 if reason else 0
    store.commit()
    say("filter: %d posts excluded, %d kept" % (excluded, len(store.posts())))


def step_report(study, store):
    report = build_report(store, study)
    path = os.path.join(store.out_dir, "report.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    say(format_report(report))
    say("report written to %s" % path)


# --- main ---------------------------------------------------------------------

def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        study = resolve_study(args)
    except StudyError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 2

    mode = args.mode or ("search" if args.study else "stream")
    steps = args.collect_comments or args.apply_flags or args.filter or args.report
    collecting = args.collect or not steps

    out_dir = study_dir(study, args.data_root)

    if args.dry_run:
        say("study: %s -> %s" % (study["name"], out_dir))
        if mode == "search":
            sources = [make_source(s, study, None) for s in study["sources"]]
            plan = request_plan(study, sources)
            say("%d listing walks planned (each pages until the window is exhausted):" % len(plan))
            for line in plan:
                say("  " + line)
            for s in sources:
                if s.name == "reddit_search" and not s.available():
                    say("  note: reddit_search has no credentials in this environment and would fail")
        else:
            say("  arctic_shift: r/%s newest first, window %s..%s%s" % (
                study["subreddits"][0], study["date_from"] or "beginning", study["date_to"] or "now",
                ", limit %d" % args.limit if args.limit else ""))
        say("comment_mode=%s (settle %gh) — comments are fetched by --collect-comments" % (
            study["comment_mode"], study["comment_settle_hours"]))
        return 0

    if args.count:
        say("study: %s — counting r/%s %s" % (study["name"], ", r/".join(study["subreddits"]),
            "for %d queries" % len(study["queries"]) if study["queries"] else "(stream)"))
        run_count(study, mode, args.limit)
        return 0

    store = Store(out_dir)
    if study.get("_path"):
        digest, previous = persist_config(study, out_dir)
        say("study %s (config sha256 %s…)" % (study["name"], digest[:12]))
        if previous:
            say("  WARNING: the study config changed since the last run (was %s…); the old copy is kept as %s"
                % (previous[0][:12], previous[1]))
    else:
        say("stream study %s" % study["name"])

    t0 = time.time()
    try:
        if collecting:
            if mode == "search":
                sources = [make_source(s, study, store) for s in study["sources"]]
                for s in sources:
                    if s.name == "reddit_search" and not s.available():
                        print("error: reddit_search is in `sources` but REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET are not set. "
                              "Remove it from the study or export the variables.", file=sys.stderr)
                        return 2
                new = run_search(study, store, sources)
            else:
                source = make_source("arctic_shift", study, store)
                new = run_stream(study, store, source, args.limit)
            say("collected %d new posts in %.0fs; %d posts awaiting comments" % (new, time.time() - t0, store.pending_count()))

        if args.collect_comments:
            step_collect_comments(study, store)
        if args.apply_flags:
            step_apply_flags(study, store)
        if args.filter:
            step_filter(study, store)

        path, rows = write_csv(store, study)
        say("wrote %s (%d rows)" % (path, rows))

        if args.report or collecting:
            step_report(study, store)
    except KeyboardInterrupt:
        say("\ninterrupted — progress is in %s; rerun to continue" % store.path)
        path, rows = write_csv(store, study)
        say("wrote %s (%d rows)" % (path, rows))
        return 130
    finally:
        store.close()
    return 0
