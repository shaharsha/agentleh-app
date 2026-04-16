"""HTTP client for calling ``agentleh-meter``'s admin routes from the app.

The app uses this for anything that mutates ``agent_google_credentials``
— storing freshly-minted Google refresh tokens after the OAuth callback,
and revoking them when a user hits Disconnect from the dashboard.

Writes are centralized in the meter (see ``meter/meter/google_auth.py``)
so that KMS encryption + the in-memory access-token cache + the DB row
stay in lock-step. The app holds no KMS access and no direct
``agent_google_credentials`` write path — only this thin HTTP shim.

Auth: ``APP_METER_ADMIN_TOKEN`` env var, injected by Cloud Run from the
Secret Manager secret ``meter-admin-token`` (prod) or
``meter-admin-token-dev`` (dev). This is the same bearer token the
meter's existing ``/admin/keys/*`` and ``/admin/subscriptions`` routes
use — we're just adding two more routes behind the same gate.

Network: the meter has ``--ingress=internal``, so calls must originate
from inside the VPC. The app's Cloud Run service has Direct VPC Egress
attached to the same network, so it reaches the meter via its
``.run.app`` URL but the packets never leave Google's network.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx

logger = logging.getLogger(__name__)


class MeterClientError(Exception):
    """Raised when the meter returns a non-2xx response or is unreachable.

    Carries the HTTP status code when available so routes can surface
    meaningful errors to the frontend (e.g. a 502 "meter down" vs a
    404 "unknown agent" from the meter's side).
    """

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


def _base_url() -> str:
    url = os.environ.get("APP_METER_BASE_URL", "").strip()
    if not url:
        raise MeterClientError("APP_METER_BASE_URL is not set")
    return url.rstrip("/")


def _admin_token() -> str:
    token = os.environ.get("APP_METER_ADMIN_TOKEN", "").strip()
    if not token:
        raise MeterClientError("APP_METER_ADMIN_TOKEN is not set")
    return token


async def _post(path: str, body: dict[str, Any]) -> dict[str, Any]:
    url = f"{_base_url()}{path}"
    headers = {
        "Authorization": f"Bearer {_admin_token()}",
        "Content-Type": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, json=body, headers=headers)
    except httpx.HTTPError as exc:
        logger.warning("meter_client: network error calling %s: %s", path, exc)
        raise MeterClientError(f"meter unreachable: {exc}", status_code=502) from exc

    if resp.status_code >= 500:
        raise MeterClientError(
            f"meter returned {resp.status_code} for {path}",
            status_code=502,
        )
    try:
        data = resp.json()
    except Exception as exc:  # noqa: BLE001
        raise MeterClientError(
            f"meter returned non-JSON for {path}",
            status_code=502,
        ) from exc

    if resp.status_code >= 400:
        err = data.get("error", "unknown") if isinstance(data, dict) else "unknown"
        raise MeterClientError(
            f"meter {path} {resp.status_code}: {err}",
            status_code=resp.status_code,
        )
    return data if isinstance(data, dict) else {}


async def store_google_credentials(
    *,
    agent_id: str,
    google_email: str,
    refresh_token: str,
    scopes: list[str],
) -> dict[str, Any]:
    """POST /admin/google/store — meter KMS-encrypts and UPSERTs atomically,
    purging any cached access token for this agent."""
    return await _post(
        "/admin/google/store",
        {
            "agent_id": agent_id,
            "google_email": google_email,
            "refresh_token": refresh_token,
            "scopes": scopes,
        },
    )


async def revoke_google_credentials(*, agent_id: str) -> dict[str, Any]:
    """POST /admin/google/revoke — meter calls Google's /revoke, hard-deletes
    the row, and purges the cache. Idempotent (returns ``revoked: false``
    if there was no row to begin with)."""
    return await _post("/admin/google/revoke", {"agent_id": agent_id})


# ─────────────────────────────────────────────────────────────────────────
# Nylas grant storage (Nylas migration)
# ─────────────────────────────────────────────────────────────────────────


async def store_nylas_credentials(
    *,
    agent_id: str,
    grant_id: str,
    email: str,
    scopes: list[str],
    capabilities: list[str] | None = None,
) -> dict[str, Any]:
    """POST /admin/nylas/store — meter UPSERTs the Nylas grant_id.
    No encryption needed — grant_id is useless without the API key."""
    return await _post(
        "/admin/nylas/store",
        {
            "agent_id": agent_id,
            "grant_id": grant_id,
            "email": email,
            "scopes": scopes,
            "capabilities": capabilities or [],
        },
    )


async def revoke_nylas_credentials(*, agent_id: str) -> dict[str, Any]:
    """POST /admin/nylas/revoke — meter deletes the grant row and calls
    Nylas DELETE /v3/grants/{id}. Idempotent."""
    return await _post("/admin/nylas/revoke", {"agent_id": agent_id})
