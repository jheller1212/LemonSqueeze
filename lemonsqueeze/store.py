"""Per-study SQLite store and request log.

The store is the source of truth; the CSV is regenerated from it after every
step. Posts keep every (query, source, sort) that found them so provenance
survives deduplication.
"""
import json
import os
import sqlite3
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    subreddit TEXT NOT NULL,
    data TEXT NOT NULL,
    discovered_at INTEGER NOT NULL,
    num_comments INTEGER NOT NULL DEFAULT 0,
    comments_complete INTEGER,
    comments_fetched_at INTEGER,
    excluded INTEGER NOT NULL DEFAULT 0,
    exclude_reason TEXT,
    flags TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS attributions (
    post_id TEXT NOT NULL,
    query TEXT NOT NULL,
    source TEXT NOT NULL,
    sort TEXT NOT NULL,
    collected_at INTEGER NOT NULL,
    PRIMARY KEY (post_id, query, source, sort)
);
CREATE TABLE IF NOT EXISTS pending_comments (
    post_id TEXT PRIMARY KEY,
    discovered_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
);
CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    data TEXT NOT NULL,
    flags TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS comments_post ON comments(post_id);
CREATE TABLE IF NOT EXISTS authors (
    name TEXT PRIMARY KEY,
    hash TEXT NOT NULL
);
"""


class Store:
    def __init__(self, out_dir):
        os.makedirs(out_dir, exist_ok=True)
        self.out_dir = out_dir
        self.path = os.path.join(out_dir, "study.sqlite")
        self.db = sqlite3.connect(self.path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        self.log_path = os.path.join(out_dir, "run_log.jsonl")

    # --- request log -------------------------------------------------------

    def log_request(self, **record):
        record.setdefault("timestamp", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
        with open(self.log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")

    # --- posts -------------------------------------------------------------

    def upsert_post(self, post, query, source, sort, comment_mode):
        """Insert or refresh a post; returns True if it was new to the study."""
        now = int(time.time())
        row = self.db.execute("SELECT id FROM posts WHERE id = ?", (post["id"],)).fetchone()
        is_new = row is None
        if is_new:
            self.db.execute(
                "INSERT INTO posts (id, subreddit, data, discovered_at, num_comments) VALUES (?, ?, ?, ?, ?)",
                (post["id"], post.get("subreddit", ""), json.dumps(post, ensure_ascii=False), now, int(post.get("num_comments") or 0)),
            )
            if comment_mode != "none":
                self.db.execute(
                    "INSERT OR IGNORE INTO pending_comments (post_id, discovered_at) VALUES (?, ?)",
                    (post["id"], now),
                )
        else:
            # A later sighting carries fresher score/num_comments; keep the newer record.
            self.db.execute(
                "UPDATE posts SET data = ?, num_comments = MAX(num_comments, ?) WHERE id = ?",
                (json.dumps(post, ensure_ascii=False), int(post.get("num_comments") or 0), post["id"]),
            )
        self.db.execute(
            "INSERT OR IGNORE INTO attributions (post_id, query, source, sort, collected_at) VALUES (?, ?, ?, ?, ?)",
            (post["id"], query, source, sort, now),
        )
        self.db.commit()
        return is_new

    def post(self, post_id):
        row = self.db.execute("SELECT * FROM posts WHERE id = ?", (post_id,)).fetchone()
        return dict(row) if row else None

    def posts(self, include_excluded=False):
        sql = "SELECT * FROM posts" + ("" if include_excluded else " WHERE excluded = 0") + " ORDER BY discovered_at, id"
        return [dict(r) for r in self.db.execute(sql)]

    def attributions(self, post_id):
        return [dict(r) for r in self.db.execute(
            "SELECT query, source, sort, collected_at FROM attributions WHERE post_id = ? ORDER BY collected_at", (post_id,))]

    def set_excluded(self, post_id, excluded, reason=None):
        self.db.execute("UPDATE posts SET excluded = ?, exclude_reason = ? WHERE id = ?", (1 if excluded else 0, reason, post_id))

    def set_post_flags(self, post_id, flags):
        self.db.execute("UPDATE posts SET flags = ? WHERE id = ?", (";".join(flags), post_id))

    # --- comments ----------------------------------------------------------

    def pending(self, older_than_hours):
        cutoff = int(time.time()) - int(older_than_hours * 3600)
        return [dict(r) for r in self.db.execute(
            "SELECT * FROM pending_comments WHERE discovered_at <= ? ORDER BY discovered_at", (cutoff,))]

    def pending_count(self):
        return self.db.execute("SELECT COUNT(*) FROM pending_comments").fetchone()[0]

    def replace_comments(self, post_id, comments, complete):
        """Replace earlier (partial) rows for this post with the fresh full tree."""
        self.db.execute("DELETE FROM comments WHERE post_id = ?", (post_id,))
        self.db.executemany(
            "INSERT INTO comments (id, post_id, data) VALUES (?, ?, ?)",
            [(c["id"], post_id, json.dumps(c, ensure_ascii=False)) for c in comments],
        )
        self.db.execute(
            "UPDATE posts SET comments_complete = ?, comments_fetched_at = ? WHERE id = ?",
            (1 if complete else 0, int(time.time()), post_id),
        )
        self.db.execute("DELETE FROM pending_comments WHERE post_id = ?", (post_id,))
        self.db.commit()

    def defer_pending(self, post_id, error):
        self.db.execute(
            "UPDATE pending_comments SET attempts = attempts + 1, last_error = ? WHERE post_id = ?", (str(error)[:300], post_id))
        self.db.commit()

    def comments(self, post_id):
        return [dict(r) for r in self.db.execute("SELECT * FROM comments WHERE post_id = ?", (post_id,))]

    def set_comment_flags(self, comment_id, flags):
        self.db.execute("UPDATE comments SET flags = ? WHERE id = ?", (";".join(flags), comment_id))

    # --- authors (anonymisation mapping, local only) -----------------------

    def author_hash(self, name, hasher):
        row = self.db.execute("SELECT hash FROM authors WHERE name = ?", (name,)).fetchone()
        if row:
            return row["hash"]
        digest = hasher(name)
        self.db.execute("INSERT INTO authors (name, hash) VALUES (?, ?)", (name, digest))
        return digest

    def commit(self):
        self.db.commit()

    def close(self):
        self.db.commit()
        self.db.close()
