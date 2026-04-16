"""Google OAuth connect flow (per-agent).

Two entry points converge here via the same JWT/aud:

1. **WhatsApp path** — the OpenClaw agent mints a JWT (no ``redirect_to``)
   via its ``google_get_connect_url`` tool, sends the URL to the user in
   WhatsApp, user taps it, lands on ``/start``, is redirected to Google's
   consent screen, approves, and comes back to ``/callback``. Post-consent
   we render an inline Hebrew success HTML page because the user is in
   a standalone browser tab with no dashboard context.

2. **App UI path** — the logged-in user clicks "חבר חשבון גוגל" in the
   dashboard's integrations panel. The app's
   ``POST /api/tenants/{t}/agents/{a}/integrations/google/connect`` route
   (see ``api/routes/integrations.py``) mints a JWT with
   ``redirect_to=<APP_PUBLIC_URL>/dashboard?google=connected`` and hands
   the URL to the frontend, which navigates the same tab to it. Same
   ``/start`` → Google → ``/callback`` flow; post-consent we 302-redirect
   back to the dashboard instead of rendering HTML.

The callback body is shared between the two flows and branches only on
``claims.redirect_to``.

**Writes go through the meter.** The callback does NOT touch
``agent_google_credentials`` directly — it POSTs the plaintext refresh
token to the meter's ``/admin/google/store`` admin route (see
``services/meter_client.py``). The meter KMS-encrypts, UPSERTs, and
purges its in-memory access-token cache atomically. The app service has
no KMS access and no direct write path, which fixes the stale-cache bug
that would otherwise bite when reconnecting with a different Google
account.

No DB writes happen until the callback step, so abandoned consent flows
leave zero state.
"""

from __future__ import annotations

import logging
from urllib.parse import urlencode, urlparse, urlunparse

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel, Field

from services import google_oauth, shortlink
from services.google_oauth import InvalidRedirectError
from services.meter_client import MeterClientError, store_nylas_credentials

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


def _append_query(url: str, key: str, value: str) -> str:
    """Append (or replace) a query param on a redirect URL.

    Used to tack on ``google=connected`` / ``google=denied`` etc. to the
    dashboard redirect URL so the frontend can show the right toast.
    """
    parsed = urlparse(url)
    existing = parsed.query
    new_qs = f"{existing}&{key}={value}" if existing else f"{key}={value}"
    return urlunparse(parsed._replace(query=new_qs))


def _redirect_or_html_error(
    claims_redirect_to: str | None, html_message: str, status_code: int, error_key: str
):
    """Branch: if the JWT had a ``redirect_to``, send the user back there
    with ``?google=<error_key>``; otherwise render the inline Hebrew
    error page (WhatsApp flow default).
    """
    if claims_redirect_to:
        return RedirectResponse(
            _append_query(claims_redirect_to, "google", error_key),
            status_code=302,
        )
    return HTMLResponse(_error_html(html_message), status_code=status_code)


