"""Telegram bridge — validation + secret storage + container config wiring.

End-to-end connect flow (called from api/routes/bridges.py):

  1. validate_bot_token(token)
       → HTTP GET https://api.telegram.org/bot<token>/getMe
       → parse {username, first_name} or raise
  2. secret_manager.upsert_secret(secret_name_for(agent_id), token)
  3. db.upsert_telegram_bridge(agent_id, username, display_name, secret_name)
  4. provisioner.patch_agent_config(agent_id, patch={...}, env={...}, restart=True)

Disconnect mirrors this in reverse — patch config to disable Telegram
channel, delete the Secret Manager secret, flip the DB row to disabled.

Keep the HTTP calls sync (httpx.Client) — the Telegram Bot API is fast
and the disconnect path needs to block until the config patch lands
before the route returns a 200, so blocking the async event loop for
~1s is acceptable here.
"""

from __future__ import annotations

import logging
import re
from typing import Any

import httpx

from services import secret_manager

logger = logging.getLogger(__name__)

_TELEGRAM_API = "https://api.telegram.org"


def secret_name_for(agent_id: str) -> str:
    """Stable secret name per agent. Used by both connect + disconnect
    paths so we don't store the name in DB AND derive it independently.
    Matches the IAM condition pattern telegram-bot-token-*."""
    # agent_id is already validated tightly by our create-agent code
    # (t<tenant>-<slug>-<hex>) but we defensively sanitize any chars
    # Secret Manager wouldn't accept.
    safe = re.sub(r"[^A-Za-z0-9_-]", "-", agent_id)
    return f"telegram-bot-token-{safe}"


def validate_bot_token(token: str) -> dict[str, Any]:
    """Call getMe. Returns {id, username, first_name, is_bot} on success.

    Raises ValueError with a user-friendly message on failure. The
    upstream error surfaces verbatim for debugging (invalid token →
    `Unauthorized`, malformed token → `Not Found`, etc.).
    """
    token = (token or "").strip()
    if not token:
        raise ValueError("empty token")
    # Bot tokens are <digits>:<base64>. Crude pre-check to catch
    # copy-paste errors before we spend a round-trip.
    if not re.fullmatch(r"\d+:[A-Za-z0-9_-]+", token):
        raise ValueError("malformed token — expected format <id>:<key>")

    url = f"{_TELEGRAM_API}/bot{token}/getMe"
    try:
        with httpx.Client(timeout=10.0) as client:
            resp = client.get(url)
    except httpx.HTTPError as exc:
        raise ValueError(f"telegram api unreachable: {exc}") from exc

    try:
        payload = resp.json()
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"telegram returned non-json (status={resp.status_code})") from exc

    if not isinstance(payload, dict) or not payload.get("ok"):
        description = (payload or {}).get("description") or "invalid_token"
        raise ValueError(description)

    result = payload.get("result") or {}
    if not isinstance(result, dict):
        raise ValueError("unexpected telegram response shape")
    if not result.get("is_bot", True):
        raise ValueError("this token is not a bot token")
    return {
        "id": result.get("id"),
        "username": result.get("username") or "",
        "first_name": result.get("first_name") or "",
        "is_bot": bool(result.get("is_bot")),
    }


def env_var_name_for(agent_id: str) -> str:
    """Per-agent env var name used inside the OpenClaw container.
    Matches the existing convention from create-agent.sh — uppercase
    agent_id with hyphens→underscores, prefixed namespace."""
    return f"TELEGRAM_BOT_TOKEN_{re.sub(r'[^A-Z0-9]', '_', agent_id.upper())}"


def build_enable_patch(env_var: str) -> dict[str, Any]:
    """JSON Merge Patch body for enabling the Telegram channel.

    We reference the token via a ${...} env var substitution in the
    config; the provision-api's config/patch endpoint only rewrites the
    JSON, it doesn't interpret substitutions. The actual token injection
    into the container happens via env_additions (a separate field of
    the same patch request) which writes to /opt/agentleh/.env and is
    read by docker-compose on the restart that follows.
    """
    return {
        "channels": {
            "telegram": {
                "enabled": True,
                "botToken": f"${{{env_var}}}",
                "mode": "polling",
            }
        }
    }


def build_disable_patch() -> dict[str, Any]:
    """JSON Merge Patch body for disabling the Telegram channel.
    Flips enabled→false but keeps the rest of the config so the user
    can re-enable without reconfiguring."""
    return {
        "channels": {
            "telegram": {
                "enabled": False,
            }
        }
    }
