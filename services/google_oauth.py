"""Google OAuth 2.0 helpers for the per-agent Gmail + Calendar integration.

This module owns the *user-facing* half of the OAuth dance:

1. Verify a short-lived JWT minted either by this service (app UI connect
   button) or by the OpenClaw plugin (WhatsApp agent ``google_get_connect_url``
   tool). Same secret, same ``aud``, same shape — the callback doesn't
   care which path minted it.
2. Build Google's authorization URL with the correct scopes + state.
3. Exchange the authorization code for a refresh token + access token.
4. Fetch ``userinfo`` to know which Google account the user approved with.

**Writes are NOT owned here.** Phase 2 moved the credential-storage path
to the meter — the callback POSTs the plaintext refresh token to the
meter's ``POST /admin/google/store`` admin route (see
``app/services/meter_client.py``). The meter KMS-encrypts and UPSERTs.
This keeps ciphertext + cache invalidation in one place, and means the
app service doesn't need ``google-cloud-kms`` or KMS IAM at all.

The *container-facing* half (mint access tokens on demand for running
OpenClaw agents) also lives in the meter — see meter/meter/google_auth.py.
"""

from __future__ import annotations

import logging
import os
import time
import uuid
from dataclasses import dataclass
from typing import Any

import httpx
from jose import JWTError, jwt

logger = logging.getLogger(__name__)

GOOGLE_AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URI = "https://openidconnect.googleapis.com/v1/userinfo"

# Identity scopes — always requested, so we get a google_email back
# from /userinfo regardless of which feature scopes the user picked.
IDENTITY_SCOPES: tuple[str, ...] = (
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
)

# Feature capabilities the user can pick individually. Each maps to one
# or more Google OAuth scopes. Keep this restricted to scopes the
# Google Auth Platform approved for our project — adding anything else
# requires a new verification cycle and potentially CASA.
#
# v1 allowed keys: `calendar`, `email`. Adding a new capability means
# adding an entry here AND updating the corresponding Hebrew/English
# label maps in the frontend `IntegrationsPanel` component.
GOOGLE_CAPABILITY_TO_SCOPES: dict[str, tuple[str, ...]] = {
    "calendar": (
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/calendar.events",
    ),
    "email": ("https://www.googleapis.com/auth/gmail.send",),
}

ALL_CAPABILITIES: tuple[str, ...] = tuple(GOOGLE_CAPABILITY_TO_SCOPES.keys())

# Full scope list when no capabilities are specified (backwards-compat
# default). Preserved as ``GOOGLE_SCOPES`` so older call sites keep
# working until they're migrated to ``capabilities_to_scope_list``.
GOOGLE_SCOPES: tuple[str, ...] = tuple(
    list(IDENTITY_SCOPES)
    + [
        scope
        for cap in ALL_CAPABILITIES
        for scope in GOOGLE_CAPABILITY_TO_SCOPES[cap]
    ]
)


def capabilities_to_scope_list(caps: list[str] | None) -> list[str]:
    """Resolve a capability selection to the full OAuth scope list.

    - ``None`` or empty → all capabilities (backwards-compat default).
    - Unknown capability key → ``ValueError`` so the caller can 400.
    - Identity scopes are always included so userinfo fetch keeps
      working regardless of which features the user picked.
    """
    if not caps:
        caps = list(ALL_CAPABILITIES)
    resolved: list[str] = list(IDENTITY_SCOPES)
    seen: set[str] = set(resolved)
    for cap in caps:
        if cap not in GOOGLE_CAPABILITY_TO_SCOPES:
            raise ValueError(f"unknown_capability: {cap}")
        for scope in GOOGLE_CAPABILITY_TO_SCOPES[cap]:
            if scope not in seen:
                resolved.append(scope)
                seen.add(scope)
    return resolved

_JWT_ALGORITHM = "HS256"
_JWT_AUDIENCE = "agentiko-google-connect"
_JWT_TTL_SECONDS = 15 * 60  # 15 minute connect link

# Anything that ever gets honored as a post-consent redirect target must
# belong to a hostname we control. Checked at mint AND verify so that
# both a malformed mint call and a forged JWT are rejected.
_REDIRECT_HOST_ALLOWLIST: frozenset[str] = frozenset(
    {
        "app.agentiko.io",
        "app-dev.agentiko.io",
        "localhost",
        "127.0.0.1",
    }
)


# ─────────────────────────────────────────────────────────────────────────
# Config loaded from env vars (Cloud Run injects from Secret Manager)
# ─────────────────────────────────────────────────────────────────────────


def _env(name: str, *, required: bool = True, default: str = "") -> str:
    value = os.environ.get(name, default)
    if required and not value:
        raise RuntimeError(f"env var {name} is required for Google OAuth")
    return value


def _client_id() -> str:
    return _env("APP_GOOGLE_OAUTH_CLIENT_ID")


