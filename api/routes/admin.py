"""Superadmin-only routes: list users/agents/subscriptions/usage via the meter.

Only users with `app_users.role = 'superadmin'` can access these endpoints.
The app's backend proxies the meter's admin API using its own admin bearer
token from Secret Manager, so the frontend never sees the meter credentials.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Request

from api.deps import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin"])


def _meter_base_url() -> str:
    """Where the app-side superadmin panel calls the meter service.

    Must be an internal URL reachable from the app's VPC egress. Defaults
    to the prod meter; override via APP_METER_BASE_URL / APP_METER_BASE_URL_DEV.
    """
    return (
        os.environ.get("APP_METER_BASE_URL")
        or "https://agentleh-meter-110274053287.europe-west3.run.app"
    )


def _meter_admin_token() -> str:
    token = os.environ.get("APP_METER_ADMIN_TOKEN", "")
    if not token:
        raise HTTPException(
            status_code=503,
            detail="meter admin token not configured on app",
        )
    return token


async def _meter_get(path: str) -> Any:
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"{_meter_base_url().rstrip('/')}{path}",
            headers={"Authorization": f"Bearer {_meter_admin_token()}"},
        )
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)
    return resp.json()


async def _meter_post(path: str, body: dict[str, Any] | None = None) -> Any:
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            f"{_meter_base_url().rstrip('/')}{path}",
            headers={"Authorization": f"Bearer {_meter_admin_token()}"},
            json=body or {},
        )
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)
    return resp.json()


def require_superadmin(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") != "superadmin":
        raise HTTPException(status_code=403, detail="superadmin_required")
    return user


# ─── Dashboard data ──────────────────────────────────────────────────


@router.get("/overview")
async def admin_overview(
    request: Request,
    _: dict = Depends(require_superadmin),
) -> dict[str, Any]:
    """Top-level admin dashboard data: users, agents, plan catalog."""
    db = request.app.state.db
    users = db.list_all_users_with_agent_counts()
    agents = db.list_all_agents_with_owner_and_plan()
    plans = db.list_billing_plans()
    return {
        "users": users,
        "agents": agents,
        "plans": plans,
    }


@router.get("/agents/{agent_id}")
async def admin_agent_detail(
    agent_id: str,
    request: Request,
    _: dict = Depends(require_superadmin),
) -> dict[str, Any]:
    """Agent detail: identity, current subscription, recent usage events, meter spend."""
    db = request.app.state.db
    details = db.get_agent_details(agent_id)
    if details is None:
        raise HTTPException(status_code=404, detail="agent_not_found")
    recent_events = db.list_recent_usage_events(agent_id, limit=50)

    # Pull the canonical subscription + totals from the meter so the app's view
    # matches exactly what the meter enforces. Non-fatal if the meter is down.
    try:
        spend = await _meter_get(f"/admin/spend/{agent_id}")
    except HTTPException as exc:
        spend = {"error": "meter_unreachable", "detail": str(exc.detail), "status": exc.status_code}

    return {
        "agent": details,
        "recent_events": recent_events,
        "spend": spend,
    }


# ─── Mutations ───────────────────────────────────────────────────────


@router.post("/users/{user_id}/role")
async def admin_set_user_role(
    user_id: int,
    body: dict[str, Any] = Body(...),
    request: Request = None,  # type: ignore[assignment]
    _: dict = Depends(require_superadmin),
) -> dict[str, Any]:
    """Promote/demote a user. Body: {"role": "user"|"superadmin"}."""
    role = body.get("role")
    if role not in ("user", "superadmin"):
        raise HTTPException(status_code=400, detail="invalid_role")
    db = request.app.state.db
    updated = db.set_user_role(user_id, role)
    if updated is None:
        raise HTTPException(status_code=404, detail="user_not_found")
    return updated


@router.post("/agents/{agent_id}/keys/rotate")
async def admin_rotate_meter_key(
    agent_id: str,
    _: dict = Depends(require_superadmin),
) -> dict[str, Any]:
    """Rotate the per-agent meter key via the meter service."""
    return await _meter_post(f"/admin/keys/rotate/{agent_id}")


@router.post("/agents/{agent_id}/subscription")
async def admin_upsert_subscription(
    agent_id: str,
    body: dict[str, Any] = Body(...),
    _: dict = Depends(require_superadmin),
) -> dict[str, Any]:
    """Create or replace an agent's subscription via the meter service.

    Body passthrough — see meter's admin_upsert_subscription for fields.
    `agent_id` is injected from the URL so the caller can't mismatch.
    """
    payload = dict(body)
    payload["agent_id"] = agent_id
    return await _meter_post("/admin/subscriptions", payload)
