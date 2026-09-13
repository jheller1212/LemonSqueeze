"""Cursor logic against a fake archive with exclusive `after`/`before`, capped at 100 per page."""
from lemonsqueeze.sources.arctic_shift import ArcticShift


class FakeStore:
    def __init__(self):
        self.log = []

    def log_request(self, **record):
        self.log.append(record)


def make_source(items):
    """items: list of (id, created_utc). Serves them the way Arctic does."""
    src = ArcticShift({"name": "t"}, FakeStore())

    def _get(path, params, **log_fields):
        rows = list(items)
        if "after" in params:
            rows = [r for r in rows if r[1] > int(params["after"])]
        if "before" in params:
            rows = [r for r in rows if r[1] < int(params["before"])]
        if params.get("query"):
            rows = [r for r in rows if params["query"] in r[0]]
        rows.sort(key=lambda r: r[1], reverse=(params.get("sort") == "desc"))
        rows = rows[: int(params.get("limit", 100))]
        src.store.log_request(page=len(src.store.log) + 1, results=len(rows))
        return [{"id": i, "created_utc": t, "subreddit": "s", "title": i, "num_comments": 0,
                 "link_id": "t3_x", "parent_id": "t3_x", "body": i} for i, t in rows]

    src._get = _get
    return src


def ids(posts):
    return [p["id"] for p in posts]


def test_walk_forward_covers_boundary_second_without_duplicates():
    # 250 posts, several sharing the second at each page boundary
    items = []
    t = 1000
    for i in range(250):
        if i % 100 == 99:
            t = t  # same second as the previous one -> boundary tie
        else:
            t += 1
        items.append(("p%03d" % i, t))
    src = make_source(items)
    got = ids(src.search_posts("s", "", 0, 10 ** 9, "new"))
    assert sorted(got) == sorted(i for i, _ in items)
    assert len(got) == len(set(got))


def test_walk_forward_terminates_when_a_page_is_one_second():
    items = [("p%03d" % i, 5000) for i in range(150)] + [("later", 6000)]
    src = make_source(items)
    got = ids(src.search_posts("s", "", 0, 10 ** 9, "new"))
    # the API cannot page inside a single second beyond 100; we must not loop forever
    assert "later" in got
    assert len(got) == len(set(got))
    assert len(src.store.log) < 10


def test_list_posts_newest_first_respects_window():
    items = [("p%03d" % i, 1000 + i) for i in range(300)]
    src = make_source(items)
    got = list(src.list_posts("s", 1100, 1199))
    assert ids(got)[0] == "p199"
    assert ids(got)[-1] == "p100"
    assert len(got) == 100


def test_fetch_comments_walks_to_the_end_and_reports_done():
    items = [("c%03d" % i, 1000 + i // 3) for i in range(320)]  # three comments per second
    src = make_source(items)
    comments, done = src.fetch_comments("x", 320)
    assert done is True
    assert len(comments) == 320
    assert len({c["id"] for c in comments}) == 320


def test_or_query_is_split_into_passes():
    assert ArcticShift.split_query('replika OR "my ai" or chatgpt') == ["replika", '"my ai"', "chatgpt"]
    assert ArcticShift.split_query("plain words") == ["plain words"]
