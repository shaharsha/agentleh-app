"""Signed deep-link token used by the Telegram Managed Bots quick-connect flow.

The Telegram deep-link is `https://t.me/AgentikoManagerBot?start=<token>`,
where <token> carries everything the manager-bot webhook needs to tie
an incoming `/start` message back to a specific (tenant, agent, user)
triple — WITHOUT the webhook ever having to look up server-side state.

Why signed rather than a DB row?
  - The webhook is stateless + public; a signature lets us trust the
    payload without hitting the DB on every inbound /start.
  - Tokens are single-use by convention (the webhook idempotently
    records completion in agent_bridges) and TTL-bounded so a leaked
    Telegram chat history can't reuse an old link.
  - 15-minute TTL matches the Telegram Managed Bots flow — plenty for
    a user to tap, confirm in BotFather MiniApp, and land back.

Wire format
───────────
  token  = base64url(payload_json) + "." + base64url(hmac_sha256(secret, payload_json))
  payload_json = {"v":1,"t":<tenant_id>,"a":<agent_id>,"u":<user_id>,"e":<expires_unix>}

Telegram's /start argument accepts up to 64 characters of [A-Za-z0-9_-]
per the Bot API spec, so we keep the payload compact and URL-safe.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any

_TTL_SECONDS = 15 * 60
_TOKEN_VERSION = 1
_SECRET_ENV = "APP_TELEGRAM_DEEPLINK_SECRET"


class DeeplinkError(Exception):
    """Raised for any signature, expiry, or shape problem. The webhook
    turns this into a no-op reply so probing isn't useful to attackers."""


def _secret() -> bytes:
    raw = os.environ.get(_SECRET_ENV) or ""
    if not raw:
        # Dev fallback — never in prod (Cloud Run sets this via Secret
        # Manager). Using a fixed string here so `uv run pytest` works
        # without config, at the cost of trivial signatures in that env.
        raw = "dev-only-deeplink-signing-secret"
    return raw.encode("utf-8")


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def issue(*, tenant_id: int, agent_id: str, user_id: int, ttl_seconds: int | None = None) -> str:
    """Generate a signed, URL-safe deep-link token.

    `agent_id` is stored verbatim; callers should have validated it
    upstream (it's already constrained to [a-zA-Z0-9_-]+ by create-agent.sh
    and Telegram's /start argument accepts the same char class).
    """
    expires = int(time.time()) + (ttl_seconds or _TTL_SECONDS)
    payload: dict[str, Any] = {
        "v": _TOKEN_VERSION,
        "t": tenant_id,
        "a": agent_id,
        "u": user_id,
        "e": expires,
    }
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    sig = hmac.new(_secret(), body, hashlib.sha256).digest()
    return f"{_b64url_encode(body)}.{_b64url_encode(sig)}"


def verify(token: str) -> dict[str, Any]:
    """Parse + verify. Returns the payload dict ({t, a, u, e}) on success.
    Raises DeeplinkError on any failure — unknown version, bad signature,
    expired, malformed.
    """
    if not token or token.count(".") != 1:
        raise DeeplinkError("malformed_token")
    body_b64, sig_b64 = token.split(".", 1)
    try:
        body = _b64url_decode(body_b64)
        sig = _b64url_decode(sig_b64)
    except Exception as exc:  # noqa: BLE001
        raise DeeplinkError("bad_base64") from exc

    expected = hmac.new(_secret(), body, hashlib.sha256).digest()
    if not hmac.compare_digest(sig, expected):
        raise DeeplinkError("bad_signature")

    try:
        payload = json.loads(body.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise DeeplinkError("bad_payload") from exc

    if not isinstance(payload, dict) or payload.get("v") != _TOKEN_VERSION:
        raise DeeplinkError("bad_version")
    for key in ("t", "a", "u", "e"):
        if key not in payload:
            raise DeeplinkError(f"missing_field:{key}")
    if int(payload["e"]) < int(time.time()):
        raise DeeplinkError("expired")
    return payload
