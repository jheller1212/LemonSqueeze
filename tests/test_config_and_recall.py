import csv
import os
import time

import pytest

from lemonsqueeze.anonymise import load_or_create_salt, make_hasher
from lemonsqueeze.flags import compile_flags, evaluate
from lemonsqueeze.recall import WindowTooLarge, compile_terms, draw_sample, matched_terms, score_sample, wilson, write_sample
from lemonsqueeze.study import StudyError, load_study


def write_study(tmp_path, text):
    p = tmp_path / "s.yaml"
    p.write_text(text, encoding="utf-8")
    return str(p)


def test_study_defaults_prefix_and_relative_dates(tmp_path):
    s = load_study(write_study(tmp_path, "name: x\nsubreddits: [r/replika, /r/PhD]\nqueries: [a]\ndate_from: 30 days ago\n"))
    assert s["subreddits"] == ["replika", "PhD"]          # not 'eplika'
    assert s["sources"] == ["arctic_shift"]
    assert abs(s["date_from_ts"] - (time.time() - 30 * 86400)) < 5
    assert s["date_to_ts"] is None


def test_study_validation_errors(tmp_path):
    with pytest.raises(StudyError):
        load_study(write_study(tmp_path, "name: x\nsubreddits: [a]\n"))
    with pytest.raises(StudyError):
        load_study(write_study(tmp_path, "name: x\nsubreddits: [a]\nqueries: [q]\nsources: [pullpush]\n"))
    with pytest.raises(StudyError):
        load_study(write_study(tmp_path, "name: x\nsubreddits: [a]\nqueries: [q]\ndate_from: 2026-02-01\ndate_to: 2026-01-01\n"))
    with pytest.raises(StudyError):
        load_study(write_study(tmp_path, "name: 'bad name'\nsubreddits: [a]\nqueries: [q]\n"))


def test_flags_near_window():
    flags = compile_flags([{"name": "f", "pattern": r"my (husband|wife)", "near": r"(AI|chatbot)", "window": 20}])
    assert evaluate(flags, "my husband talks to an AI all day", "posts") == ["f"]
    assert evaluate(flags, "my husband " + "x" * 50 + " AI", "posts") == []
    assert evaluate(flags, "my husband", "comments") == []   # scope defaults to posts


def test_pseudonyms_are_salted_stable_and_keep_placeholders(tmp_path):
    salt = load_or_create_salt(str(tmp_path))
    assert salt == load_or_create_salt(str(tmp_path))
    h = make_hasher(salt)
    assert h("alice") == h("alice") and h("alice") != h("bob")
    assert h("[deleted]") == "[deleted]" and h("AutoModerator") == "AutoModerator"
    assert h("alice") != make_hasher("othersalt")("alice")


def test_local_keyword_matching_mirrors_query_syntax():
    terms = compile_terms(['"my ai"', "chatgpt girlfriend", "replika OR nomi"])
    assert matched_terms(terms, "I told my AI everything") == ['"my ai"']
    assert matched_terms(terms, "my girlfriend uses ChatGPT") == ["chatgpt girlfriend"]
    assert matched_terms(terms, "nothing here") == []
    assert matched_terms(terms, "Nomi is fine") == ["nomi"]
    assert matched_terms(terms, "myai") == []        # word boundary


def test_recall_scoring(tmp_path):
    rows = []
    for i in range(20):
        rows.append({"post_id": str(i), "subreddit": "s", "created_datetime": "", "permalink": "", "title": "", "selftext": "",
                     "keyword_hit": i % 2 == 0, "keyword_hit_local": "", "keywords_matched_local": "",
                     "relevant": "1" if i < 10 else "0", "coder_note": ""})
    write_sample(rows, str(tmp_path))
    r = score_sample(str(tmp_path))
    assert r["coded"] == 20 and r["relevant"] == 10
    assert r["relevant_caught_by_keywords"] == 5 and r["recall"] == 0.5
    lo, hi = r["recall_ci95"]
    assert 0.2 < lo < 0.5 < hi < 0.8
    assert r["precision_in_sample"] == 0.5


class FakeArchive:
    def __init__(self, n=500):
        self.posts = [{"id": "p%03d" % i, "subreddit": "s", "title": "t", "selftext": "", "permalink": "",
                       "created_utc": 1000 + i * 9} for i in range(n)]

    def list_posts(self, subreddit, date_from, date_to):
        for p in sorted(self.posts, key=lambda p: -p["created_utc"]):
            yield p


def test_uniform_sample_is_exact_and_dedups_across_calls():
    arc = FakeArchive()
    seen = set()
    rows, walked = draw_sample(arc, "s", 0, 10 ** 8, 50, ["t"], seed=1, seen=seen, collected_ids=frozenset(["p001"]))
    assert walked == 500 and len(rows) == 50 and len({r["post_id"] for r in rows}) == 50
    rows2, _ = draw_sample(arc, "s", 0, 10 ** 8, 50, ["t"], seed=2, seen=seen)
    assert not {r["post_id"] for r in rows} & {r["post_id"] for r in rows2}
    assert all(r["keyword_hit"] == (r["post_id"] == "p001") for r in rows)
    assert all(r["keyword_hit_local"] for r in rows)   # the regex approximation says every 't' matches
    small, _ = draw_sample(FakeArchive(7), "s", 0, 10 ** 8, 50, ["t"], seed=1)
    assert len(small) == 7                             # asks for more than exist: returns what exists


def test_sample_refuses_windows_above_the_walk_cap():
    with pytest.raises(WindowTooLarge):
        draw_sample(FakeArchive(30), "s", 0, 10 ** 8, 5, ["t"], max_walk=10)


def test_wilson_bounds():
    assert wilson(0, 0) == (0.0, 1.0)
    lo, hi = wilson(10, 10)
    assert lo > 0.7 and hi == 1.0
