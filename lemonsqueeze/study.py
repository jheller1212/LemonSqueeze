"""Study configs: load, validate, default, and persist next to the output."""
import hashlib
import os
import re
import shutil
import time
from datetime import datetime, timezone

import yaml

VALID_SOURCES = ("reddit_search", "arctic_shift")
VALID_SORTS = ("relevance", "new", "top", "hot", "comments")
VALID_COMMENT_MODES = ("settled", "immediate", "none")

DEFAULTS = {
    "exclude_terms": [],
    "date_from": None,
    "date_to": None,
    "sources": ["arctic_shift"],
    "sorts": ["relevance", "new", "top"],
    "comment_mode": "settled",
    "comment_source": "arctic_shift",
    "comment_settle_hours": 72,
    "min_score": None,
    "min_comments": None,
    "flags": [],
    "anonymise_authors": True,
    "arctic_window_days": 30,
}

REQUIRED = ("name", "subreddits", "queries")


class StudyError(ValueError):
    pass


RELATIVE = re.compile(r"^\s*(\d+)\s*(day|week|month|year)s?\s+ago\s*$", re.IGNORECASE)
UNIT_DAYS = {"day": 1, "week": 7, "month": 30, "year": 365}


def _parse_date(value, end_of_day=False):
    """ISO date/datetime or '30 days ago' -> epoch seconds (UTC). None passes through."""
    if value in (None, "", "null"):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, datetime):
        return int(value.replace(tzinfo=value.tzinfo or timezone.utc).timestamp())
    if hasattr(value, "year") and not isinstance(value, str):  # datetime.date from YAML
        value = value.isoformat()
    text = str(value)
    m = RELATIVE.match(text)
    if m:
        days = int(m.group(1)) * UNIT_DAYS[m.group(2).lower()]
        return int(time.time()) - days * 86400
    if len(text) == 10:
        text += "T23:59:59" if end_of_day else "T00:00:00"
    dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def load_study(path):
    with open(path, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    if not isinstance(raw, dict):
        raise StudyError("Study file must be a mapping")

    missing = [k for k in REQUIRED if not raw.get(k)]
    if missing:
        raise StudyError("Study is missing required keys: " + ", ".join(missing))

    study = dict(DEFAULTS)
    study.update(raw)
    study["_path"] = os.path.abspath(path)

    name = str(study["name"])
    if not name.replace("_", "").replace("-", "").isalnum():
        raise StudyError("name must be letters, digits, _ or - (it becomes a folder name)")

    if isinstance(study["subreddits"], str):
        study["subreddits"] = [study["subreddits"]]
    study["subreddits"] = [re.sub(r"^(/?r/)", "", str(s).strip()) for s in study["subreddits"]]
    if isinstance(study["queries"], str):
        study["queries"] = [study["queries"]]
    study["queries"] = [str(q) for q in study["queries"]]

    bad = [s for s in study["sources"] if s not in VALID_SOURCES]
    if bad:
        raise StudyError("Unknown sources: %s (valid: %s)" % (bad, ", ".join(VALID_SOURCES)))
    bad = [s for s in study["sorts"] if s not in VALID_SORTS]
    if bad:
        raise StudyError("Unknown sorts: %s (valid: %s)" % (bad, ", ".join(VALID_SORTS)))
    if study["comment_mode"] not in VALID_COMMENT_MODES:
        raise StudyError("comment_mode must be one of " + ", ".join(VALID_COMMENT_MODES))
    if study["comment_source"] not in VALID_SOURCES:
        raise StudyError("comment_source must be one of " + ", ".join(VALID_SOURCES))

    study["date_from_ts"] = _parse_date(study["date_from"])
    study["date_to_ts"] = _parse_date(study["date_to"], end_of_day=True)
    if study["date_from_ts"] and study["date_to_ts"] and study["date_to_ts"] <= study["date_from_ts"]:
        raise StudyError("date_to must be after date_from")

    for flag in study["flags"]:
        if not isinstance(flag, dict) or "name" not in flag or "pattern" not in flag:
            raise StudyError("Each flag needs a name and a pattern")
        flag.setdefault("near", None)
        flag.setdefault("window", 200)
        flag.setdefault("scope", "posts")
        if flag["scope"] not in ("posts", "comments", "both"):
            raise StudyError("flag scope must be posts, comments or both")

    return study


def study_dir(study, data_root="data"):
    return os.path.join(data_root, study["name"])


def config_hash(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def persist_config(study, out_dir):
    """Copy the config beside the output with its hash so a run is repeatable.

    Returns (digest, previous) where previous is (old_digest, backup_name) if a
    different config had already produced data in this folder, else None."""
    os.makedirs(out_dir, exist_ok=True)
    dest = os.path.join(out_dir, "study.yaml")
    new_digest = config_hash(study["_path"])
    previous = None
    if os.path.exists(dest):
        old_digest = config_hash(dest)
        if old_digest != new_digest:
            backup = "study.%s.yaml" % old_digest[:8]
            shutil.copyfile(dest, os.path.join(out_dir, backup))
            previous = (old_digest, backup)
    if os.path.abspath(study["_path"]) != os.path.abspath(dest):
        shutil.copyfile(study["_path"], dest)
    with open(os.path.join(out_dir, "study.sha256"), "w", encoding="utf-8") as f:
        f.write(new_digest + "  study.yaml\n")
    return new_digest, previous


def stream_study(subreddit, date_from=None, date_to=None, name=None, comment_mode="settled"):
    """A synthetic study so stream mode uses the same pipeline and output layout."""
    study = dict(DEFAULTS)
    study.update({
        "name": name or "stream_" + subreddit,
        "subreddits": [subreddit],
        "queries": [],
        "sources": ["arctic_shift"],
        "sorts": ["new"],
        "comment_mode": comment_mode,
        "date_from": date_from,
        "date_to": date_to,
        "_path": None,
    })
    study["date_from_ts"] = _parse_date(date_from)
    study["date_to_ts"] = _parse_date(date_to, end_of_day=True)
    return study
