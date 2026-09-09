"""
Shared password hashing — used by both local Profile passwords
(routers/profiles.py) and team passwords (team_service.py). PBKDF2 with a
random per-hash salt, stdlib only (no extra dependency). Not a login system
with rate limiting/lockout — matches this whole app's existing "closed
trusted circle" security posture (see routers/settings.py's ADMIN_PASSWORD
comment), just meaningfully better than storing/comparing plaintext.
"""
import hashlib
import os

_ITERATIONS = 200_000


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _ITERATIONS)
    return f"{salt.hex()}:{digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt_hex, digest_hex = stored.split(":", 1)
    except ValueError:
        return False
    salt = bytes.fromhex(salt_hex)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _ITERATIONS)
    return digest.hex() == digest_hex
