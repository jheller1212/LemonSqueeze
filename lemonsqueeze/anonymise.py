"""Author pseudonymisation: SHA-256 of name + a per-study salt kept locally."""
import hashlib
import os
import secrets

KEEP_AS_IS = ("[deleted]", "[removed]", "AutoModerator", "")


def load_or_create_salt(out_dir):
    path = os.path.join(out_dir, ".salt")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    salt = secrets.token_hex(32)
    os.makedirs(out_dir, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(salt + "\n")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return salt


def make_hasher(salt):
    def hasher(name):
        if name in KEEP_AS_IS:
            return name
        return hashlib.sha256((salt + name).encode("utf-8")).hexdigest()
    return hasher
