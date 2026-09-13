"""Regenerate data/<study>/posts_comments.csv from the store. Idempotent by construction."""
import csv
import json
import os

from .anonymise import load_or_create_salt, make_hasher
from .schema import COLUMNS, EMPTY_COMMENT_FIELDS, comment_fields, iso, post_fields


def write_csv(store, study):
    path = os.path.join(store.out_dir, "posts_comments.csv")
    tmp = path + ".tmp"
    hasher = None
    if study.get("anonymise_authors", True):
        hasher = make_hasher(load_or_create_salt(store.out_dir))

    def pseudonym(name):
        if hasher is None:
            return name
        return store.author_hash(name, hasher)

    rows = 0
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS, extrasaction="ignore")
        w.writeheader()
        for prow in store.posts():
            post = json.loads(prow["data"])
            complete = prow["comments_complete"]
            if study.get("comment_mode") == "none":
                complete = None
            pf = post_fields(post, None if complete is None else bool(complete))
            pf["post_author"] = pseudonym(pf["post_author"])
            attrs = store.attributions(prow["id"])
            study_cols = {
                "study": study["name"],
                "query": ";".join(sorted({a["query"] for a in attrs if a["query"]})),
                "source": ";".join(sorted({a["source"] for a in attrs})),
                "sort": ";".join(sorted({a["sort"] for a in attrs if a["sort"]})),
                "collected_at": iso(min(a["collected_at"] for a in attrs)) if attrs else iso(prow["discovered_at"]),
            }
            comments = store.comments(prow["id"])
            if not comments:
                row = dict(pf)
                row.update(EMPTY_COMMENT_FIELDS)
                row.update(study_cols)
                row["row_type"] = "post_only"
                row["flags"] = prow["flags"]
                w.writerow(row)
                rows += 1
                continue
            for crow in comments:
                c = json.loads(crow["data"])
                cf = comment_fields(c)
                cf["comment_author"] = pseudonym(cf["comment_author"])
                row = dict(pf)
                row.update(cf)
                row.update(study_cols)
                row["row_type"] = "comment"
                row["flags"] = ";".join(x for x in (prow["flags"], crow["flags"]) if x)
                w.writerow(row)
                rows += 1
    store.commit()
    os.replace(tmp, path)
    return path, rows
