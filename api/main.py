"""FastAPI app for the Agentleh web application."""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

# Configure root logger once at import time so INFO/WARNING messages
# from our own modules (services/*, api/*) actually reach Cloud Run
# stdout. Without this, Python's default root level is WARNING and
# we silently drop useful operational logs like
# "BridgeWhatsApp: sent agent_ready_he template to +972..." making
# it impossible to debug a bad Meta delivery.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)

# httpx logs every outbound request at INFO as
# "HTTP Request: POST https://api.telegram.org/bot<TOKEN>/getMe ...",
# which leaks the Telegram bot token into Cloud Logging (both the
# manager bot's and any user-pasted per-agent token). We still want
# to see httpx WARNINGs (connection failures, etc.) — just not the
# request URL line.
logging.getLogger("httpx").setLevel(logging.WARNING)

import psycopg
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

from api.invite_og import (
    extract_invite_fields,
    inject_og,
    is_bot_ua,
    pick_locale,
    read_index_html,
    render_og_block,
)
from api.routes.admin import router as admin_router
from api.routes.agents import router as agents_router
from api.routes.auth import router as auth_router
from api.routes.bridges import router as bridges_router
from api.routes.chat import router as chat_router
from api.routes.coupons import router as coupons_router
from api.routes.dashboard import router as dashboard_router
from api.routes.google_oauth import router as google_oauth_router
from api.routes.integrations import router as integrations_router
from api.routes.invites import router as invites_router
from api.routes.onboarding import router as onboarding_router
from api.routes.telegram_webhook import router as telegram_webhook_router
from api.routes.tenants import router as tenants_router
from api.routes.voices import router as voices_router
from lib.config import get_database_url, settings
from lib.db import AppDatabase

logger = logging.getLogger(__name__)

APP_ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = APP_ROOT / "frontend" / "dist"


@asynccontextmanager
async def lifespan(app: FastAPI):
    db_url = os.environ.get("DATABASE_URL") or get_database_url()
    if not db_url:
        logger.error("DATABASE_URL not set")
        raise RuntimeError("DATABASE_URL is required")

    db = AppDatabase(db_url)
    db.init()
    app.state.db = db

    # Initialize services. The provisioner is picked per
    # AGENTLEH_PROVISIONER env var (`mock` or `vm`) so local dev stays
    # fast + deterministic while Cloud Run deploys use the real VM
    # daemon. Payment is gone — plan activation flows through coupon
    # redemption (see api/routes/coupons.py + lib/coupons.py).
    from services.provisioning import pick_provisioner
    from services.whatsapp import pick_whatsapp

    app.state.provisioner = pick_provisioner(db)
    app.state.whatsapp = pick_whatsapp()

    yield


app = FastAPI(title="Agentleh App", lifespan=lifespan)

# CORS
_cors_origins = str(getattr(settings, "cors_allowed_origins", "http://localhost:5173")).strip()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _cors_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)

# API routes
app.include_router(auth_router, prefix="/api")
app.include_router(coupons_router, prefix="/api")
app.include_router(onboarding_router, prefix="/api")
app.include_router(dashboard_router, prefix="/api")
app.include_router(tenants_router, prefix="/api")
app.include_router(agents_router, prefix="/api")
app.include_router(bridges_router, prefix="/api")
app.include_router(chat_router, prefix="/api")
app.include_router(telegram_webhook_router, prefix="/api")
app.include_router(invites_router, prefix="/api")
app.include_router(admin_router, prefix="/api")
app.include_router(google_oauth_router, prefix="/api")
app.include_router(integrations_router, prefix="/api")
app.include_router(voices_router, prefix="/api")


@app.exception_handler(psycopg.Error)
async def _db_error_handler(request: Request, exc: psycopg.Error) -> JSONResponse:
    """Catch-all for unhandled psycopg errors.

    Without this, an exception raised from a FastAPI dependency (e.g.
    get_current_user) bypasses the route's own try/except and FastAPI
    returns its default 500 with `{"detail": "Internal Server Error"}` —
    a plain string. Domain-specific frontend wrappers like `_couponCall`
    decode that as an empty detail and fall back to their hard-coded
    error code (e.g. `coupon_error`), misleading the user into thinking
    the coupon is broken when the real fault was in the auth layer.

    Returning the canonical `detail: {error, message, message_he}` shape
    here means every 5xx carries a generic `internal_error` code that
    the frontend can map to a correct "something went wrong" message.
    """
    logger.exception("unhandled db error at %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={
            "detail": {
                "error": "internal_error",
                "message": "A database error occurred. Please try again.",
                "message_he": "אירעה שגיאה פנימית. אנא נסה שוב.",
            }
        },
    )


