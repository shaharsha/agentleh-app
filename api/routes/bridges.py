"""Bridges router — per-agent delivery channels.

Three bridges, one shape:

  GET    /api/tenants/{tid}/agents/{aid}/bridges                  — all three at once
  PATCH  /api/tenants/{tid}/agents/{aid}/bridges/whatsapp         — {phone: str|null}
  POST   /api/tenants/{tid}/agents/{aid}/bridges/telegram/connect  — {bot_token: str}
  POST   /api/tenants/{tid}/agents/{aid}/bridges/telegram/test     — re-runs getMe
  DELETE /api/tenants/{tid}/agents/{aid}/bridges/telegram          — disconnect

Web chat has no management endpoints here — it's always enabled and the
chat surface lives behind a separate WebSocket route (`api/routes/chat.py`)
that validates tenant membership on every connection.

Every mutation route is wrapped in `require_tenant_role('admin')` — only
owner/admin members can change bridge wiring. Members can READ (for the
Bridges panel renders) via `require_tenant_role('member')`.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from api.deps import (
    TenantContext,
    require_tenant_role,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/tenants", tags=["bridges"])


# ─── Shapes ───────────────────────────────────────────────────────────

class WhatsappPatch(BaseModel):
    # `phone` can be: a valid E.164-ish string (connect/change), empty
    # string (disconnect), or null (disconnect). Server normalizes via
    # tenants._normalize_phone_e164 when non-empty.
    phone: str | None = Field(default=None, max_length=30)


class TelegramConnect(BaseModel):
    bot_token: str = Field(..., min_length=10, max_length=200)


# ─── Helpers ──────────────────────────────────────────────────────────

def _format_phone_for_display(digits: str | None) -> str | None:
    """Bridges-panel UI shows '+972 50 123 4567'. We store digits-only,
    so prepend the `+` — libphonenumber handles the display formatting
    on the frontend. Leave empty input as None."""
    return f"+{digits}" if digits else None


def _render_bridges(db, agent_id: str) -> dict[str, Any]:
    """Read all agent_bridges rows + collapse into the UI shape.

    Every agent ALWAYS gets three entries in the response even if no
    row exists — the UI expects a stable shape. Missing rows collapse
    to `{enabled: false, status: "disconnected"}`.
    """
    rows = {
        row["bridge_type"]: row for row in db.get_agent_bridges(agent_id)
    }

    # WhatsApp — prefer phone_routes as the authoritative source
    # (matches what the bridge actually reads). agent_bridges is the
    # sidecar flag, not the routing truth.
    wa_phone_digits = db.get_phone_for_agent(agent_id)
    wa_enabled = wa_phone_digits is not None
    whatsapp: dict[str, Any] = {
        "enabled": wa_enabled,
        "status": "connected" if wa_enabled else "disconnected",
        "phone": _format_phone_for_display(wa_phone_digits),
        "actions": ["edit_phone", "disconnect"] if wa_enabled else ["connect"],
    }

    # Telegram — read config from agent_bridges row if present.
    tg_row = rows.get("telegram")
    if tg_row and tg_row.get("enabled"):
        tg_config = tg_row.get("config") or {}
        telegram: dict[str, Any] = {
            "enabled": True,
            "status": "connected",
            "bot_username": tg_config.get("bot_username") or "",
            "bot_display_name": tg_config.get("bot_display_name") or "",
            "actions": ["test", "update_token", "disconnect"],
        }
    else:
        telegram = {
            "enabled": False,
            "status": "disconnected",
            "actions": ["connect"],
        }

    # Web — always available. No per-agent config today.
    web: dict[str, Any] = {
        "enabled": True,
        "status": "connected",
        # The Bridges panel turns this into an in-app navigation to
        # the ChatPane route; it's not an externally-reachable URL.
        "chat_url": f"/tenants/%TENANT%/agents/{agent_id}/chat",
        "actions": ["open_chat"],
    }

    return {
        "agent_id": agent_id,
        "bridges": {
            "whatsapp": whatsapp,
            "telegram": telegram,
            "web": web,
        },
    }


def _assert_agent_in_tenant(db, agent_id: str, tenant_id: int) -> None:
    """404 on cross-tenant access — matches the tenant guard pattern
    used throughout the app (no leaking cross-tenant existence)."""
    if db.get_agent_tenant_id(agent_id) != tenant_id:
        raise HTTPException(status_code=404, detail="agent not found")


# ─── Routes ───────────────────────────────────────────────────────────

@router.get("/{tenant_id}/agents/{agent_id}/bridges")
async def get_bridges(
    tenant_id: int,
    agent_id: str,
    request: Request,
    ctx: TenantContext = Depends(require_tenant_role("member")),
) -> dict[str, Any]:
    db = request.app.state.db
    _assert_agent_in_tenant(db, agent_id, tenant_id)
    payload = _render_bridges(db, agent_id)
    # Expand the web chat URL placeholder now that we know the tenant.
    web = payload["bridges"]["web"]
    web["chat_url"] = web["chat_url"].replace("%TENANT%", str(tenant_id))
    return payload


@router.patch("/{tenant_id}/agents/{agent_id}/bridges/whatsapp")
async def patch_whatsapp_bridge(
    tenant_id: int,
    agent_id: str,
    body: WhatsappPatch,
    request: Request,
    ctx: TenantContext = Depends(require_tenant_role("admin")),
) -> dict[str, Any]:
    """Connect, change, or disconnect the WhatsApp bridge.

    `body.phone` semantics:
      None or "" → disconnect (drop phone_routes, flip bridge disabled)
      <valid>    → connect / change (normalize, duplicate-check, upsert)
    """
    # Import late to avoid circular dep with tenants.py.
    from api.routes.tenants import _normalize_phone_e164

    db = request.app.state.db
    _assert_agent_in_tenant(db, agent_id, tenant_id)

    raw = (body.phone or "").strip()
    old_phone = db.get_phone_for_agent(agent_id)

    if not raw:
        # Disconnect path.
        db.set_whatsapp_bridge(agent_id, None)
        db.log_audit(
            tenant_id=tenant_id,
            actor_user_id=ctx.user_id,
            action="agent.whatsapp.disconnect",
            target_type="agent",
            target_id=agent_id,
            metadata={"previous_phone_digits": old_phone},
        )
        return _render_bridges(db, agent_id)

    phone_e164 = _normalize_phone_e164(raw)

    # Duplicate guard — only block when the phone is bound to a
    # DIFFERENT agent. Binding the same number twice to the same agent
    # is a no-op, not an error.
    existing = db.get_agent_for_phone(phone_e164)
    if existing is not None and existing.get("agent_id") != agent_id:
        raise HTTPException(
            status_code=409,
            detail={
                "error": "phone_already_in_use",
                "message": "מספר זה כבר משויך לסוכן אחר",
                "message_en": "This phone is already connected to another agent",
            },
        )

    db.set_whatsapp_bridge(agent_id, phone_e164)
    db.log_audit(
        tenant_id=tenant_id,
        actor_user_id=ctx.user_id,
        action="agent.whatsapp.connect" if old_phone is None else "agent.whatsapp.update",
        target_type="agent",
        target_id=agent_id,
        metadata={"phone": phone_e164, "previous_phone_digits": old_phone},
    )
    return _render_bridges(db, agent_id)


@router.post("/{tenant_id}/agents/{agent_id}/bridges/telegram/connect")
async def connect_telegram_bridge(
    tenant_id: int,
    agent_id: str,
    body: TelegramConnect,
    request: Request,
    ctx: TenantContext = Depends(require_tenant_role("admin")),
) -> dict[str, Any]:
    """Validate a user-provided Telegram bot token, stash it, enable the
    OpenClaw Telegram channel, restart the container.

    Failure modes surface verbatim to the UI so users see real errors:
      - invalid token → {error:"invalid_token", detail:"Unauthorized"}
      - secret write failed → {error:"secret_write_failed", detail:"..."}
      - container restart failed → {error:"restart_failed", detail:"..."}
    """
    import asyncio as _asyncio

    from services import secret_manager, telegram

    db = request.app.state.db
    _assert_agent_in_tenant(db, agent_id, tenant_id)

    token = body.bot_token.strip()
    # 1. Validate via getMe. Runs in a worker thread so the event loop
    #    isn't blocked by the outbound request.
    try:
        bot = await _asyncio.to_thread(telegram.validate_bot_token, token)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail={"error": "invalid_token", "detail": str(exc)},
        ) from exc

    # 2. Persist the token in Secret Manager under the per-agent name.
    secret_name = telegram.secret_name_for(agent_id)
    try:
        await _asyncio.to_thread(secret_manager.upsert_secret, secret_name, token)
    except Exception as exc:  # noqa: BLE001
        logger.exception("secret_manager.upsert_secret failed")
        raise HTTPException(
            status_code=500,
            detail={"error": "secret_write_failed", "detail": str(exc)},
        ) from exc

    # 3. Persist bot identity in DB. We do this BEFORE patching the
    #    container config so if the container restart times out, the
    #    app still knows the bridge is meant to be connected and a
    #    retry from the UI can just re-run the config patch.
    db.upsert_telegram_bridge(
        agent_id,
        bot_username=bot.get("username") or "",
        bot_display_name=bot.get("first_name") or "",
        secret_name=secret_name,
    )

    # 4. Patch agent config + env + restart.
    provisioner = request.app.state.provisioner
    env_var = telegram.env_var_name_for(agent_id)
    patch_result = await _asyncio.to_thread(
        provisioner.patch_agent_config,
        agent_id,
        openclaw_json_patch=telegram.build_enable_patch(env_var),
        env_additions={env_var: token},
        restart=True,
    )
    if not patch_result.get("success"):
        raise HTTPException(
            status_code=502,
            detail={
                "error": "config_patch_failed",
                "detail": patch_result.get("error") or "unknown",
                "stdout": patch_result.get("stdout", "")[-400:],
                "stderr": patch_result.get("stderr", "")[-400:],
            },
        )

    db.log_audit(
        tenant_id=tenant_id,
        actor_user_id=ctx.user_id,
        action="agent.telegram.connect",
        target_type="agent",
        target_id=agent_id,
        metadata={"bot_username": bot.get("username")},
    )
    return _render_bridges(db, agent_id)


@router.post("/{tenant_id}/agents/{agent_id}/bridges/telegram/test")
async def test_telegram_bridge(
    tenant_id: int,
    agent_id: str,
    request: Request,
    ctx: TenantContext = Depends(require_tenant_role("admin")),
) -> dict[str, Any]:
    """Re-run getMe against the stored token. Returns a shape the UI can
    surface either as a success toast or an inline error."""
    import asyncio as _asyncio

    from services import secret_manager, telegram

    db = request.app.state.db
    _assert_agent_in_tenant(db, agent_id, tenant_id)

    rows = db.get_agent_bridges(agent_id)
    tg_row = next((r for r in rows if r["bridge_type"] == "telegram" and r.get("enabled")), None)
    if tg_row is None:
        raise HTTPException(
            status_code=404,
            detail={"error": "not_connected"},
        )

    secret_name = (tg_row.get("config") or {}).get("secret_name") or telegram.secret_name_for(agent_id)
    try:
        token = await _asyncio.to_thread(secret_manager.get_secret, secret_name)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=500,
            detail={"error": "secret_read_failed", "detail": str(exc)},
        ) from exc

    try:
        bot = await _asyncio.to_thread(telegram.validate_bot_token, token)
    except ValueError as exc:
        # Most likely the user regenerated the token in BotFather.
        return {
            "ok": False,
            "error": "token_invalid",
            "detail": str(exc),
        }

    return {
        "ok": True,
        "bot_id": bot.get("id"),
        "bot_username": bot.get("username"),
        "bot_display_name": bot.get("first_name"),
    }


@router.post("/{tenant_id}/agents/{agent_id}/bridges/telegram/start-managed")
async def start_telegram_managed_connect(
    tenant_id: int,
    agent_id: str,
    request: Request,
    ctx: TenantContext = Depends(require_tenant_role("admin")),
) -> dict[str, Any]:
    """Kick off the one-tap "Quick connect" flow via @AgentikoManagerBot.

    Returns a signed deep-link URL the frontend renders both as a button
    and as a QR code. The token is short-lived (~15 min) and ties to
    (tenant, agent, user), so another member of the same tenant can't
    hijack the in-progress flow. The actual bot creation completes via
    the webhook when Telegram delivers `managed_bot` — the frontend
    polls `managed-status` to flip the UI.
    """
    import os

    from services import telegram_deeplink, telegram_manager

    db = request.app.state.db
    _assert_agent_in_tenant(db, agent_id, tenant_id)

    token = telegram_deeplink.issue(
        tenant_id=tenant_id,
        agent_id=agent_id,
        user_id=ctx.user_id,
    )

    # Look up the manager bot's username so we can build a clickable URL.
    # Cached in-process after the first call via getMe; the call is
    # cheap and correctness-critical (wrong username → dead link).
    try:
        me = telegram_manager.get_me()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=503,
            detail={
                "error": "manager_bot_unavailable",
                "detail": str(exc),
            },
        ) from exc
    manager_username = (me or {}).get("username") or os.environ.get(
        "APP_TELEGRAM_MANAGER_USERNAME", "AgentikoManagerBot"
    )

    deep_link = f"https://t.me/{manager_username}?start={token}"
    return {
        "deep_link": deep_link,
        "manager_bot_username": manager_username,
        # Echoed to the frontend so the status poller knows what to wait on.
        "agent_id": agent_id,
        # Same TTL as the token itself — frontend uses this to stop
        # polling and show "try again" once expired.
        "expires_in_seconds": 15 * 60,
    }


@router.get("/{tenant_id}/agents/{agent_id}/bridges/telegram/managed-status")
async def get_telegram_managed_status(
    tenant_id: int,
    agent_id: str,
    request: Request,
    ctx: TenantContext = Depends(require_tenant_role("admin")),
) -> dict[str, Any]:
    """Polled by the frontend while the user is in Telegram completing
    the Managed Bots flow. Returns one of:

      {status: "pending"}                         — still waiting
      {status: "connected", bot_username: "..."}  — done, UI can close
      {status: "error", error: "..."}             — something failed

    The webhook writes the end state into agent_bridges.config; we
    just read it here.
    """
    db = request.app.state.db
    _assert_agent_in_tenant(db, agent_id, tenant_id)
    rows = db.get_agent_bridges(agent_id)
    tg = next((r for r in rows if r["bridge_type"] == "telegram"), None)
    if tg is None:
        return {"status": "pending"}
    cfg = tg.get("config") or {}
    if tg.get("enabled") and cfg.get("bot_username"):
        return {"status": "connected", "bot_username": cfg.get("bot_username")}
    if cfg.get("managed_error"):
        return {"status": "error", "error": cfg.get("managed_error")}
    if cfg.get("managed_pending"):
        return {"status": "pending"}
    return {"status": "pending"}


@router.delete("/{tenant_id}/agents/{agent_id}/bridges/telegram")
async def disconnect_telegram_bridge(
    tenant_id: int,
    agent_id: str,
    request: Request,
    ctx: TenantContext = Depends(require_tenant_role("admin")),
) -> dict[str, Any]:
    """Reverse of connect: disable the OpenClaw channel, purge the
    Secret Manager secret, flip the DB row to disabled. Idempotent —
    calling on an already-disconnected bridge is a 200 with no changes."""
    import asyncio as _asyncio

    from services import secret_manager, telegram

    db = request.app.state.db
    _assert_agent_in_tenant(db, agent_id, tenant_id)

    previous = db.disconnect_telegram_bridge(agent_id)
    if previous is None:
        # Already gone; still normalize the container config just in case
        # an old leftover enabled-flag is sitting in openclaw.json.
        return _render_bridges(db, agent_id)

    # Best-effort: patch the container config to disable the channel,
    # then delete the secret. We do config first so a failure there
    # doesn't leave the agent polling Telegram with a deleted token
    # (which would just error loudly in OpenClaw logs).
    provisioner = request.app.state.provisioner
    patch_result = await _asyncio.to_thread(
        provisioner.patch_agent_config,
        agent_id,
        openclaw_json_patch=telegram.build_disable_patch(),
        restart=True,
    )
    if not patch_result.get("success"):
        # Log + surface but don't roll back the DB state — from the
        # tenant's perspective the bridge IS disconnected (we dropped
        # the DB flag). The container will catch up on next restart.
        logger.warning(
            "telegram disconnect: config/patch failed agent=%s detail=%s",
            agent_id,
            patch_result.get("error"),
        )

    secret_name = (previous.get("config") or {}).get("secret_name") or telegram.secret_name_for(agent_id)
    try:
        await _asyncio.to_thread(secret_manager.delete_secret, secret_name)
    except Exception:  # noqa: BLE001
        logger.warning("telegram disconnect: secret delete failed", exc_info=True)

    db.log_audit(
        tenant_id=tenant_id,
        actor_user_id=ctx.user_id,
        action="agent.telegram.disconnect",
        target_type="agent",
        target_id=agent_id,
        metadata={"bot_username": (previous.get("config") or {}).get("bot_username")},
    )
    return _render_bridges(db, agent_id)
