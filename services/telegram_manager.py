"""Telegram Manager-bot API client (Bot API 9.6 Managed Bots).

The "manager bot" is a single global bot (`@AgentikoManagerBot`) with
`can_manage_bots = true` enabled by its owner in BotFather's MiniApp.
We never create one per user — ONE manager bot orchestrates all of
agentleh's per-agent child bots.

This module wraps the Telegram Bot API surface we use:

  • getMe, sendMessage, setWebhook          — standard
  • getManagedBotToken, replaceManagedBotToken — Bot API 9.6
  • KeyboardButtonRequestManagedBot          — the "create bot" button

Token storage
─────────────
Manager-bot token lives in Secret Manager as `telegram-manager-bot-token`
(prod) / `telegram-manager-bot-token-dev` (dev). Fetched on first use and
cached in-process for the life of the Cloud Run instance.

Webhook auth
────────────
Telegram's setWebhook accepts a `secret_token` which Telegram echoes
back in the `X-Telegram-Bot-Api-Secret-Token` header on every inbound
update. We generate it once at webhook-registration time and stash it
in Secret Manager; the webhook route verifies every incoming request
against it so random internet hosts can't POST fake updates.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx

from services import secret_manager

logger = logging.getLogger(__name__)


_TELEGRAM_API = "https://api.telegram.org"

_MANAGER_TOKEN_SECRET = os.environ.get(
    "APP_TELEGRAM_MANAGER_TOKEN_SECRET", "telegram-manager-bot-token"
)
_WEBHOOK_SECRET_SECRET = os.environ.get(
    "APP_TELEGRAM_WEBHOOK_SECRET_SECRET", "telegram-manager-webhook-secret"
)

_cached_token: str | None = None
_cached_webhook_secret: str | None = None


def manager_token() -> str:
    """Fetch the manager bot's token from Secret Manager (cached).

    Raises RuntimeError if the secret hasn't been configured — we'd
    rather fail loud than silently 500 on every /start.
    """
    global _cached_token
    if _cached_token:
        return _cached_token
    try:
        _cached_token = secret_manager.get_secret(_MANAGER_TOKEN_SECRET)
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(
            f"manager bot token not configured in Secret Manager "
            f"(secret={_MANAGER_TOKEN_SECRET}): {exc}"
        ) from exc
    return _cached_token


def webhook_secret() -> str:
    """Shared HMAC-ish secret Telegram echoes back on every webhook
    call. Stored in Secret Manager next to the manager token. If the
    secret doesn't exist yet, we generate one, save it, and use it —
    that way the first setWebhook call bootstraps the secret without
    a manual ops step."""
    global _cached_webhook_secret
    if _cached_webhook_secret:
        return _cached_webhook_secret
    try:
        _cached_webhook_secret = secret_manager.get_secret(_WEBHOOK_SECRET_SECRET)
        return _cached_webhook_secret
    except Exception:  # noqa: BLE001
        pass
    # Bootstrap a fresh secret. Telegram accepts [A-Za-z0-9_-] up to 256
    # chars; use 48 urlsafe bytes ~ 64 chars.
    import secrets as _secrets
    generated = _secrets.token_urlsafe(48)
    try:
        secret_manager.upsert_secret(_WEBHOOK_SECRET_SECRET, generated)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "failed to persist generated webhook secret to Secret Manager: %s",
            exc,
        )
    _cached_webhook_secret = generated
    return generated


def _api(method: str, **params: Any) -> dict[str, Any]:
    """Call a Bot API method with the manager bot's token. Returns
    the `result` field on success. Raises RuntimeError with Telegram's
    `description` on any `ok: false`."""
    token = manager_token()
    url = f"{_TELEGRAM_API}/bot{token}/{method}"
    with httpx.Client(timeout=15.0) as client:
        resp = client.post(url, json=params)
    try:
        body = resp.json()
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"telegram {method}: non-json response") from exc
    if not body.get("ok"):
        raise RuntimeError(
            f"telegram {method}: {body.get('description') or body.get('error_code') or 'unknown'}"
        )
    return body.get("result") or {}


# ── Standard methods ──────────────────────────────────────────────────


def get_me() -> dict[str, Any]:
    return _api("getMe")


def send_message(
    chat_id: int | str,
    text: str,
    *,
    reply_markup: dict[str, Any] | None = None,
    parse_mode: str | None = None,
) -> dict[str, Any]:
    params: dict[str, Any] = {"chat_id": chat_id, "text": text}
    if reply_markup is not None:
        params["reply_markup"] = reply_markup
    if parse_mode:
        params["parse_mode"] = parse_mode
    return _api("sendMessage", **params)


def set_webhook(url: str, *, drop_pending_updates: bool = True) -> dict[str, Any]:
    """Register the manager bot's webhook. Idempotent — calling with
    the same URL rebinds, which is useful after a URL change or secret
    rotation.

    We subscribe to `allowed_updates=["message","managed_bot"]` so we
    only receive:
      - text messages (the /start <token> flow)
      - managed_bot updates (bot creation + owner/token changes)
    Everything else Telegram emits we don't care about — keeps traffic
    to Cloud Run minimal.
    """
    return _api(
        "setWebhook",
        url=url,
        secret_token=webhook_secret(),
        drop_pending_updates=drop_pending_updates,
        allowed_updates=["message", "managed_bot"],
    )


# ── Bot API 9.6 Managed Bots ─────────────────────────────────────────


def send_request_managed_bot(
    chat_id: int,
    *,
    prompt: str,
    button_text: str,
    request_id: int,
    suggested_bot_name: str | None = None,
    suggested_bot_username: str | None = None,
) -> dict[str, Any]:
    """Send a ReplyKeyboardMarkup with a single KeyboardButtonRequestManagedBot
    button. Tapping it opens BotFather's native creation UI (pre-filled
    with the suggested name/username). On confirm, the manager bot
    receives a `managed_bot` update correlating via request_id.

    Per the Bot API 9.6 spec (the exact field names aren't fully published
    in the docs page yet — this matches Telegram's naming conventions
    for analogous buttons like request_chat / request_user). If a field
    name differs, webhook logs will surface the real shape and we tweak
    this dict.
    """
    request_managed_bot: dict[str, Any] = {"request_id": request_id}
    if suggested_bot_name:
        request_managed_bot["bot_name"] = suggested_bot_name
    if suggested_bot_username:
        request_managed_bot["bot_username"] = suggested_bot_username

    reply_markup = {
        "keyboard": [
            [
                {
                    "text": button_text,
                    "request_managed_bot": request_managed_bot,
                }
            ]
        ],
        "resize_keyboard": True,
        "one_time_keyboard": True,
        "is_persistent": False,
    }
    return send_message(chat_id, prompt, reply_markup=reply_markup)


def get_managed_bot_token(bot_id: int) -> str:
    """Fetch the access token for a bot created under our manager.
    Returns the raw token string.

    The Bot API returns a dict whose exact key is underdocumented at
    the time of writing; the most common shape for analogous APIs is
    {"token": "...bot_token..."} but it may instead be just the token
    string. We handle both.
    """
    result = _api("getManagedBotToken", bot_id=bot_id)
    if isinstance(result, dict):
        token = result.get("token") or result.get("access_token")
        if token:
            return str(token)
    if isinstance(result, str):
        return result
    raise RuntimeError(f"getManagedBotToken: unexpected result shape: {result!r}")


def replace_managed_bot_token(bot_id: int) -> str:
    """Rotate the managed bot's token — returns the new one. Used by
    admin flows if a leaked token needs to be invalidated."""
    result = _api("replaceManagedBotToken", bot_id=bot_id)
    if isinstance(result, dict):
        token = result.get("token") or result.get("access_token")
        if token:
            return str(token)
    if isinstance(result, str):
        return result
    raise RuntimeError(f"replaceManagedBotToken: unexpected result shape: {result!r}")


def suggested_username_for_agent(*, tenant_id: int, agent_slug: str) -> str:
    """Deterministic + unique suggested username for a Managed Bot.

    Pattern: agentiko_t<tenant>_<slug-sanitized>_bot
    Telegram requires 5-32 chars, must end in `bot`, `[a-zA-Z0-9_]`.
    We lowercase + drop hyphens (Telegram usernames don't allow them).
    Not guaranteed unique — if BotFather says it's taken, the MiniApp
    will prompt the user to edit. The user can always override.
    """
    import re
    slug = re.sub(r"[^a-z0-9_]", "", agent_slug.lower())[:18] or "agent"
    base = f"agentiko_t{tenant_id}_{slug}"
    # Keep final length under 32 including `_bot` suffix.
    base = base[: 32 - len("_bot")]
    return f"{base}_bot"
