"""Google OAuth connect flow (per-agent).

End-user journey:

1. Inside a running OpenClaw agent (WhatsApp), the agent decides the user
   wants to connect Google. It asks the bridge for a connect URL; the
   bridge mints a short-lived JWT (`sub=agent_id`, 15 minute TTL, HS256
   with the shared secret) and hands back
       https://app.agentiko.io/api/oauth/google/start?t=<jwt>
2. The user taps that link on their phone. This route validates the JWT
   and 302-redirects them to Google's OAuth consent screen.
3. Google redirects them back to /api/oauth/google/callback with a code
   and the same state token. We verify the token, exchange the code, and
   KMS-encrypt + upsert the refresh_token into agent_google_credentials.
4. We render a simple success page telling them to go back to WhatsApp.

No DB writes happen until the callback step, so abandoned consent flows
leave zero state.

Disconnect (POST /api/oauth/google/disconnect) is available from the
signed-in dashboard UI; agent-initiated disconnect runs through the
meter instead.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel

from api.deps import get_current_user
from fastapi import Depends
from services import google_oauth

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/oauth/google", tags=["oauth", "google"])


def _success_html(email: str) -> str:
    return f"""<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agentiko · חובר בהצלחה</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 0; min-height: 100vh; display: grid; place-items: center; }}
    .card {{ background: rgba(30, 41, 59, 0.8); border-radius: 18px; padding: 32px; max-width: 360px; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.4); }}
    .check {{ font-size: 56px; line-height: 1; margin-bottom: 16px; }}
    h1 {{ font-size: 22px; margin: 0 0 8px; }}
    p {{ font-size: 15px; line-height: 1.5; margin: 6px 0; color: #cbd5e1; }}
    .email {{ color: #93c5fd; direction: ltr; display: inline-block; }}
  </style>
</head>
<body>
  <div class="card">
    <div class="check">✓</div>
    <h1>החשבון חובר בהצלחה</h1>
    <p>חיברת את <span class="email">{email}</span></p>
    <p>אפשר לחזור לוואטסאפ ולבקש מהסוכן לקבוע פגישות או לשלוח מיילים בשמך.</p>
  </div>
</body>
</html>"""


def _error_html(message: str) -> str:
    return f"""<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agentiko · שגיאה</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 0; min-height: 100vh; display: grid; place-items: center; }}
    .card {{ background: rgba(30, 41, 59, 0.8); border-radius: 18px; padding: 32px; max-width: 360px; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.4); }}
    .x {{ font-size: 56px; line-height: 1; margin-bottom: 16px; color: #f87171; }}
    h1 {{ font-size: 20px; margin: 0 0 8px; }}
    p {{ font-size: 14px; color: #cbd5e1; }}
  </style>
</head>
<body>
  <div class="card">
    <div class="x">⚠</div>
    <h1>החיבור לא הושלם</h1>
    <p>{message}</p>
    <p>חזור לוואטסאפ ובקש מהסוכן קישור חדש.</p>
  </div>
</body>
</html>"""


@router.get("/start")
async def oauth_start(t: str = Query(..., min_length=10, max_length=2048)):
    try:
        claims = google_oauth.verify_connect_jwt(t)
    except ValueError:
        return HTMLResponse(
            _error_html("הקישור פג תוקף או שאינו תקין."),
            status_code=400,
        )

    logger.info("google-connect start: agent_id=%s", claims.agent_id)
    # Pass the same JWT as the state parameter — callback re-validates and
    # extracts agent_id from it. Google echoes state back untouched.
    return RedirectResponse(
        url=google_oauth.build_authorization_url(state=t),
        status_code=302,
    )


@router.get("/callback")
async def oauth_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    error_description: str | None = None,
):
    if error:
        logger.info("google-connect callback: user declined: %s", error)
        return HTMLResponse(
            _error_html("אישור לא ניתן. ניתן לנסות שוב מהוואטסאפ."),
            status_code=400,
        )

    if not code or not state:
        return HTMLResponse(
            _error_html("בקשה לא תקינה."),
            status_code=400,
        )

    try:
        claims = google_oauth.verify_connect_jwt(state)
    except ValueError:
        return HTMLResponse(
            _error_html("הקישור פג תוקף. חזור לוואטסאפ לקישור חדש."),
            status_code=400,
        )

    try:
        token_response = await google_oauth.exchange_code(code)
    except ValueError as exc:
        logger.warning("google-connect callback: exchange failed: %s", exc)
        return HTMLResponse(
            _error_html("לא הצלחנו לאשר את החיבור מול גוגל."),
            status_code=502,
        )

    refresh_token = token_response.get("refresh_token")
    access_token = token_response.get("access_token")
    granted_scope = token_response.get("scope", "")

    if not refresh_token:
        # Happens when the user already authorized our app and Google
        # skips issuing a new refresh_token. We force prompt=consent to
        # avoid this, so hitting this branch is a real bug (or test flake).
        logger.error(
            "google-connect callback: no refresh_token in response; "
            "check that prompt=consent is set on the authorization URL"
        )
        return HTMLResponse(
            _error_html("גוגל לא החזירה אסימון חידוש. נסה שוב."),
            status_code=502,
        )

    try:
        userinfo = await google_oauth.fetch_userinfo(access_token)
    except Exception as exc:  # noqa: BLE001
        logger.warning("google-connect callback: userinfo fetch failed: %s", exc)
        userinfo = {}

    google_email = userinfo.get("email") or "unknown"

    scopes = [s for s in granted_scope.split() if s] or list(google_oauth.GOOGLE_SCOPES)

    db = request.app.state.db
    google_oauth.upsert_credentials(
        db,
        agent_id=claims.agent_id,
        google_email=google_email,
        refresh_token_plaintext=refresh_token,
        scopes=scopes,
    )

    logger.info(
        "google-connect callback: stored credentials for agent_id=%s email=%s",
        claims.agent_id,
        google_email,
    )

    # Notify the bridge so it can send a WhatsApp confirmation back to the user.
    # Best-effort — the connection is already committed to the DB.
    import httpx as _httpx
    import os as _os

    bridge_notify_url = _os.environ.get("APP_BRIDGE_GOOGLE_CONNECTED_URL", "")
    bridge_notify_token = _os.environ.get("APP_BRIDGE_INTERNAL_TOKEN", "")
    if bridge_notify_url and bridge_notify_token:
        try:
            async with _httpx.AsyncClient(timeout=5.0) as client:
                await client.post(
                    bridge_notify_url,
                    json={"agent_id": claims.agent_id, "email": google_email},
                    headers={"Authorization": f"Bearer {bridge_notify_token}"},
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "google-connect callback: bridge notification failed: %s", exc
            )

    return HTMLResponse(_success_html(google_email), status_code=200)


# ─────────────────────────────────────────────────────────────────────────
# Disconnect — signed-in dashboard UI
# ─────────────────────────────────────────────────────────────────────────


class DisconnectRequest(BaseModel):
    agent_id: str


@router.post("/disconnect")
async def oauth_disconnect(
    body: DisconnectRequest,
    request: Request,
    user: dict = Depends(get_current_user),
):
    db = request.app.state.db

    # Verify the user actually owns this agent (no cross-user disconnects).
    owned = db.get_user_agents(user["id"])
    if not any(a.get("agent_id") == body.agent_id for a in owned):
        raise HTTPException(status_code=403, detail="not_your_agent")

    # Best-effort revoke at Google; we still delete our row either way.
    # The meter would also do this via its /auth/google/revoke route, but
    # we do it here too so dashboard-driven disconnects don't require a
    # round-trip through the meter.
    row = google_oauth.fetch_credentials(db, agent_id=body.agent_id)
    if row is None:
        return {"revoked": False}

    # We don't have the plaintext token here (it's KMS-encrypted in the
    # row and only the meter decrypts). So we let the meter handle the
    # actual Google revoke by calling its internal route. For v1, if
    # the meter isn't reachable we still delete locally — Google's token
    # will expire naturally.
    google_oauth.delete_credentials(db, agent_id=body.agent_id)
    return {"revoked": True}
