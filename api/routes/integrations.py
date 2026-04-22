"""Per-agent integrations router — the dashboard's control plane for
connecting/disconnecting external services (Google today; Notion/Slack/…
later if needed).

Three routes:

- ``GET  /tenants/{tenant_id}/agents/{agent_id}/integrations``
    — member+ — returns a dict of integrations with connection status +
      human-readable capability list. Used by the dashboard's
      ``IntegrationsPanel`` to render state.

- ``POST /tenants/{tenant_id}/agents/{agent_id}/integrations/google/connect``
    — admin+ — mints a short-lived JWT (with a ``redirect_to`` back to
      the dashboard) and returns the Google authorization URL for the
      frontend to navigate to. Connect/disconnect are admin-gated because
      they change what Google identity the shared agent is pretending to
      be — too destructive for a plain member.

- ``DELETE /tenants/{tenant_id}/agents/{agent_id}/integrations/google``
    — admin+ — proxies to the meter's ``/admin/google/revoke`` admin
      route. Single code path for disconnect across both UIs (WhatsApp
      plugin also hits the meter, just via the per-agent ``x-agentleh-key``
      path).

All routes independently verify that ``agent_id`` actually belongs to
``tenant_id`` so an admin of tenant A can't touch tenant B's agent by
guessing its id.

See ``.claude/plans/enumerated-sprouting-reef.md`` (Phase 2) for the
dual-entry-point design.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from api.deps import TenantContext, require_tenant_role
from services import google_oauth
from services.google_oauth import InvalidRedirectError
from services.meter_client import (
    MeterClientError,
    revoke_nylas_credentials,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["integrations"])


# ─────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────


def _assert_agent_in_tenant(db, *, tenant_id: int, agent_id: str) -> None:
    """Verify the agent exists AND belongs to this tenant. 404 otherwise
    so we don't leak agent existence across tenant boundaries."""
    row = db.get_agent_details(agent_id)
    if row is None or row.get("tenant_id") != tenant_id:
        raise HTTPException(
            status_code=404,
            detail={"error": "agent_not_in_tenant", "agent_id": agent_id},
        )


_TELEGRAM_BOT_USERNAME = os.environ.get("APP_TELEGRAM_BOT_USERNAME", "")


def _build_telegram_entry(row: dict[str, Any] | None) -> dict[str, Any]:
    """Build the Telegram integration status block for the integrations panel.

    ``row`` is {agent_id, linked_count} from db.get_telegram_status(), or
    None if the query failed. ``linked_count`` is the number of Telegram
    users that have sent /start to this agent.
    """
    bot_configured = bool(_TELEGRAM_BOT_USERNAME)
    linked_count = int((row or {}).get("linked_count", 0))
    return {
        "name": "Telegram",
        "configured": bot_configured,
        "linked_count": linked_count,
        # Deep-link the user can share: clicking opens Telegram and sends
        # /start {agent_id} to the bot, which the bridge intercepts to
        # register the (telegram, chat_id) → agent route.
        "deeplink": (
            f"https://t.me/{_TELEGRAM_BOT_USERNAME}?start={{agent_id}}"
            if bot_configured
            else None
        ),
        "bot_username": _TELEGRAM_BOT_USERNAME or None,
    }


def _build_google_entry(row: dict[str, Any] | None) -> dict[str, Any]:
    if row is None:
        return {
            "name": "Google Calendar + Gmail",
            "connected": False,
        }

    scopes = list(row.get("scopes") or [])
    capabilities = google_oauth.scopes_to_capabilities(scopes)
    return {
        "name": "Google Calendar + Gmail",
        "connected": True,
        "email": row.get("google_email"),
        "scopes": scopes,
        "capabilities": capabilities,
        "granted_at": row["granted_at"].isoformat() if row.get("granted_at") else None,
        "last_refreshed_at": (
            row["last_refreshed_at"].isoformat()
            if row.get("last_refreshed_at")
            else None
        ),
    }


def _return_to_for_tenant(tenant_id: int) -> str:
    """Where to redirect the user after a successful app-UI connect.

    We land them back on their tenant workspace page — that's where the
    integrations panel is rendered — with a query param the page's
    ``useEffect`` watcher picks up to show a success toast and refetch.
    """
    base = os.environ.get("APP_PUBLIC_URL", "").rstrip("/")
    if not base:
        raise HTTPException(
            status_code=500,
            detail={"error": "app_public_url_not_set"},
        )
    return f"{base}/tenants/{tenant_id}"


# ─────────────────────────────────────────────────────────────────────────
# GET — list integrations (member+)
# ─────────────────────────────────────────────────────────────────────────


