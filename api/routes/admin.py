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


# ─── VM stats (for scaling decisions) ────────────────────────────────


def _vm_stats_url() -> str:
    """URL of the vm-stats HTTP daemon on openclaw-prod (VPC-internal)."""
    return os.environ.get("APP_VM_STATS_URL", "http://10.10.0.2:9100/stats")


def _vm_stats_token() -> str:
    return os.environ.get("APP_VM_STATS_TOKEN", "")


@router.get("/vm-stats")
async def admin_vm_stats(
    request: Request,
    _: dict = Depends(require_superadmin),
) -> dict[str, Any]:
    """Live VM snapshot + last 24h of history for the admin Stats tab.

    Returns {live: {...}, history: [{ts, cpu_percent, ...}, ...]}.
    The live payload comes from the vm-stats.py HTTP daemon on the VM
    (reachable via VPC direct egress); history comes from Cloud SQL
    vm_metrics_samples populated by the systemd timer every 60s.
    """
    live: dict[str, Any] | None = None
    live_error: str | None = None
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            headers: dict[str, str] = {}
            token = _vm_stats_token()
            if token:
                headers["Authorization"] = f"Bearer {token}"
            resp = await client.get(_vm_stats_url(), headers=headers)
        if resp.status_code == 200:
            live = resp.json()
        else:
            live_error = f"vm_stats_{resp.status_code}: {resp.text[:120]}"
    except Exception as exc:  # noqa: BLE001
        live_error = f"vm_stats_unreachable: {exc}"
        logger.warning("vm-stats fetch failed: %s", exc)

    # Filter the docker container list down to OpenClaw agent containers only.
    # Vector (log shipper) and any other support containers are interesting to
    # ops but noise on the admin dashboard, which is meant to surface agents.
    if live and isinstance(live.get("docker"), dict):
        docker = live["docker"]
        all_containers = docker.get("containers") or []
        agent_containers = [
            c for c in all_containers
            if "openclaw/openclaw" in (c.get("image") or "")
        ]
        docker["containers"] = agent_containers
        docker["total"] = len(agent_containers)
        docker["running"] = sum(1 for c in agent_containers if c.get("state") == "running")

    db = request.app.state.db
    history = db._fetch_all(
        """
        SELECT
            ts,
            cpu_percent, memory_percent,
            disk_root_pct, disk_data_pct,
            containers_run, load_avg_1m
        FROM vm_metrics_samples
        WHERE ts > now() - interval '24 hours'
        ORDER BY ts ASC
        """,
    )

    # DB-sourced "nerd stats" that are free since they live next to our data:
    # usage events per hour for the last 24h
    events_per_hour = db._fetch_all(
        """
        SELECT
            date_trunc('hour', ts) AS hour,
            COUNT(*)                  AS events,
            SUM(cost_micros)          AS cost_micros,
            AVG(latency_ms)::int      AS avg_latency_ms
        FROM usage_events
        WHERE ts > now() - interval '24 hours'
        GROUP BY hour
        ORDER BY hour ASC
        """,
    )
    top_agents = db._fetch_all(
        """
        SELECT
            agent_id,
            SUM(cost_micros)               AS cost_micros,
            COUNT(*)                       AS events,
            SUM(input_tokens + output_tokens) AS total_tokens
        FROM usage_events
        WHERE ts > now() - interval '30 days'
        GROUP BY agent_id
        ORDER BY cost_micros DESC
        LIMIT 5
        """,
    )
    meter_latency = db._fetch_one(
        """
        SELECT
            COUNT(*) AS n,
            percentile_disc(0.5)  WITHIN GROUP (ORDER BY latency_ms) AS p50,
            percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95,
            percentile_disc(0.99) WITHIN GROUP (ORDER BY latency_ms) AS p99
        FROM usage_events
        WHERE ts > now() - interval '1 hour'
          AND upstream_status = 200
        """,
    )

    # 24h totals: requests, tokens, search queries, cost — split by kind so the
    # frontend can show "LLM vs Search" without re-aggregating.
    today_totals = db._fetch_one(
        """
        SELECT
            COUNT(*)                                                          AS requests,
            COUNT(*) FILTER (WHERE kind = 'llm')                              AS llm_requests,
            COUNT(*) FILTER (WHERE kind = 'search')                           AS search_requests,
            COALESCE(SUM(input_tokens), 0)::bigint                            AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::bigint                           AS output_tokens,
            COALESCE(SUM(cached_tokens), 0)::bigint                           AS cached_tokens,
            COALESCE(SUM(search_queries), 0)::bigint                          AS search_queries,
            COALESCE(SUM(cost_micros), 0)::bigint                             AS cost_micros,
            COALESCE(SUM(cost_micros) FILTER (WHERE kind = 'llm'), 0)::bigint AS llm_cost_micros,
            COALESCE(SUM(cost_micros) FILTER (WHERE kind = 'search'), 0)::bigint AS search_cost_micros
        FROM usage_events
        WHERE ts > now() - interval '24 hours'
        """,
    )

    # Per-hour cost split by kind — pivoted server-side so each row is one hour.
    cost_by_kind_per_hour = db._fetch_all(
        """
        SELECT
            date_trunc('hour', ts) AS hour,
            COALESCE(SUM(cost_micros) FILTER (WHERE kind = 'llm'),    0)::bigint AS llm_cost_micros,
            COALESCE(SUM(cost_micros) FILTER (WHERE kind = 'search'), 0)::bigint AS search_cost_micros,
            COUNT(*) FILTER (WHERE kind = 'llm')                                 AS llm_events,
            COUNT(*) FILTER (WHERE kind = 'search')                              AS search_events
        FROM usage_events
        WHERE ts > now() - interval '24 hours'
        GROUP BY hour
        ORDER BY hour ASC
        """,
    )

    # Token throughput per hour (LLM only — search has no input/output tokens).
    tokens_per_hour = db._fetch_all(
        """
        SELECT
            date_trunc('hour', ts) AS hour,
            COALESCE(SUM(input_tokens),  0)::bigint AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
            COALESCE(SUM(cached_tokens), 0)::bigint AS cached_tokens
        FROM usage_events
        WHERE ts > now() - interval '24 hours'
          AND kind = 'llm'
        GROUP BY hour
        ORDER BY hour ASC
        """,
    )

    # 7-day cost breakdown by model — catches accidental fallback to a more
    # expensive model. One row per (model, kind).
    model_breakdown_7d = db._fetch_all(
        """
        SELECT
            model,
            kind,
            COUNT(*)                                       AS events,
            COALESCE(SUM(cost_micros), 0)::bigint          AS cost_micros,
            COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS total_tokens
        FROM usage_events
        WHERE ts > now() - interval '7 days'
        GROUP BY model, kind
        ORDER BY cost_micros DESC
        """,
    )

    return {
        "live": live,
        "live_error": live_error,
        "history": history,
        "events_per_hour": events_per_hour,
        "top_agents": top_agents,
        "meter_latency_1h": meter_latency,
        "today_totals": today_totals,
        "cost_by_kind_per_hour": cost_by_kind_per_hour,
        "tokens_per_hour": tokens_per_hour,
        "model_breakdown_7d": model_breakdown_7d,
    }
