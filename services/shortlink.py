"""Short-URL generator for the WhatsApp OAuth connect flow.

Turns a ~450-char ``/api/oauth/google/start?t=<jwt>`` URL into a
~37-char ``https://<app>/c/<code>`` URL so the message the agent
sends in WhatsApp is readable and tappable instead of looking like a
security warning.

Mapping lives in Postgres (``oauth_connect_shortlinks`` table, created
in ``lib/db.py::init``). 15-minute TTL mirrors the JWT TTL so an
expired shortlink produces the same user-visible error as an expired
JWT — consistent messaging across both paths.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone

# URL-safe base62 alphabet. `secrets.choice` keeps the entropy cryptographically
# strong — 10 chars × 62 = ~59 bits, collision probability on any single insert
# is vanishingly small even at millions of links per day.
_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
_CODE_LENGTH = 10

# Same TTL as the JWT itself. If we ever decouple them, keep the shortlink
# TTL ≥ the JWT TTL so a fresh shortlink never outlives its contents.
SHORTLINK_TTL_SECONDS = 15 * 60


def generate_code() -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(_CODE_LENGTH))


def create_shortlink(db, *, long_url: str) -> tuple[str, datetime]:
    """Insert a new row and return (code, expires_at).

    Retries once on the (extremely unlikely) PK collision. Anything
    else bubbles up so the route can 500.
    """
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=SHORTLINK_TTL_SECONDS)
    for _ in range(2):
        code = generate_code()
        try:
            db.create_oauth_shortlink(code=code, long_url=long_url, expires_at=expires_at)
            return code, expires_at
        except Exception:  # noqa: BLE001
            # Collision or transient error — try once more with a fresh code.
            continue
    # Final attempt: if this one also fails, let the exception propagate.
    code = generate_code()
    db.create_oauth_shortlink(code=code, long_url=long_url, expires_at=expires_at)
    return code, expires_at


def resolve_shortlink(db, *, code: str) -> str | None:
    """Return the stored long URL for a code, or None if missing/expired."""
    row = db.get_oauth_shortlink(code)
    if row is None:
        return None
    return row.get("long_url")
