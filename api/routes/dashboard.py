"""Dashboard routes — agent status + subscription + usage, tenant-scoped."""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx
from fastapi import APIRouter, Depends, Query, Request

from api.deps import TenantContext, get_active_tenant_member

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
    # Use the with-deleted variant: soft-deleted agents still appear in
    # the breakdown — the meter returns rows keyed on their agent_id and
    # the tenant was billed for that traffic. Without the `deleted_at`
    # flag the UI can't tell live rows from tombstones.
    agents = db.list_tenant_agents_with_deleted(tenant["id"])
    usage = await _fetch_tenant_usage_by_agent(tenant["id"], from_, to)

    def _iso(value: Any) -> str | None:
        if value is None:
            return None
        return value.isoformat() if hasattr(value, "isoformat") else str(value)

    agent_meta: dict[str, dict[str, Any]] = {
        a["agent_id"]: {
            "agent_name": a["agent_name"],
            "agent_gender": a["agent_gender"],
            "deleted_at": _iso(a.get("deleted_at")),
        }
        for a in agents
    }

    meter_agents = (usage or {}).get("agents") or []
    seen: set[str] = set()
    enriched: list[dict[str, Any]] = []
    for row in meter_agents:
        aid = row["agent_id"]
        seen.add(aid)
        # Meter returned an agent_id we don't know about? Treat as a
        # legacy hard-deleted row (predates the soft-delete migration).
        # Show the raw id and mark deleted so the UI doesn't pretend it's live.
        meta = agent_meta.get(
            aid,
            {"agent_name": aid, "agent_gender": "", "deleted_at": "unknown"},
        )
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
                "deleted_at": _iso(a.get("deleted_at")),
                "llm_micros": 0,
                "search_micros": 0,
                "tts_micros": 0,
                "embedding_micros": 0,
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