def _client_secret() -> str:
    return _env("APP_GOOGLE_OAUTH_CLIENT_SECRET")


def _jwt_secret() -> str:
    return _env("APP_GOOGLE_CONNECT_JWT_SECRET")


def _redirect_uri() -> str:
    return _env("APP_GOOGLE_OAUTH_REDIRECT_URI")


def _is_redirect_allowed(url: str) -> bool:
    """Allowlist check for post-consent ``redirect_to``.

    Accepted: any http(s) URL whose hostname is in the allowlist. The path
    and query are free-form — we only constrain the origin. No
    ``http://`` for production hosts; localhost is fine in any scheme for
    dev.
    """
    from urllib.parse import urlparse

    if not url:
        return False
    try:
        parsed = urlparse(url)
    except Exception:  # noqa: BLE001
        return False
    if parsed.scheme not in ("http", "https"):
        return False
    host = (parsed.hostname or "").lower()
    if host not in _REDIRECT_HOST_ALLOWLIST:
        return False
    # Require https for non-localhost hosts — prevents a downgrade footgun.
    if host not in ("localhost", "127.0.0.1") and parsed.scheme != "https":
        return False
    return True


# ─────────────────────────────────────────────────────────────────────────
# JWT (shared secret with the OpenClaw plugin)
# ─────────────────────────────────────────────────────────────────────────


@dataclass(slots=True)
class ConnectClaims:
    agent_id: str
    nonce: str
    redirect_to: str | None = None
    login_hint: str | None = None
    capabilities: list[str] | None = None


class InvalidRedirectError(ValueError):
    """Raised when a redirect_to URL is not in the allowlist. Separate
    from the generic 'invalid_state_token' so callers can give a clearer
    error to the user."""


def mint_connect_jwt(
    agent_id: str,
    *,
    redirect_to: str | None = None,
    login_hint: str | None = None,
    capabilities: list[str] | None = None,
) -> str:
    """Mint a short-lived state JWT pinning the OAuth flow to ``agent_id``.

    The OpenClaw plugin mints its own JWT with the same secret + aud but
    no ``redirect_to`` (WhatsApp flow lands on the inline Hebrew success
    page). The app UI passes ``redirect_to`` so the callback redirects
    back to the dashboard.

    ``capabilities`` is an optional list of capability keys (from
    ``GOOGLE_CAPABILITY_TO_SCOPES``) that limits which Google scopes the
    start endpoint will request. When omitted, all capabilities are
    requested (backwards-compat default). Validated at mint time so
    typos fail fast instead of at consent time.
    """
    if redirect_to is not None and not _is_redirect_allowed(redirect_to):
        raise InvalidRedirectError(
            f"redirect_to host not allowlisted: {redirect_to!r}"
        )

    if capabilities:
        # Validate against the allowlist — raises ValueError on unknown key.
        capabilities_to_scope_list(capabilities)

    now = int(time.time())
    payload: dict[str, Any] = {
        "iss": "agentleh-app",
        "aud": _JWT_AUDIENCE,
        "sub": agent_id,
        "iat": now,
        "exp": now + _JWT_TTL_SECONDS,
        "nonce": uuid.uuid4().hex,
    }
    if redirect_to:
        payload["redirect_to"] = redirect_to
    if login_hint:
        payload["login_hint"] = login_hint
    if capabilities:
        payload["caps"] = list(capabilities)
    return jwt.encode(payload, _jwt_secret(), algorithm=_JWT_ALGORITHM)


def verify_connect_jwt(token: str) -> ConnectClaims:
    try:
        payload = jwt.decode(
            token,
            _jwt_secret(),
            algorithms=[_JWT_ALGORITHM],
            audience=_JWT_AUDIENCE,
        )
    except JWTError as exc:
        logger.warning("google-connect jwt: verification failed: %s", exc)
        raise ValueError("invalid_state_token") from exc

    agent_id = payload.get("sub")
    nonce = payload.get("nonce", "")
    if not agent_id:
        raise ValueError("invalid_state_token")

    redirect_to = payload.get("redirect_to")
    if redirect_to is not None and not _is_redirect_allowed(redirect_to):
        # Belt + braces: if somehow a JWT gets minted with a
        # non-allowlisted redirect (or one gets forged with the shared
        # secret), we still refuse to honor it at verify time.
        logger.warning(
            "google-connect jwt: rejected non-allowlisted redirect_to %r",
            redirect_to,
        )
        raise InvalidRedirectError("redirect_to host not allowlisted")

    login_hint = payload.get("login_hint")

    # Validate capabilities claim at verify time too — defense against
    # a forged JWT that somehow got a bad key past mint-time validation.
    caps_raw = payload.get("caps")
    capabilities: list[str] | None = None
    if caps_raw is not None:
        if not isinstance(caps_raw, list) or not all(
            isinstance(c, str) for c in caps_raw
        ):
            raise ValueError("invalid_state_token")
        try:
            capabilities_to_scope_list(list(caps_raw))  # raises on unknown
        except ValueError:
            raise ValueError("invalid_state_token")
        capabilities = list(caps_raw)

    return ConnectClaims(
        agent_id=str(agent_id),
        nonce=str(nonce),
        redirect_to=str(redirect_to) if redirect_to else None,
        login_hint=str(login_hint) if login_hint else None,
        capabilities=capabilities,
    )