@router.get("/start")
async def oauth_start(t: str = Query(..., min_length=10, max_length=2048)):
    try:
        claims = google_oauth.verify_connect_jwt(t)
    except InvalidRedirectError:
        return HTMLResponse(
            _error_html("הקישור אינו תקין (redirect לא מורשה)."),
            status_code=400,
        )
    except ValueError:
        return HTMLResponse(
            _error_html("הקישור פג תוקף או שאינו תקין."),
            status_code=400,
        )

    # Resolve the capability claim (if any) into a concrete OAuth scope
    # list. If the JWT has no caps claim, fall back to the full v1 set
    # for backwards-compat — existing plugin builds that don't know
    # about capabilities keep working.
    try:
        scope_list = google_oauth.capabilities_to_scope_list(claims.capabilities)
    except ValueError:
        return HTMLResponse(
            _error_html("הקישור פג תוקף או שאינו תקין."),
            status_code=400,
        )

    logger.info(
        "google-connect start: agent_id=%s has_redirect=%s has_hint=%s caps=%s",
        claims.agent_id,
        bool(claims.redirect_to),
        bool(claims.login_hint),
        claims.capabilities or "all",
    )
    # Pass the same JWT as the state parameter — callback re-validates
    # and extracts agent_id + redirect_to from it. Google echoes state
    # back untouched.
    return RedirectResponse(
        url=google_oauth.build_authorization_url(
            state=t,
            login_hint=claims.login_hint,
            scopes=scope_list,
        ),
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
    # Parse state first so we know whether to redirect-mode or HTML-mode
    # on any subsequent error. If state itself is unparseable we fall back
    # to HTML because we have nowhere else to send them.
    claims = None
    if state:
        try:
            claims = google_oauth.verify_connect_jwt(state)
        except (ValueError, InvalidRedirectError):
            claims = None

    claims_redirect_to = claims.redirect_to if claims else None

    if error:
        logger.info("google-connect callback: user declined: %s", error)
        return _redirect_or_html_error(
            claims_redirect_to,
            "אישור לא ניתן. ניתן לנסות שוב מהוואטסאפ.",
            400,
            "denied",
        )

    if not code or not state:
        return _redirect_or_html_error(
            claims_redirect_to, "בקשה לא תקינה.", 400, "error"
        )

    if claims is None:
        # state existed but didn't parse — we can't route back even if
        # the user might have expected a redirect.
        return HTMLResponse(
            _error_html("הקישור פג תוקף. בקש קישור חדש."),
            status_code=400,
        )

    try:
        nylas_response = await google_oauth.exchange_code(code)
    except ValueError as exc:
        logger.warning("nylas-connect callback: exchange failed: %s", exc)
        return _redirect_or_html_error(
            claims_redirect_to,
            "לא הצלחנו לאשר את החיבור מול גוגל.",
            502,
            "error",
        )

    grant_id = nylas_response.get("grant_id")
    email = nylas_response.get("email") or "unknown"
    granted_scope = nylas_response.get("scope", "")

    if not grant_id:
        logger.error(
            "nylas-connect callback: no grant_id in response: %s",
            {k: v for k, v in nylas_response.items() if k != "access_token"},
        )
        return _redirect_or_html_error(
            claims_redirect_to,
            "Nylas לא החזירה מזהה חיבור. נסה שוב.",
            502,
            "error",
        )

    scopes = [s for s in granted_scope.split() if s] or list(google_oauth.GOOGLE_SCOPES)
    capabilities = list(claims.capabilities) if claims.capabilities else list(google_oauth.ALL_CAPABILITIES)

    # Store the grant_id in the meter. No KMS, no encryption — the
    # grant_id is useless without the Nylas API key (held only by the
    # meter in Secret Manager).
    try:
        await store_nylas_credentials(
            agent_id=claims.agent_id,
            grant_id=grant_id,
            email=email,
            scopes=scopes,
            capabilities=capabilities,
        )
    except MeterClientError as exc:
        logger.error(
            "nylas-connect callback: meter store failed for agent_id=%s: %s",
            claims.agent_id,
            exc,
        )
        return _redirect_or_html_error(
            claims_redirect_to,
            "לא הצלחנו לשמור את החיבור. נסה שוב.",
            502,
            "error",
        )

    logger.info(
        "nylas-connect callback: stored grant for agent_id=%s email=%s grant_id=%s",
        claims.agent_id,
        email,
        grant_id[:8] + "...",
    )

    # Success. Branch on whether the JWT asked for a redirect back to an
    # allowlisted URL (app UI path) or the inline HTML page (WhatsApp path).
    if claims_redirect_to:
        return RedirectResponse(
            _append_query(claims_redirect_to, "google", "connected"),
            status_code=302,
        )
    return HTMLResponse(_success_html(email), status_code=200)


# ─────────────────────────────────────────────────────────────────────────
# Shortlink POST endpoint (JWT-authed by the JWT itself)
#
# The OpenClaw plugin calls this right after minting a connect JWT. It
# hands us the JWT, we re-verify it with the same secret we'd use on
# /start, create a short code that maps to the full /start URL, and
# return the short URL. The plugin then sends the SHORT URL to the user
# in WhatsApp instead of the ~450-char raw JWT URL.
#
# Auth: the JWT itself. We already validate aud, signature, and expiry
# in verify_connect_jwt — that's enough. No admin bearer, no extra
# header. The endpoint is public but only creates a shortlink for a
# JWT that's already valid, so the only thing an attacker with no
# JWT can do is hit it with garbage and get 400.
# ─────────────────────────────────────────────────────────────────────────


class ShortlinkRequest(BaseModel):
    """Body for POST /api/oauth/google/shortlink. ``t`` is the full JWT
    that would otherwise land in the query string of the /start URL."""

    t: str = Field(..., min_length=10, max_length=4096)


@router.post("/shortlink")
async def create_shortlink(
    body: ShortlinkRequest,
    request: Request,
) -> dict:
    # Validate the JWT first — same audience/signature check as /start.
    # If the JWT is bad, we refuse to shorten it (don't want to persist
    # state for garbage inputs).
    try:
        google_oauth.verify_connect_jwt(body.t)
    except (ValueError, InvalidRedirectError):
        raise HTTPException(
            status_code=400,
            detail={"error": "invalid_state_token"},
        )

    # Build the full /start URL. We don't accept a prebuilt long_url
    # from the caller — it's derived from the JWT alone, so there's no
    # open-redirect risk and the caller can't sneak a different target
    # through.
    import os

    base = os.environ.get("APP_PUBLIC_URL", "").rstrip("/")
    if not base:
        raise HTTPException(
            status_code=500,
            detail={"error": "app_public_url_not_set"},
        )
    long_url = f"{base}/api/oauth/google/start?t={body.t}"

    db = request.app.state.db
    try:
        code, expires_at = shortlink.create_shortlink(db, long_url=long_url)
    except Exception as exc:  # noqa: BLE001
        logger.error("shortlink create failed: %s", exc)
        raise HTTPException(
            status_code=500,
            detail={"error": "shortlink_create_failed"},
        )

    short_url = f"{base}/c/{code}"
    logger.info(
        "shortlink created: code=%s expires_at=%s",
        code,
        expires_at.isoformat(),
    )
    return {
        "short_url": short_url,
        "code": code,
        "expires_at": expires_at.isoformat(),
    }
