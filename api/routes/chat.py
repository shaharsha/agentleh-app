"""Web-chat WebSocket route.

  WS /api/tenants/{tenant_id}/agents/{agent_id}/chat

Auth flow
─────────
Browsers can't set `Authorization` headers on WebSocket handshakes
cleanly, so we accept the Supabase JWT as a `?access_token=...` query
parameter. This is the standard workaround. HTTPS + short-lived JWT
(Supabase expiry is ~1h) means the exposure window is acceptable, and
we explicitly log the `agent.webchat.session` audit event so a misuse
is traceable.

Tenant scoping
──────────────
  - JWT must validate against the configured Supabase project.
  - The user must be a `member`+ of `tenant_id` (we return 1008 policy
    violation + close on failure so enumeration attempts don't leak).
  - `agent_id` must belong to `tenant_id`.

Session key
───────────
  - `webchat-u<user_id>-a<agent_id>` — deterministic per (user, agent),
    so each tenant member gets their own history with each agent.
    The proxy rewrites any sessionKey the browser tries to send so the
    value can't be forged.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from fastapi import APIRouter, Query, Request, WebSocket, WebSocketDisconnect, status

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/tenants", tags=["chat"])


async def _validate_jwt_and_user(app, token: str) -> dict[str, Any] | None:
    """Verify a Supabase JWT + return the matching app_users row.

    The normal `get_current_user` dep reads from the Authorization
    header; WebSockets can't reliably set that header so we accept the
    token via query string and verify it directly here.
    """
    from api.auth import decode_supabase_jwt

    try:
        claims = decode_supabase_jwt(token)
    except Exception as exc:  # noqa: BLE001
        logger.info("webchat: JWT verify failed: %s", exc)
        return None
    supabase_uid = claims.get("sub")
    email = claims.get("email") or ""
    if not supabase_uid:
        return None
    db = app.state.db
    user = db.get_user_for_auth(supabase_uid, email, "")
    return user


@router.websocket("/{tenant_id}/agents/{agent_id}/chat")
async def chat_websocket(
    websocket: WebSocket,
    tenant_id: int,
    agent_id: str,
    access_token: str = Query("", alias="access_token"),
) -> None:
    await websocket.accept()

    # The policy-violation close code (1008) is what WebSocket clients
    # use to detect auth failures and avoid auto-reconnect loops.
    async def _deny(reason: str) -> None:
        try:
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason=reason)
        except Exception:  # noqa: BLE001
            pass

    if not access_token:
        await _deny("missing_access_token")
        return

    user = await _validate_jwt_and_user(websocket.app, access_token)  # type: ignore[arg-type]
    if not user:
        await _deny("unauthorized")
        return
    if user.get("deleted_at") is not None:
        await _deny("revoked")
        return

    db = websocket.app.state.db

    # Tenant membership check — 1008 instead of 404 because we're
    # already past handshake and the client understands close codes.
    membership = db.get_tenant_membership(tenant_id, user["id"])
    if membership is None:
        await _deny("not_a_tenant_member")
        return

    # Cross-tenant agent guard.
    if db.get_agent_tenant_id(agent_id) != tenant_id:
        await _deny("agent_not_in_tenant")
        return

    # Fetch gateway URL + token. Both are needed to open the backend
    # connection to the agent.
    row = db._fetch_one(
        "SELECT gateway_url, gateway_token FROM agents "
        "WHERE agent_id = %s AND deleted_at IS NULL",
        (agent_id,),
    )
    if row is None or not row.get("gateway_url") or not row.get("gateway_token"):
        await _deny("agent_not_ready")
        return

    # Web chat operates in the agent's MAIN conversation — same thread
    # as WhatsApp and (soon) Telegram — so tenant admins see the live
    # customer conversation and can interject if needed. Matches the
    # agent's default session.dmScope = "main" in openclaw.json.
    #
    # Multi-admin + cross-surface interactions are intentional here:
    # all tenant members share one view of the agent's single
    # conversation. If we later need per-user sandboxes (e.g. for
    # training/testing), that's a second mode — the sessionKey string
    # is the only thing that changes, everything downstream is the
    # same shape.
    session_key = "main"
    started_at = time.time()
    logger.info(
        "webchat: session start user=%s tenant=%s agent=%s session_key=%s",
        user["id"], tenant_id, agent_id, session_key,
    )

    def _audit_close() -> None:
        duration_ms = int((time.time() - started_at) * 1000)
        db.log_audit(
            tenant_id=tenant_id,
            actor_user_id=user["id"],
            action="agent.webchat.session",
            target_type="agent",
            target_id=agent_id,
            metadata={
                "session_key": session_key,
                "duration_ms": duration_ms,
            },
        )

    # Import the proxy driver late so the module-level import graph
    # doesn't drag in websockets/cryptography for request paths that
    # don't need them.
    from services import chat_proxy

    try:
        await chat_proxy.run_chat_proxy(
            websocket,
            gateway_url=row["gateway_url"],
            gateway_token=row["gateway_token"],
            session_key=session_key,
            on_close=_audit_close,
        )
    except WebSocketDisconnect:
        _audit_close()
    except Exception as exc:  # noqa: BLE001
        logger.exception("webchat proxy errored for agent=%s", agent_id)
        try:
            await websocket.close(code=status.WS_1011_INTERNAL_ERROR, reason=str(exc)[:80])
        except Exception:  # noqa: BLE001
            pass
        _audit_close()