# ─────────────────────────────────────────────────────────────────────────
# Google authorization URL + token exchange
# ─────────────────────────────────────────────────────────────────────────


def build_authorization_url(
    state: str,
    *,
    login_hint: str | None = None,
    scopes: list[str] | None = None,
) -> str:
    """Build the Google OAuth consent URL.

    ``scopes`` is the resolved OAuth scope list — use
    :func:`capabilities_to_scope_list` upstream to turn a capability
    selection into the right list. When omitted, falls back to the full
    v1 scope set.
    """
    from urllib.parse import urlencode

    resolved_scopes = list(scopes) if scopes is not None else list(GOOGLE_SCOPES)
    params: dict[str, str] = {
        "response_type": "code",
        "client_id": _client_id(),
        "redirect_uri": _redirect_uri(),
        "scope": " ".join(resolved_scopes),
        "state": state,
        "access_type": "offline",
        "prompt": "consent",
        "include_granted_scopes": "true",
    }
    if login_hint:
        params["login_hint"] = login_hint
    return f"{GOOGLE_AUTH_URI}?{urlencode(params)}"


async def exchange_code(code: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            GOOGLE_TOKEN_URI,
            data={
                "grant_type": "authorization_code",
                "code": code,
                "client_id": _client_id(),
                "client_secret": _client_secret(),
                "redirect_uri": _redirect_uri(),
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    if resp.status_code != 200:
        logger.warning(
            "google exchange_code failed: %s %s",
            resp.status_code,
            resp.text[:500],
        )
        raise ValueError(f"google_token_exchange_failed: {resp.status_code}")
    return resp.json()


async def fetch_userinfo(access_token: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=5.0) as client:
        resp = await client.get(
            GOOGLE_USERINFO_URI,
            headers={"Authorization": f"Bearer {access_token}"},
        )
    resp.raise_for_status()
    return resp.json()


# ─────────────────────────────────────────────────────────────────────────
# Read-only helper for the app's status endpoint
# ─────────────────────────────────────────────────────────────────────────


def fetch_credentials(db, *, agent_id: str) -> dict[str, Any] | None:
    """Read the current credential row for an agent, for UI display.

    This is the only DB access path that stays in the app service —
    writes go through the meter. The app never decrypts the refresh
    token (it never needs to) and never deletes; the read returns just
    the metadata fields the integrations panel shows the user.
    """
    with db.connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT google_email, scopes, granted_at, last_refreshed_at
                FROM agent_google_credentials
                WHERE agent_id = %s
                """,
                (agent_id,),
            )
            row = cur.fetchone()
    return dict(row) if row else None


# ─────────────────────────────────────────────────────────────────────────
# Capability translation (scope URIs → trust-building UI strings)
# ─────────────────────────────────────────────────────────────────────────

_SCOPE_CAN_MAP = {
    "https://www.googleapis.com/auth/calendar": "manage_calendar",
    "https://www.googleapis.com/auth/calendar.events": "manage_events",
    "https://www.googleapis.com/auth/gmail.send": "send_email",
}


def scopes_to_capabilities(scopes: list[str]) -> dict[str, list[str]]:
    """Map granted scopes to human-facing capability keys.

    The ``cannot`` list is hardcoded for the v1 scope set and is a trust
    feature — users see explicitly what the agent cannot do. If we ever
    upgrade to ``gmail.readonly``, the ``cannot`` list shrinks
    automatically by removing entries from the hardcoded set.
    """
    scope_set = set(scopes or ())
    can = sorted({_SCOPE_CAN_MAP[s] for s in scope_set if s in _SCOPE_CAN_MAP})
    cannot: list[str] = []
    # Anything in this list that ISN'T implied by granted scopes becomes
    # a "cannot" — guaranteed to be accurate because the v1 OAuth client
    # cannot request these scopes at all.
    if "https://www.googleapis.com/auth/gmail.readonly" not in scope_set:
        cannot.append("read_email_bodies")
    if "https://www.googleapis.com/auth/gmail.metadata" not in scope_set:
        cannot.append("read_email_metadata")
    if "https://www.googleapis.com/auth/gmail.compose" not in scope_set:
        cannot.append("create_drafts")
    return {"can": can, "cannot": cannot}
