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
    revoke_google_credentials,
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


def _default_return_to() -> str:
    """Where to redirect the user after a successful app-UI connect. The
    app-public URL is injected via env (``APP_PUBLIC_URL``); we append
    ``/dashboard`` so the integrations panel is visible when the user
    comes back."""
    base = os.environ.get("APP_PUBLIC_URL", "").rstrip("/")
    if not base:
        raise HTTPException(
            status_code=500,
            detail={"error": "app_public_url_not_set"},
        )
    return f"{base}/dashboard"


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
    return {
        "agent_id": agent_id,
        "tenant_id": tenant_id,
        "integrations": {
            "google": _build_google_entry(google_row),
        },
    }


# ─────────────────────────────────────────────────────────────────────────
# POST — start Google connect flow (admin+)
# ─────────────────────────────────────────────────────────────────────────


class GoogleConnectRequest(BaseModel):
    """Body for the app-UI connect-start route.

    ``login_hint`` is optional and purely a UX nicety: when provided,
    Google's consent screen skips the account picker and pre-selects
    that account. Users with multiple Google accounts can use the
    frontend's 'Advanced' disclosure to provide it.
    """

    login_hint: str | None = Field(default=None, max_length=320)


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

    return_to = _default_return_to()

    try:
        token = google_oauth.mint_connect_jwt(
            agent_id,
            redirect_to=return_to,
            login_hint=(body.login_hint or None),
        )
    except InvalidRedirectError as exc:
        # This would only fire if someone misconfigured APP_PUBLIC_URL
        # to a non-allowlisted host. Surface it as a 500 so it's loud.
        logger.error("start_google_connect: invalid redirect_to: %s", exc)
        raise HTTPException(
            status_code=500,
            detail={"error": "invalid_redirect_config"},
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
        result = await revoke_google_credentials(agent_id=agent_id)
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
