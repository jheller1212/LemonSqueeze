"""Source registry. Add a source by subclassing Source and registering it here."""
from .arctic_shift import ArcticShift
from .reddit_search import RedditSearch

SOURCES = {
    ArcticShift.name: ArcticShift,
    RedditSearch.name: RedditSearch,
}


def make_source(name, study, store):
    try:
        cls = SOURCES[name]
    except KeyError:
        raise ValueError("Unknown source %r; available: %s" % (name, ", ".join(SOURCES)))
    return cls(study, store)
