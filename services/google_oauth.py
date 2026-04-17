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

NYLAS_AUTH_BASE = "https://api.us.nylas.com/v3/connect"
NYLAS_API_BASE = "https://api.us.nylas.com/v3"

# Identity scopes — always requested so Nylas returns the email.
IDENTITY_SCOPES: tuple[str, ...] = (
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
)

# Feature capabilities the user can pick individually. Each maps to one
# or more Google OAuth scopes passed to Nylas in the auth URL. Nylas's
# shared GCP app is CASA-verified for gmail.modify (restricted scope),
# so we get full email read + send without our own CASA audit.
#
# Allowed keys: `calendar`, `email`. Adding a new capability means
# adding an entry here AND updating the Hebrew/English label maps in
# the frontend `IntegrationsPanel` component.
CAPABILITY_TO_SCOPES: dict[str, tuple[str, ...]] = {
    "calendar": ("https://www.googleapis.com/auth/calendar",),
    "email": ("https://www.googleapis.com/auth/gmail.modify",),
}

ALL_CAPABILITIES: tuple[str, ...] = tuple(CAPABILITY_TO_SCOPES.keys())

# Backward-compat alias for older call sites.
GOOGLE_CAPABILITY_TO_SCOPES = CAPABILITY_TO_SCOPES

# Full scope list when no capabilities are specified (default: all).
GOOGLE_SCOPES: tuple[str, ...] = tuple(
    list(IDENTITY_SCOPES)
    + [
        scope
        for cap in ALL_CAPABILITIES
        for scope in CAPABILITY_TO_SCOPES[cap]
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
        if cap not in CAPABILITY_TO_SCOPES:
            raise ValueError(f"unknown_capability: {cap}")
        for scope in CAPABILITY_TO_SCOPES[cap]:
            if scope not in seen:
                resolved.append(scope)
                seen.add(scope)
    return resolved

_JWT_ALGORITHM = "HS256"
_JWT_AUDIENCE = "agentleh-google-connect"
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
        raise RuntimeError(f"env var {name} is required for OAuth")
    return value


def _nylas_client_id() -> str:
    return _env("APP_NYLAS_CLIENT_ID")


def _nylas_api_key() -> str:
    return _env("APP_NYLAS_API_KEY")


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
# Nylas hosted OAuth — authorization URL + code exchange
# ─────────────────────────────────────────────────────────────────────────


def build_authorization_url(
    state: str,
    *,
    login_hint: str | None = None,
    scopes: list[str] | None = None,
) -> str:
    """Build the Nylas hosted OAuth URL.

    Redirects the user to Nylas's consent page, which in turn shows
    Google's consent screen (branded "Nylas" since we're using their
    CASA-verified shared GCP app). After consent, Nylas redirects to
    our callback URI with a code we exchange for a grant_id.
    """
    from urllib.parse import urlencode

    resolved_scopes = list(scopes) if scopes is not None else list(GOOGLE_SCOPES)
    params: dict[str, str] = {
        "client_id": _nylas_client_id(),
        "redirect_uri": _redirect_uri(),
        "response_type": "code",
        "access_type": "online",
        "provider": "google",
        "scope": " ".join(resolved_scopes),
        "state": state,
    }
    if login_hint:
        params["login_hint"] = login_hint
    return f"{NYLAS_AUTH_BASE}/auth?{urlencode(params)}"


async def exchange_code(code: str) -> dict[str, Any]:
    """Exchange a Nylas authorization code for a grant.

    Returns a dict with at least: grant_id, email, provider, scope.
    """
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"{NYLAS_AUTH_BASE}/token",
            json={
                "client_id": _nylas_client_id(),
                "client_secret": _nylas_api_key(),
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": _redirect_uri(),
                "code_verifier": "nylas",
            },
        )
    if resp.status_code != 200:
        logger.warning(
            "nylas exchange_code failed: %s %s",
            resp.status_code,
            resp.text[:500],
        )
        raise ValueError(f"nylas_token_exchange_failed: {resp.status_code}")
    return resp.json()


# ─────────────────────────────────────────────────────────────────────────
# Read-only helper for the app's status endpoint
# ─────────────────────────────────────────────────────────────────────────


def fetch_credentials(db, *, agent_id: str) -> dict[str, Any] | None:
    """Read the current credential row for an agent, for UI display.

    Reads from the Nylas credentials table (post-migration). The app
    never touches the grant_id — only metadata for the integrations
    panel. Writes go through the meter's /admin/nylas/store.
    """
    with db.connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT email, scopes, capabilities, granted_at
                FROM agent_nylas_credentials
                WHERE agent_id = %s
                """,
                (agent_id,),
            )
            row = cur.fetchone()
    if row is None:
        return None
    result = dict(row)
    # Backward-compat: keep the google_email key that the frontend
    # and integrations routes expect.
    result["google_email"] = result.pop("email", "")
    return result


# ─────────────────────────────────────────────────────────────────────────
# Capability translation (scope URIs → trust-building UI strings)
# ─────────────────────────────────────────────────────────────────────────

_SCOPE_CAN_MAP = {
    "https://www.googleapis.com/auth/calendar": "manage_calendar",
    "https://www.googleapis.com/auth/gmail.modify": "manage_email",
    "https://www.googleapis.com/auth/gmail.send": "send_email",
}


def scopes_to_capabilities(scopes: list[str]) -> dict[str, list[str]]:
    """Map granted scopes to human-facing capability keys.

    With Nylas + gmail.modify, the agent can now read emails too. The
    ``cannot`` list is much shorter than v1 (most email restrictions
    are lifted).
    """
    scope_set = set(scopes or ())
    can = sorted({_SCOPE_CAN_MAP[s] for s in scope_set if s in _SCOPE_CAN_MAP})

    # gmail.modify covers read + send + labels, so "can read" replaces
    # the old "cannot read" entries.
    if "https://www.googleapis.com/auth/gmail.modify" in scope_set:
        can = sorted(set(can) | {"read_email", "send_email", "manage_labels"})

    cannot: list[str] = []
    # Only surface "cannot" for things that are genuinely not possible.
    if "https://www.googleapis.com/auth/gmail.modify" not in scope_set:
        if "https://www.googleapis.com/auth/gmail.send" not in scope_set:
            cannot.append("send_email")
        cannot.append("read_email")
    return {"can": can, "cannot": cannot}
