"""Regex flags from the study config, evaluated on posts and/or comments.

A flag matches when ``pattern`` occurs and, if ``near`` is given, the ``near``
pattern also occurs within ``window`` characters of that occurrence.
"""
import re


def compile_flags(flag_specs):
    compiled = []
    for spec in flag_specs:
        compiled.append({
            "name": spec["name"],
            "pattern": re.compile(spec["pattern"], re.IGNORECASE),
            "near": re.compile(spec["near"], re.IGNORECASE) if spec.get("near") else None,
            "window": int(spec.get("window", 200)),
            "scope": spec.get("scope", "posts"),
        })
    return compiled


def matches(flag, text):
    if not text:
        return False
    for m in flag["pattern"].finditer(text):
        if flag["near"] is None:
            return True
        lo = max(0, m.start() - flag["window"])
        hi = min(len(text), m.end() + flag["window"])
        if flag["near"].search(text[lo:hi]):
            return True
    return False


def evaluate(flags, text, scope):
    """Names of flags that match ``text`` and apply to ``scope`` ('posts' or 'comments')."""
    return [f["name"] for f in flags if f["scope"] in (scope, "both") and matches(f, text)]