@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Catch-all for any other uncaught exception so no 5xx leaves the
    app with string-shaped `detail`. HTTPException and RequestValidationError
    are handled by their own FastAPI/Starlette handlers before reaching
    this one."""
    logger.exception("unhandled error at %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={
            "detail": {
                "error": "internal_error",
                "message": "An unexpected error occurred. Please try again.",
                "message_he": "אירעה שגיאה לא צפויה. אנא נסה שוב.",
            }
        },
    )


@app.get("/health")
def health() -> dict:
    return {"ok": True}


# ─────────────────────────────────────────────────────────────────────────
# Short-URL redirect for the WhatsApp OAuth connect flow.
#
# The plugin's google_get_connect_url tool asks the app to shorten the
# full /api/oauth/google/start?t=<jwt> URL before sending it in
# WhatsApp. This route 302-redirects to the stored long URL (or shows
# the same Hebrew error page /start uses on expiry / unknown code, so
# the failure mode looks identical no matter which link the user taps).
#
# Registered BEFORE the /{full_path:path} SPA fallback so it wins route
# matching for /c/<code>.
# ─────────────────────────────────────────────────────────────────────────
@app.get("/c/{code}")
def shortlink_redirect(code: str, request: Request):
    from fastapi.responses import HTMLResponse, RedirectResponse
    from services import shortlink

    # Compact validation — codes are always 10 base62 chars. Anything
    # else is definitely bogus; short-circuit with the Hebrew error page.
    if not code.isalnum() or len(code) > 32:
        return HTMLResponse(
            _shortlink_error_html(),
            status_code=400,
        )

    db = request.app.state.db
    long_url = shortlink.resolve_shortlink(db, code=code)
    if long_url is None:
        return HTMLResponse(
            _shortlink_error_html(),
            status_code=404,
        )
    return RedirectResponse(url=long_url, status_code=302)


def _shortlink_error_html() -> str:
    """Tiny reusable Hebrew/English error page for expired/missing
    shortlinks. Matches the styling of the /start error page."""
    return """<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agentiko</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 0; min-height: 100vh; display: grid; place-items: center; }
    .card { background: rgba(30, 41, 59, 0.8); border-radius: 18px; padding: 32px; max-width: 360px; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.4); }
    .x { font-size: 56px; line-height: 1; margin-bottom: 16px; color: #f87171; }
    h1 { font-size: 20px; margin: 0 0 8px; }
    p { font-size: 14px; color: #cbd5e1; }
  </style>
</head>
<body>
  <div class="card">
    <div class="x">⚠</div>
    <h1>הקישור פג תוקף או שאינו תקין</h1>
    <p>חזור לוואטסאפ ובקש מהסוכן קישור חדש.</p>
  </div>
</body>
</html>"""


# ─────────────────────────────────────────────────────────────────────────
# Dynamic OG injection for /invites/accept?token=...
#
# Invite links get shared cold over WhatsApp / Slack / LinkedIn. For
# those scrapers we swap the static OG block in the built index.html for
# a dynamic "{inviter} invited you to {tenant} on Agentiko" preview.
# Humans always get the normal SPA shell. See api/invite_og.py for the
# pure string-manipulation helpers + rationale.
#
# Registered BEFORE /{full_path:path} so it wins route matching.
# ─────────────────────────────────────────────────────────────────────────
@app.get("/invites/accept", response_model=None)
def invites_accept_og(request: Request, token: str | None = None):
    idx = STATIC_DIR / "index.html"
    if not idx.exists():
        raise HTTPException(status_code=404, detail="No frontend build found")

    ua = request.headers.get("User-Agent", "")
    if not is_bot_ua(ua):
        # Humans get the untouched SPA — it boots and reads ?token=...
        # client-side, same as before this handler existed.
        return FileResponse(idx)

    invite: dict | None = None
    if token:
        try:
            invite = request.app.state.db.get_invite_by_token(token)
        except Exception:
            # Never let a DB hiccup turn a scraper hit into a 500 —
            # the generic fallback card is still a usable preview.
            logger.exception("invites_accept_og: invite lookup failed")

    inviter_name, tenant_name, role = extract_invite_fields(invite)
    lang = pick_locale(request.headers.get("Accept-Language"))
    og_block = render_og_block(
        url=str(request.url),
        inviter_name=inviter_name,
        tenant_name=tenant_name,
        role=role,
        lang=lang,
    )

    html_body = read_index_html(STATIC_DIR)
    if html_body is None:
        raise HTTPException(status_code=500, detail="Failed to read index.html")

    return HTMLResponse(
        content=inject_og(html_body, og_block),
        headers={"Cache-Control": "public, max-age=300"},
    )


@app.get("/{full_path:path}")
def spa_fallback(full_path: str):
    """Serve static files from the frontend build, with SPA fallback to index.html."""
    if full_path.startswith("api/"):
        raise HTTPException(status_code=404, detail="Not found")

    if STATIC_DIR.exists():
        candidate = STATIC_DIR / full_path
        if full_path and candidate.is_file():
            try:
                candidate.resolve().relative_to(STATIC_DIR.resolve())
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid path")
            return FileResponse(candidate)

        idx = STATIC_DIR / "index.html"
        if idx.exists():
            return FileResponse(idx)

    raise HTTPException(status_code=404, detail="No frontend build found")
