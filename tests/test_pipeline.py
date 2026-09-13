"""Store → comments → flags → filter → CSV, on a temporary study."""
import csv
import json
import os

from lemonsqueeze.comments import collect_for_post, is_complete
from lemonsqueeze.filters import exclusion_reason
from lemonsqueeze.flags import compile_flags, evaluate
from lemonsqueeze.schema import COLUMNS, assign_depths
from lemonsqueeze.store import Store
from lemonsqueeze.writer import write_csv


class FakeSource:
    name = "fake"

    def __init__(self, comments, walked=True):
        self._comments = comments
        self._walked = walked

    def fetch_comments(self, post_id, num_comments):
        return list(self._comments), self._walked


def post(i, **kw):
    p = {"id": "p%d" % i, "subreddit": "s", "title": "Title %d" % i, "selftext": "body %d" % i, "author": "alice",
         "created_utc": 1700000000 + i, "score": 5, "num_comments": 2, "permalink": "https://reddit.com/x"}
    p.update(kw)
    return p


def comment(cid, parent, author="bob"):
    return {"id": cid, "body": "hello " + cid, "author": author, "created_utc": 1700000100, "score": 1,
            "parent_id": parent, "is_submitter": False, "depth": None}


STUDY = {"name": "t", "comment_mode": "settled", "anonymise_authors": True, "exclude_terms": ["spam"],
         "min_score": None, "min_comments": None, "queries": ["q"]}


def test_completeness_rule_is_one_sided():
    assert is_complete(True, 100, 100)
    assert is_complete(True, 110, 100)      # archive holds more than Reddit's counter: fine
    assert is_complete(True, 95, 100)
    assert not is_complete(True, 94, 100)
    assert not is_complete(False, 100, 100)  # never complete if the walk stopped short
    assert is_complete(True, 0, 0)


def test_depths_from_parent_chain_with_orphan_and_cycle():
    cs = [comment("a", "t3_p"), comment("b", "t1_a"), comment("c", "t1_b"), comment("o", "t1_missing"),
          comment("x", "t1_y"), comment("y", "t1_x")]
    assign_depths(cs)
    by = {c["id"]: c["depth"] for c in cs}
    assert by == {"a": 0, "b": 1, "c": 2, "o": None, "x": None, "y": None}


def test_end_to_end_csv(tmp_path):
    store = Store(str(tmp_path / "t"))
    assert store.upsert_post(post(1), "q", "fake", "new", "settled") is True
    assert store.upsert_post(post(1), "q2", "fake", "new", "settled") is False   # seen again by another query
    store.upsert_post(post(2, selftext="[removed]"), "q", "fake", "new", "settled")
    store.upsert_post(post(3, selftext="this is spam really"), "q", "fake", "new", "settled")
    assert store.pending_count() == 3

    n, complete = collect_for_post(FakeSource([comment("a", "t3_p1"), comment("b", "t1_a")]), store, "p1", 2)
    assert (n, complete) == (2, True)
    assert store.pending_count() == 2

    # a source that stops short keeps the post pending and stores nothing
    n, complete = collect_for_post(FakeSource([comment("z", "t3_p2")], walked=False), store, "p2", 2)
    assert complete is False
    assert store.pending_count() == 2
    assert store.comments("p2") == []

    flags = compile_flags([{"name": "hello_flag", "pattern": r"\bhello\b", "scope": "comments"},
                           {"name": "title_flag", "pattern": r"Title 1", "scope": "posts"}])
    for prow in store.posts(include_excluded=True):
        p = json.loads(prow["data"])
        store.set_post_flags(prow["id"], evaluate(flags, p["title"] + "\n" + p["selftext"], "posts"))
        for crow in store.comments(prow["id"]):
            store.set_comment_flags(crow["id"], evaluate(flags, json.loads(crow["data"])["body"], "comments"))
    for prow in store.posts(include_excluded=True):
        reason = exclusion_reason(json.loads(prow["data"]), STUDY)
        store.set_excluded(prow["id"], reason is not None, reason)
    store.commit()

    path, rows = write_csv(store, STUDY)
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        assert reader.fieldnames == COLUMNS
        data = list(reader)
    assert rows == 2                                   # p1 has 2 comment rows; p2 and p3 are excluded
    assert {r["post_id"] for r in data} == {"p1"}
    assert data[0]["query"] == "q;q2"
    assert data[0]["post_comments_complete"] == "True"
    assert {r["comment_depth"] for r in data} == {"0", "1"}
    assert data[0]["flags"] == "title_flag;hello_flag"
    # pseudonyms: no raw names, stable across rows, mapping kept locally
    assert all(len(r["post_author"]) == 64 and len(r["comment_author"]) == 64 for r in data)
    assert data[0]["post_author"] == data[1]["post_author"]
    assert os.path.exists(tmp_path / "t" / ".salt")
    excluded = {p["id"]: p["exclude_reason"] for p in store.posts(include_excluded=True) if p["excluded"]}
    assert excluded == {"p2": "body_removed", "p3": "exclude_term:spam"}
    store.close()


def test_write_csv_is_idempotent(tmp_path):
    store = Store(str(tmp_path / "t"))
    store.upsert_post(post(1), "q", "fake", "new", "settled")
    collect_for_post(FakeSource([comment("a", "t3_p1")]), store, "p1", 1)
    p1, _ = write_csv(store, STUDY)
    first = open(p1, encoding="utf-8").read()
    p2, _ = write_csv(store, STUDY)
    assert open(p2, encoding="utf-8").read() == first
    store.close()
