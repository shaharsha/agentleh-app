"""Dashboard routes — agent status + subscription + usage for the logged-in user."""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request

from api.deps import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


def _meter_base_url() -> str:
    return (
        os.environ.get("APP_METER_BASE_URL")
        or "https://agentleh-meter-110274053287.europe-west3.run.app"
    )


def _meter_admin_token() -> str:
    return os.environ.get("APP_METER_ADMIN_TOKEN", "")


async def _fetch_agent_spend(agent_id: str) -> dict[str, Any] | None:
    """Call the meter's /admin/spend/{agent_id} endpoint server-side.

    The meter lives on internal Cloud Run ingress; only the app (with its
    admin bearer token) can reach it. The frontend never sees the token.
    Returns None if no active subscription exists or the meter is unreachable.
    """
    token = _meter_admin_token()
    if not token:
        logger.warning("APP_METER_ADMIN_TOKEN not set; skipping meter spend lookup")
        return None
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                f"{_meter_base_url().rstrip('/')}/admin/spend/{agent_id}",
                headers={"Authorization": f"Bearer {token}"},
            )
    except httpx.HTTPError as exc:
        logger.warning("meter unreachable for %s: %s", agent_id, exc)
        return None
    if resp.status_code == 404:
        return None
    if resp.status_code >= 400:
        logger.warning("meter %s for %s: %s", resp.status_code, agent_id, resp.text[:200])
        return None
    return resp.json()


@router.get("")
async def dashboard(request: Request, user: dict = Depends(get_current_user)):
    db = request.app.state.db
    agents = db.get_user_agents(user["id"])
    subscription = db.get_subscription(user["id"])

    # Enrich each agent with live spend data from the meter. Best-effort:
    # a missing subscription or unreachable meter returns `spend=None` and
    # the frontend renders a "plan not set up yet" state instead of erroring.
    enriched_agents: list[dict[str, Any]] = []
    for agent in agents:
        agent_copy = dict(agent)
        spend = await _fetch_agent_spend(agent["agent_id"])
        agent_copy["spend"] = spend
        enriched_agents.append(agent_copy)

    return {
        "user": {
            "id": user["id"],
            "email": user["email"],
            "full_name": user["full_name"],
            "phone": user["phone"],
            "onboarding_status": user["onboarding_status"],
            "role": user.get("role", "user"),
        },
        "agents": enriched_agents,
        "subscription": subscription,
    }


@router.get("/agents/{agent_id}/usage")
async def agent_usage(
    agent_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    """Recent usage events for one of the user's own agents.

    Authorization: the user must own this agent (via app_user_agents).
    Superadmins can see any agent.
    """
    db = request.app.state.db
    owned = any(a["agent_id"] == agent_id for a in db.get_user_agents(user["id"]))
    if not owned and user.get("role") != "superadmin":
        raise HTTPException(status_code=403, detail="not_your_agent")

    events = db.list_recent_usage_events(agent_id, limit=50)
    spend = await _fetch_agent_spend(agent_id)
    return {"events": events, "spend": spend}
