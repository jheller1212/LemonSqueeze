"""LemonSqueeze command-line collector.

Two modes share one pipeline: ``stream`` walks a subreddit chronologically,
``search`` runs the queries of a study config against pluggable sources.
Both write into a per-study SQLite store from which the CSV is regenerated,
so every post-collection step is idempotent.
"""

__version__ = "2.0.0"
