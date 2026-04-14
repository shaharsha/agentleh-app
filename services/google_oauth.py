"""Google OAuth 2.0 helpers for the per-agent Gmail + Calendar integration.

This module owns the *user-facing* half of the OAuth dance:

1. Verify a short-lived JWT minted by the bridge that pins the flow to a
   specific agent_id.
2. Build Google's authorization URL with the correct scopes + state.
3. Exchange the authorization code for a refresh token + access token.
4. KMS-encrypt the refresh token and upsert it into agent_google_credentials.

The *container-facing* half (mint access tokens on demand for running
OpenClaw agents) lives in the meter — see meter/meter/google_auth.py. The
two services share the DB table and the same KMS key.
"""

from __future__ import annotations

import logging
import os
import time
import uuid
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import httpx
from jose import JWTError, jwt

logger = logging.getLogger(__name__)

GOOGLE_AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token"
GOOGLE_REVOKE_URI = "https://oauth2.googleapis.com/revoke"
GOOGLE_USERINFO_URI = "https://openidconnect.googleapis.com/v1/userinfo"

# v1 scopes — all sensitive-only, no restricted (no CASA audit).
# Kept in one place so the start route and the DB row agree.
GOOGLE_SCOPES: tuple[str, ...] = (
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/gmail.send",
)

_JWT_ALGORITHM = "HS256"
_JWT_AUDIENCE = "agentiko-google-connect"
_JWT_TTL_SECONDS = 15 * 60  # 15 minute connect link

_KEY_RING = "oauth-keyring"
_KEY_NAME = "google-refresh-tokens"
_KEY_LOCATION = "europe-west3"


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


def _gcp_project() -> str:
    return _env("APP_GCP_PROJECT", required=False, default="agentleh")


def _redirect_uri() -> str:
    return _env("APP_GOOGLE_OAUTH_REDIRECT_URI")


# ─────────────────────────────────────────────────────────────────────────
# JWT (shared secret with bridge)
# ─────────────────────────────────────────────────────────────────────────


@dataclass(slots=True)
class ConnectClaims:
    agent_id: str
    nonce: str


def mint_connect_jwt(agent_id: str) -> str:
    """Used by tests and admin tools. The bridge mints its own JWTs."""
    now = int(time.time())
    payload = {
        "iss": "agentleh-bridge",
        "aud": _JWT_AUDIENCE,
        "sub": agent_id,
        "iat": now,
        "exp": now + _JWT_TTL_SECONDS,
        "nonce": uuid.uuid4().hex,
    }
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
    return ConnectClaims(agent_id=str(agent_id), nonce=str(nonce))


# ─────────────────────────────────────────────────────────────────────────
# Google authorization URL + token exchange
# ─────────────────────────────────────────────────────────────────────────


def build_authorization_url(state: str) -> str:
    from urllib.parse import urlencode

    params = {
        "response_type": "code",
        "client_id": _client_id(),
        "redirect_uri": _redirect_uri(),
        "scope": " ".join(GOOGLE_SCOPES),
        "state": state,
        "access_type": "offline",
        "prompt": "consent",
        "include_granted_scopes": "true",
    }
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


async def revoke_at_google(token: str) -> None:
    """Best-effort revoke (for explicit disconnect). Never raises."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(
                GOOGLE_REVOKE_URI,
                data={"token": token},
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning("google revoke: best-effort call failed: %s", exc)


# ─────────────────────────────────────────────────────────────────────────
# KMS — encrypt the refresh token before it touches the DB
# ─────────────────────────────────────────────────────────────────────────


@lru_cache(maxsize=1)
def _kms_client():
    # Lazy import so local dev without google-cloud-kms still imports the module.
    from google.cloud import kms  # type: ignore

    return kms.KeyManagementServiceClient()


def _kms_key_resource() -> str:
    return (
        f"projects/{_gcp_project()}"
        f"/locations/{_KEY_LOCATION}"
        f"/keyRings/{_KEY_RING}"
        f"/cryptoKeys/{_KEY_NAME}"
    )


def encrypt_refresh_token(plaintext: str) -> bytes:
    resp = _kms_client().encrypt(
        request={"name": _kms_key_resource(), "plaintext": plaintext.encode("utf-8")},
    )
    return resp.ciphertext


# ─────────────────────────────────────────────────────────────────────────
# DB upsert / lookup / delete for agent_google_credentials
# ─────────────────────────────────────────────────────────────────────────


def upsert_credentials(
    db,
    *,
    agent_id: str,
    google_email: str,
    refresh_token_plaintext: str,
    scopes: list[str],
) -> None:
    ciphertext = encrypt_refresh_token(refresh_token_plaintext)
    with db.connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO agent_google_credentials
                    (agent_id, google_email, refresh_token, scopes, granted_at)
                VALUES (%s, %s, %s, %s, now())
                ON CONFLICT (agent_id) DO UPDATE SET
                    google_email      = EXCLUDED.google_email,
                    refresh_token     = EXCLUDED.refresh_token,
                    scopes            = EXCLUDED.scopes,
                    granted_at        = now(),
                    last_refreshed_at = NULL,
                    revoked_at        = NULL
                """,
                (agent_id, google_email, ciphertext, scopes),
            )
        conn.commit()


def fetch_credentials(db, *, agent_id: str) -> dict[str, Any] | None:
    with db.connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT google_email, scopes, granted_at, last_refreshed_at, revoked_at
                FROM agent_google_credentials
                WHERE agent_id = %s
                """,
                (agent_id,),
            )
            row = cur.fetchone()
    return dict(row) if row else None


def delete_credentials(db, *, agent_id: str) -> bool:
    with db.connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM agent_google_credentials WHERE agent_id = %s",
                (agent_id,),
            )
            deleted = cur.rowcount
        conn.commit()
    return deleted > 0
