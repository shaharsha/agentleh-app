"""Dashboard routes — agent status + subscription + usage, tenant-scoped.

Old (unscoped) GET /api/dashboard is kept as a thin redirect to the
caller's default tenant dashboard so existing frontend builds don't
immediately 404 during a partial deploy. Once the frontend fully
speaks tenants the unscoped route can be removed in Phase 4 cleanup.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request

from api.deps import TenantContext, get_active_tenant_member, get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


def _meter_base_url() -> str:
    return (
        os.environ.get("APP_METER_BASE_URL")
        or "https://agentleh-meter-110274053287.europe-west3.run.app"
    )


def _meter_admin_token() -> str:
    return os.environ.get("APP_METER_ADMIN_TOKEN", "")


async def _fetch_tenant_spend(tenant_id: int) -> dict[str, Any] | None:
    """Call the meter's new canonical GET /admin/spend/tenant/{tenant_id}
    for the shared-pool per-tenant subscription totals. Best-effort:
    a missing subscription or unreachable meter returns None and the
    frontend renders a 'plan not set up yet' state instead of erroring.
    """
    token = _meter_admin_token()
    if not token:
        logger.warning("APP_METER_ADMIN_TOKEN not set; skipping meter spend lookup")
        return None
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                f"{_meter_base_url().rstrip('/')}/admin/spend/tenant/{tenant_id}",
                headers={"Authorization": f"Bearer {token}"},
            )
    except httpx.HTTPError as exc:
        logger.warning("meter unreachable for tenant=%s: %s", tenant_id, exc)
        return None
    if resp.status_code == 404:
        return None
    if resp.status_code >= 400:
        logger.warning("meter %s for tenant=%s: %s", resp.status_code, tenant_id, resp.text[:200])
        return None
    return resp.json()


async def _fetch_tenant_usage_by_agent(
    tenant_id: int,
    from_: str | None,
    to: str | None,
) -> dict[str, Any] | None:
    """Call the meter's GET /admin/spend/tenant/{tenant_id}/by-agent.

    Returns None on 404 (no active subscription) or any transport error;
    the caller is expected to render an empty/zero state.
    """
    token = _meter_admin_token()
    if not token:
        logger.warning("APP_METER_ADMIN_TOKEN not set; skipping meter usage lookup")
        return None
    params: dict[str, str] = {}
    if from_ is not None:
        params["from"] = from_
    if to is not None:
        params["to"] = to
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.get(
                f"{_meter_base_url().rstrip('/')}/admin/spend/tenant/{tenant_id}/by-agent",
                headers={"Authorization": f"Bearer {token}"},
                params=params,
            )
    except httpx.HTTPError as exc:
        logger.warning("meter unreachable for tenant=%s usage: %s", tenant_id, exc)
        return None
    if resp.status_code == 404:
        return None
    if resp.status_code >= 400:
        logger.warning(
            "meter %s for tenant=%s usage: %s", resp.status_code, tenant_id, resp.text[:200]
        )
        return None
    return resp.json()


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
async def dashboard_legacy(request: Request, user: dict = Depends(get_current_user)):
    """DEPRECATED — kept for partial-deploy compatibility. Redirects to
    the caller's default tenant dashboard. Frontend should migrate to
    GET /api/tenants/{tenant_id}/dashboard.
    """
    db = request.app.state.db
    tenants = db.list_user_tenants(user["id"])
    if not tenants:
        raise HTTPException(status_code=404, detail={"error": "no_tenant"})
    # Inline the per-tenant build so we don't need to re-invoke the
    # FastAPI dep machinery inside a route handler.
    return await _build_tenant_dashboard(db, tenants[0], user, role=tenants[0]["role"])


@router.get("/tenants/{tenant_id}")
async def tenant_dashboard(
    tenant_id: int,
    request: Request,
    ctx: TenantContext = Depends(get_active_tenant_member),
):
    """Tenant-scoped dashboard: agents + shared subscription + spend.

    All agents in the tenant share one subscription row (the shared
    pool model), so we fetch spend once per tenant rather than once
    per agent. Each agent still gets its own `spend` object so the UI
    can render a per-agent line item, populated from the same tenant
    subscription totals.
    """
    db = request.app.state.db
    return await _build_tenant_dashboard(db, ctx.tenant, ctx.user, role=ctx.role)


async def _build_tenant_dashboard(
    db, tenant: dict[str, Any], user: dict[str, Any], role: str
) -> dict[str, Any]:
    agents = db.list_tenant_agents(tenant["id"])
    tenant_spend = await _fetch_tenant_spend(tenant["id"])

    enriched_agents: list[dict[str, Any]] = []
    for agent in agents:
        enriched_agents.append(
            {
                "agent_id": agent["agent_id"],
                "agent_name": agent["agent_name"],
                "agent_gender": agent["agent_gender"],
                "status": agent["status"],
                "gateway_url": agent["gateway_url"],
                # All agents in this tenant share the same pool — same
                # spend object, computed once at the tenant level.
                "spend": tenant_spend,
            }
        )

    return {
        "user": {
            "id": user["id"],
            "email": user["email"],
            "full_name": user["full_name"],
            "phone": user["phone"],
            "onboarding_status": user["onboarding_status"],
            "role": user.get("role", "user"),
        },
        "tenant": {
            "id": tenant["id"],
            "slug": tenant["slug"],
            "name": tenant["name"],
            "role": role,
            "owner_user_id": tenant["owner_user_id"],
        },
        "agents": enriched_agents,
        "subscription": tenant_spend.get("subscription") if tenant_spend else None,
        "totals": tenant_spend.get("totals") if tenant_spend else None,
    }


@router.get("/tenants/{tenant_id}/usage")
async def tenant_usage(
    tenant_id: int,
    request: Request,
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    ctx: TenantContext = Depends(get_active_tenant_member),
):
    """Per-agent usage breakdown for a tenant, over a time range.

    - Default range (no ``from``/``to``): the active subscription's billing
      period. Response includes the ``subscription`` object and the
      allowance progress numbers.
    - Custom range: ``from=ISO8601&to=ISO8601``. Capped at 90 days by the
      meter. Response omits ``subscription`` (period-scoped and meaningless
      for ad-hoc ranges).

    Agents in the tenant that had zero usage in the range are still
    included (with zeroed totals) so the UI can render a complete roster.
    """
    db = request.app.state.db
    tenant = ctx.tenant
    agents = db.list_tenant_agents(tenant["id"])
    usage = await _fetch_tenant_usage_by_agent(tenant["id"], from_, to)

    # Build a name map so we can enrich meter rows with agent_name.
    agent_meta: dict[str, dict[str, Any]] = {
        a["agent_id"]: {"agent_name": a["agent_name"], "agent_gender": a["agent_gender"]}
        for a in agents
    }

    meter_agents = (usage or {}).get("agents") or []
    seen: set[str] = set()
    enriched: list[dict[str, Any]] = []
    for row in meter_agents:
        aid = row["agent_id"]
        seen.add(aid)
        meta = agent_meta.get(aid, {"agent_name": aid, "agent_gender": ""})
        enriched.append({**row, **meta})

    # Include agents with zero usage so the UI shows a complete roster.
    for a in agents:
        if a["agent_id"] in seen:
            continue
        enriched.append(
            {
                "agent_id": a["agent_id"],
                "agent_name": a["agent_name"],
                "agent_gender": a["agent_gender"],
                "llm_micros": 0,
                "search_micros": 0,
                "tts_micros": 0,
                "event_count": 0,
            }
        )

    return {
        "tenant_id": tenant["id"],
        "range": (usage or {}).get("range"),
        "subscription": (usage or {}).get("subscription"),
        "totals": (usage or {}).get("totals") or {},
        "agents": enriched,
    }


@router.get("/agents/{agent_id}/usage")
async def agent_usage(
    agent_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    """Recent usage events for one agent. Authorization: the caller
    must belong to the agent's tenant (via tenant_memberships). Super-
    admins can see any agent.

    Note: this legacy path is kept under /dashboard/agents/... for
    backwards compat with the existing frontend. The new canonical
    route would be /tenants/{tenant_id}/agents/{agent_id}/usage but
    we don't want to churn two places at once.
    """
    db = request.app.state.db
    # Resolve the agent's tenant, then verify membership.
    row = db._fetch_one(  # noqa: SLF001 — private helper on the same repo
        "SELECT tenant_id FROM agents WHERE agent_id = %s",
        (agent_id,),
    )
    if row is None or row["tenant_id"] is None:
        raise HTTPException(status_code=404, detail={"error": "agent_not_found"})

    is_superadmin = user.get("role") == "superadmin"
    if not is_superadmin:
        membership = db.get_tenant_membership(row["tenant_id"], user["id"])
        if membership is None:
            raise HTTPException(status_code=403, detail={"error": "not_your_agent"})

    events = db.list_recent_usage_events(agent_id, limit=50)
    spend = await _fetch_agent_spend(agent_id)
    return {"events": events, "spend": spend}
