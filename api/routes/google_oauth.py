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

from fastapi import APIRouter, Query, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from services import google_oauth
from services.google_oauth import InvalidRedirectError
from services.meter_client import MeterClientError, store_google_credentials

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

    logger.info(
        "google-connect start: agent_id=%s has_redirect=%s has_hint=%s",
        claims.agent_id,
        bool(claims.redirect_to),
        bool(claims.login_hint),
    )
    # Pass the same JWT as the state parameter — callback re-validates
    # and extracts agent_id + redirect_to from it. Google echoes state
    # back untouched.
    return RedirectResponse(
        url=google_oauth.build_authorization_url(
            state=t,
            login_hint=claims.login_hint,
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
        token_response = await google_oauth.exchange_code(code)
    except ValueError as exc:
        logger.warning("google-connect callback: exchange failed: %s", exc)
        return _redirect_or_html_error(
            claims_redirect_to,
            "לא הצלחנו לאשר את החיבור מול גוגל.",
            502,
            "error",
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
        return _redirect_or_html_error(
            claims_redirect_to,
            "גוגל לא החזירה אסימון חידוש. נסה שוב.",
            502,
            "error",
        )

    try:
        userinfo = await google_oauth.fetch_userinfo(access_token)
    except Exception as exc:  # noqa: BLE001
        logger.warning("google-connect callback: userinfo fetch failed: %s", exc)
        userinfo = {}

    google_email = userinfo.get("email") or "unknown"

    scopes = [s for s in granted_scope.split() if s] or list(google_oauth.GOOGLE_SCOPES)

    # Hand the plaintext refresh token to the meter — single writer for
    # agent_google_credentials, atomic cache purge, no KMS in the app.
    try:
        await store_google_credentials(
            agent_id=claims.agent_id,
            google_email=google_email,
            refresh_token=refresh_token,
            scopes=scopes,
        )
    except MeterClientError as exc:
        logger.error(
            "google-connect callback: meter store failed for agent_id=%s: %s",
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
        "google-connect callback: stored credentials for agent_id=%s email=%s",
        claims.agent_id,
        google_email,
    )

    # Success. Branch on whether the JWT asked for a redirect back to an
    # allowlisted URL (app UI path) or the inline HTML page (WhatsApp path).
    if claims_redirect_to:
        return RedirectResponse(
            _append_query(claims_redirect_to, "google", "connected"),
            status_code=302,
        )
    return HTMLResponse(_success_html(google_email), status_code=200)