@router.get("/tenants/{tenant_id}/agents/{agent_id}/integrations")
async def list_integrations(
    tenant_id: int,
    agent_id: str,
    request: Request,
    ctx: TenantContext = Depends(require_tenant_role("member")),
) -> dict[str, Any]:
    db = request.app.state.db
    _assert_agent_in_tenant(db, tenant_id=tenant_id, agent_id=agent_id)

    google_row = google_oauth.fetch_credentials(db, agent_id=agent_id)
    telegram_row = db.get_telegram_status(agent_id=agent_id)
    return {
        "agent_id": agent_id,
        "tenant_id": tenant_id,
        "integrations": {
            "google": _build_google_entry(google_row),
            "telegram": _build_telegram_entry(telegram_row),
        },
    }


# ─────────────────────────────────────────────────────────────────────────
# POST — start Google connect flow (admin+)
# ─────────────────────────────────────────────────────────────────────────


class GoogleConnectRequest(BaseModel):
    """Body for the app-UI connect-start route.

    ``login_hint`` is optional and purely a UX nicety: when provided,
    Google's consent screen skips the account picker and pre-selects
    that account.

    ``capabilities`` is an optional list of capability keys from
    ``GOOGLE_CAPABILITY_TO_SCOPES`` (``calendar`` / ``email``). When
    omitted or empty, all capabilities are requested. The checkbox UI
    in the IntegrationsPanel populates this; unselected keys are
    excluded before the Google consent screen even sees them.
    """

    login_hint: str | None = Field(default=None, max_length=320)
    capabilities: list[str] | None = Field(default=None, max_length=10)


@router.post("/tenants/{tenant_id}/agents/{agent_id}/integrations/google/connect")
async def start_google_connect(
    tenant_id: int,
    agent_id: str,
    body: GoogleConnectRequest,
    request: Request,
    ctx: TenantContext = Depends(require_tenant_role("admin")),
) -> dict[str, Any]:
    db = request.app.state.db
    _assert_agent_in_tenant(db, tenant_id=tenant_id, agent_id=agent_id)

    return_to = _return_to_for_tenant(tenant_id)

    try:
        token = google_oauth.mint_connect_jwt(
            agent_id,
            redirect_to=return_to,
            login_hint=(body.login_hint or None),
            capabilities=(body.capabilities or None),
        )
    except InvalidRedirectError as exc:
        # This would only fire if someone misconfigured APP_PUBLIC_URL
        # to a non-allowlisted host. Surface it as a 500 so it's loud.
        logger.error("start_google_connect: invalid redirect_to: %s", exc)
        raise HTTPException(
            status_code=500,
            detail={"error": "invalid_redirect_config"},
        )
    except ValueError as exc:
        # Unknown capability key — frontend sent an invalid selection.
        # 400 with the specific message so it surfaces nicely in the panel.
        logger.warning("start_google_connect: invalid capability: %s", exc)
        raise HTTPException(
            status_code=400,
            detail={"error": "invalid_capability", "message": str(exc)},
        )

    base = os.environ.get("APP_PUBLIC_URL", "").rstrip("/")
    connect_url = f"{base}/api/oauth/google/start?t={token}"

    logger.info(
        "start_google_connect: tenant_id=%s agent_id=%s user_id=%s has_hint=%s",
        tenant_id,
        agent_id,
        ctx.user_id,
        bool(body.login_hint),
    )
    # expires_in_seconds matches _JWT_TTL_SECONDS in services.google_oauth
    return {
        "connect_url": connect_url,
        "expires_in_seconds": 15 * 60,
    }


# ─────────────────────────────────────────────────────────────────────────
# DELETE — disconnect Google (admin+)
# ─────────────────────────────────────────────────────────────────────────


@router.delete("/tenants/{tenant_id}/agents/{agent_id}/integrations/google")
async def disconnect_google(
    tenant_id: int,
    agent_id: str,
    request: Request,
    ctx: TenantContext = Depends(require_tenant_role("admin")),
) -> dict[str, Any]:
    db = request.app.state.db
    _assert_agent_in_tenant(db, tenant_id=tenant_id, agent_id=agent_id)

    try:
        result = await revoke_nylas_credentials(agent_id=agent_id)
    except MeterClientError as exc:
        logger.error(
            "disconnect_google: meter revoke failed for agent_id=%s: %s",
            agent_id,
            exc,
        )
        # Surface as 502 — the row might still be present on our side
        # but the user sees "something went wrong, try again".
        raise HTTPException(
            status_code=502,
            detail={"error": "meter_unreachable"},
        )

    logger.info(
        "disconnect_google: tenant_id=%s agent_id=%s user_id=%s revoked=%s",
        tenant_id,
        agent_id,
        ctx.user_id,
        result.get("revoked"),
    )
    return {
        "revoked": bool(result.get("revoked")),
        "email": result.get("email"),
    }
