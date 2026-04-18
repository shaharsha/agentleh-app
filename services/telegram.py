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
    """Host-side (.env / docker-compose interpolation) variable name
    for this agent's Telegram bot token.

    Matches the existing agentleh convention from create-agent.sh:
    <AGENT_ID_UPPER>_<VAR>, not <VAR>_<AGENT_ID>. Example:
    `T1_SHEM_TOV_851D_TELEGRAM_BOT_TOKEN`. The compose entry then maps
    this host-side var to the simpler container env var
    `TELEGRAM_BOT_TOKEN`, which OpenClaw's openclaw.json references
    via ${TELEGRAM_BOT_TOKEN}.
    """
    upper = re.sub(r"[^A-Z0-9]", "_", agent_id.upper())
    return f"{upper}_TELEGRAM_BOT_TOKEN"


def build_enable_patch(env_var: str) -> dict[str, Any]:
    """JSON Merge Patch body for enabling the Telegram channel.

    We reference the CONTAINER-SIDE env var name (TELEGRAM_BOT_TOKEN)
    in openclaw.json — the host-side prefixed name (the `env_var`
    argument) is what we write to /opt/agentleh/.env and what the
    agent's compose entry maps from. OpenClaw's own schema rejects
    any extra keys under channels.telegram, so we set ONLY the fields
    the built-in Telegram extension accepts (enabled + botToken).
    Older drafts included `mode: "polling"` — that's rejected with
    'Unrecognized key: "mode"' since polling is implicit for managed
    bots. Keep the signature `env_var` for symmetry with callers that
    also need to write to /opt/agentleh/.env.
    """
    del env_var  # accepted for API compatibility; openclaw.json uses the fixed container-side name
    # dmPolicy=open + allowFrom=["*"] together mean "anyone who messages
    # the bot can chat with the agent, no pairing handshake required."
    # Default OpenClaw behavior is dmPolicy=pairing, which replies to
    # every new sender with an "OpenClaw: access not configured" message
    # + pairing code that the bot owner must approve via a CLI command.
    # That's the wrong default for an Agentleh agent — the bot is the
    # customer-facing surface; everyone messaging it IS the intended
    # audience. Open policy moves authorization from "per-sender opt-in"
    # to "per-bot opt-in" (the tenant admin connected the bot = all
    # senders welcome). If a tenant ever needs per-sender gating we can
    # expose it in the Bridges panel UI as a future enhancement.
    return {
        "channels": {
            "telegram": {
                "enabled": True,
                "botToken": "${TELEGRAM_BOT_TOKEN}",
                "dmPolicy": "open",
                "allowFrom": ["*"],
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
