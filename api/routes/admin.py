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
from lib import coupons as coupons_lib

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


# ─── One-shot: register the Telegram manager-bot webhook ─────────────


@router.post("/telegram/setup-webhook")
async def setup_telegram_webhook(
    request: Request,
    body: dict = Body(default={}),
    _: dict = Depends(require_superadmin),
) -> dict[str, Any]:
    """Bind @AgentikoManagerBot's webhook to this deployment.

    Call once per environment after:
      1. The manager-bot token is in Secret Manager (telegram-manager-bot-token
         / -dev).
      2. Bot Management Mode is enabled on the bot in BotFather.

    Body (optional):
      {"public_url": "https://app-dev.agentiko.io"}
    Defaults to APP_PUBLIC_URL or the request's own host.

    Returns:
      {"ok": true, "webhook_url": "...", "telegram_response": {...}}

    The endpoint is idempotent — re-running rebinds (useful after a URL
    change or secret rotation). The webhook secret is generated and
    stored in Secret Manager automatically on first call.
    """
    from services import telegram_manager

    public_url = (
        body.get("public_url")
        or os.environ.get("APP_PUBLIC_URL")
        or str(request.url).split("/api/")[0]
    ).rstrip("/")
    webhook_url = f"{public_url}/api/telegram/webhook"

    try:
        result = telegram_manager.set_webhook(webhook_url)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=502,
            detail={"error": "setwebhook_failed", "detail": str(exc)},
        ) from exc

    return {"ok": True, "webhook_url": webhook_url, "telegram_response": result}


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


# Chat model allowlist — MUST stay in sync with:
#   agent-config/ops/create-agent.sh        (provisioning-time --model allowlist)
#   agent-config/ops/provision-api.py       (VM-side ALLOWED_MODELS)
#   agent-config/openclaw/openclaw.json     (agents.defaults.models + catalog)
#   meter/migrations/026_gemma4_pricing.sql (pricing rows)
# Widening any one in isolation creates drift (allowlist lets through a model
# that has no pricing row → $0 billing; or has pricing but not in catalog →
# OpenClaw rejects at boot).
_ALLOWED_MODELS: frozenset[str] = frozenset(
    {
        "google/gemini-3-flash-preview",
        "google/gemma-4-31b-it",
    }
)


@router.get("/agents/{agent_id}/model/live")
async def admin_get_live_agent_model(
    agent_id: str,
    request: Request,
    _: dict = Depends(require_superadmin),
) -> dict[str, Any]:
    """Authoritative live-read of the agent's chat model from the VM, with
    drift detection against the DB mirror.

    Returns: {db_model: str|null, live_model: str|null, drift: bool,
              live_reachable: bool, error?: str}.

    Used by the admin detail view (one VM roundtrip per open — NOT the list
    view which stays fast on the DB mirror). If `drift=true`, the UI shows
    a warning and offers a "Re-sync DB from VM" action which writes the
    live value back into `agents.model` so the list view catches up.

    Drift sources (present or future):
      - Someone SSHes to the VM and hand-edits openclaw.json.
      - A future tenant self-serve UI writes via a path that skips
        /admin/agents/{id}/model (it shouldn't — the architecture expects
        all writes to route through the app so VM + DB update atomically).
      - An in-agent skill modifies the model (same architectural rule
        applies — skill should call back into the app, not the VM).
    """
    db = request.app.state.db
    details = db.get_agent_details(agent_id)
    if details is None:
        raise HTTPException(status_code=404, detail="agent_not_found")
    db_model = details.get("model")

    provisioner = request.app.state.provisioner
    live_result = provisioner.get_agent_model(agent_id)
    if not live_result.get("success"):
        # Can't read live — surface the reason but keep the endpoint 200
        # so the UI can still show the DB value.
        return {
            "agent_id": agent_id,
            "db_model": db_model,
            "live_model": None,
            "drift": False,
            "live_reachable": False,
            "error": live_result.get("error"),
        }

    live_model = live_result.get("model")
    return {
        "agent_id": agent_id,
        "db_model": db_model,
        "live_model": live_model,
        # Normalise: DB NULL is equivalent to whatever the VM reports for
        # brand-new agents that never went through the set-model path.
        # Drift only fires when both sides have concrete values and disagree.
        "drift": (db_model is not None) and (live_model is not None) and db_model != live_model,
        "live_reachable": True,
    }


@router.post("/agents/{agent_id}/model/resync")
async def admin_resync_agent_model_from_vm(
    agent_id: str,
    request: Request,
    _: dict = Depends(require_superadmin),
) -> dict[str, Any]:
    """Pull the live model from the VM and write it to the DB mirror.

    The inverse of /model — instead of setting VM from admin input, this
    sets DB from what the VM reports. Used to resolve drift detected by
    /model/live without doing a write to the VM.
    """
    db = request.app.state.db
    details = db.get_agent_details(agent_id)
    if details is None:
        raise HTTPException(status_code=404, detail="agent_not_found")

    provisioner = request.app.state.provisioner
    live_result = provisioner.get_agent_model(agent_id)
    if not live_result.get("success"):
        raise HTTPException(
            status_code=502,
            detail={
                "error": "vm_get_model_failed",
                "vm_error": live_result.get("error"),
                "vm_detail": live_result.get("detail"),
            },
        )
    live_model = live_result.get("model")
    updated = db.set_agent_model(agent_id, live_model)
    return {
        "success": True,
        "agent_id": agent_id,
        "db_model": live_model,
        "synced_from_vm": True,
        "db_updated": updated is not None,
    }


@router.patch("/agents/{agent_id}/model")
async def admin_set_agent_model(
    agent_id: str,
    request: Request,
    body: dict[str, Any] = Body(...),
    _: dict = Depends(require_superadmin),
) -> dict[str, Any]:
    """Flip an agent's chat model.

    Body: {"model": "google/gemini-3-flash-preview" | "google/gemma-4-31b-it"}.
    `model=null` resets the DB mirror to NULL (= inherit default) — useful if
    drift is detected and you want to force re-sync on next set.

    Write ordering: VM first, then DB. If the VM write fails the DB is left
    unchanged so the admin UI still reflects reality. If the VM write succeeds
    but the DB update fails (unlikely; SupabasePG is the same instance the
    request began with), the UI shows the old model until the next set — the
    VM is the authoritative source for routing anyway.
    """
    model = body.get("model")
    if model is not None and (not isinstance(model, str) or model not in _ALLOWED_MODELS):
        raise HTTPException(
            status_code=400,
            detail={
                "error": "model_not_allowed",
                "allowed": sorted(_ALLOWED_MODELS) + [None],
            },
        )

    db = request.app.state.db
    # Confirm the agent exists up front so the admin gets a clean 404 instead
    # of the VM's "agent_not_found" bubbling back (same message but cleaner
    # provenance).
    details = db.get_agent_details(agent_id)
    if details is None:
        raise HTTPException(status_code=404, detail="agent_not_found")

    # model=null means "unset the DB mirror only" (admin reset / drift fix).
    # Don't touch the VM in that case — the VM's openclaw.json is the source
    # of truth and a `null` value there would crash the agent at load.
    if model is None:
        updated = db.set_agent_model(agent_id, None)
        return {
            "success": True,
            "agent_id": agent_id,
            "model": None,
            "vm_updated": False,
            "db_updated": updated is not None,
        }

    provisioner = request.app.state.provisioner
    vm_result = provisioner.set_agent_model(agent_id, model)
    if not vm_result.get("success"):
        # Pass VM error through so the admin can distinguish
        # "agent_not_found" / "model_not_allowed" / "config_write_failed" /
        # "provision-api unreachable" — all actionable differently.
        raise HTTPException(
            status_code=502,
            detail={
                "error": "vm_set_model_failed",
                "vm_error": vm_result.get("error"),
                "vm_detail": vm_result.get("detail"),
            },
        )

    updated = db.set_agent_model(agent_id, model)
    return {
        "success": True,
        "agent_id": agent_id,
        "model": model,
        "previous_model": vm_result.get("previous_model"),
        "no_op": bool(vm_result.get("no_op")),
        "vm_updated": True,
        "db_updated": updated is not None,
    }


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


# ─── Tenants (cross-tenant superadmin views) ─────────────────────────
# List + detail. No mutation paths here — if a superadmin wants to
# rename or delete a tenant they can navigate to /tenants/{id} and use
# the tenant's own UI (the TenantContext resolver bypasses membership
# for role='superadmin'). This keeps the mutation surface single-
# sourced; the admin panel just gives cross-tenant visibility.


def _tenant_row_out(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "slug": row["slug"],
        "name": row["name"],
        "name_base": row.get("name_base"),
        "created_at": row["created_at"].isoformat() if row.get("created_at") else None,
        "billing_email": row.get("billing_email"),
        "owner_user_id": row["owner_user_id"],
        "owner_email": row.get("owner_email"),
        "owner_full_name": row.get("owner_full_name"),
        "member_count": int(row.get("member_count") or 0),
        "agent_count": int(row.get("agent_count") or 0),
        "plan_id": row.get("plan_id"),
        "plan_name_he": row.get("plan_name_he"),
        "price_ils_cents": row.get("price_ils_cents"),
        "subscription_status": row.get("subscription_status"),
        "subscription_period_end": (
            row["subscription_period_end"].isoformat()
            if row.get("subscription_period_end") else None
        ),
    }


@router.get("/tenants")
async def admin_list_tenants(
    request: Request,
    _: dict = Depends(require_superadmin),
) -> dict[str, Any]:
    """Every non-deleted tenant with its owner + active subscription
    inlined. Powers the admin Tenants tab."""
    db = request.app.state.db
    rows = db.list_all_tenants()
    return {"tenants": [_tenant_row_out(r) for r in rows]}


@router.get("/tenants/{tenant_id}")
async def admin_tenant_detail(
    tenant_id: int,
    request: Request,
    _: dict = Depends(require_superadmin),
) -> dict[str, Any]:
    """Full detail: members, agents (live + deleted), active sub,
    recent audit, pending invites. For the admin drawer."""
    db = request.app.state.db
    detail = db.get_tenant_full_detail(tenant_id)
    if detail is None:
        raise HTTPException(status_code=404, detail={"error": "tenant_not_found"})

    def _iso(v):
        return v.isoformat() if hasattr(v, "isoformat") else v

    tenant = detail["tenant"]
    sub = detail["subscription"]
    return {
        "tenant": {
            "id": tenant["id"],
            "slug": tenant["slug"],
            "name": tenant["name"],
            "name_base": tenant.get("name_base"),
            "owner_user_id": tenant["owner_user_id"],
            "owner_email": tenant.get("owner_email"),
            "owner_full_name": tenant.get("owner_full_name"),
            "billing_email": tenant.get("billing_email"),
            "created_at": _iso(tenant.get("created_at")),
            "deleted_at": _iso(tenant.get("deleted_at")),
        },
        "members": [
            {
                "user_id": m["user_id"],
                "email": m["email"],
                "full_name": m["full_name"],
                "role": m["role"],
                "joined_at": _iso(m.get("joined_at")),
            }
            for m in detail["members"]
        ],
        "agents": [
            {
                "agent_id": a["agent_id"],
                "agent_name": a["agent_name"],
                "agent_gender": a.get("agent_gender"),
                "status": a["status"],
                "gateway_url": a.get("gateway_url"),
                "created_at": _iso(a.get("created_at")),
                "deleted_at": _iso(a.get("deleted_at")),
            }
            for a in detail["agents"]
        ],
        "subscription": {
            "id": sub["id"],
            "plan_id": sub["plan_id"],
            "plan_name_he": sub["plan_name_he"],
            "billing_mode": sub["billing_mode"],
            "status": sub["status"],
            "period_start": _iso(sub["period_start"]),
            "period_end": _iso(sub["period_end"]),
            "base_allowance_micros": int(sub["base_allowance_micros"]),
            "used_micros": int(sub["used_micros"]),
            "overage_enabled": bool(sub["overage_enabled"]),
            "overage_cap_micros": (
                int(sub["overage_cap_micros"])
                if sub.get("overage_cap_micros") is not None else None
            ),
            "overage_used_micros": int(sub["overage_used_micros"]),
        } if sub else None,
        "pending_invites": [
            {
                "id": i["id"],
                "email": i["email"],
                "role": i["role"],
                "created_at": _iso(i.get("created_at")),
                "expires_at": _iso(i.get("expires_at")),
            }
            for i in detail["pending_invites"]
        ],
        "recent_audit": [
            {
                "id": e["id"],
                "actor_user_id": e["actor_user_id"],
                "actor_email": e.get("actor_email"),
                "actor_full_name": e.get("actor_full_name"),
                "action": e["action"],
                "target_type": e.get("target_type"),
                "target_id": e.get("target_id"),
                "metadata": e.get("metadata"),
                "created_at": _iso(e.get("created_at")),
            }
            for e in detail["recent_audit"]
        ],
    }


# ─── VM stats (for scaling decisions) ────────────────────────────────


def _vm_stats_url() -> str:
    """URL of the vm-stats HTTP daemon on openclaw-prod (VPC-internal)."""
    return os.environ.get("APP_VM_STATS_URL", "http://10.10.0.2:9100/stats")


def _vm_stats_token() -> str:
    return os.environ.get("APP_VM_STATS_TOKEN", "")


# ─── Agent-capacity heuristic ────────────────────────────────────────────────
# Tunable constants driving the "how many more OpenClaws fit on this VM"
# indicator. These are empirical blends of steady-state and burst footprint,
# not hard caps — the per-container `mem_limit: 3g` in create-agent.sh is the
# OOM ceiling; TYPICAL_AGENT_MB is what we plan against so the indicator
# doesn't swing every time one agent briefly spikes. Raise TYPICAL_AGENT_MB
# if the tile ever reads "0 remaining" while adding another agent still works;
# lower it if the tile reads "2 remaining" and the next provision OOM-kills.
_RESERVED_OVERHEAD_MB = 2200  # OS 700 + whisper 1100 + vector 30 + docker 300 + buffer
_SAFETY_MARGIN_MB = 512       # head-room so "0 remaining" means really at cap
_TYPICAL_AGENT_MB = 1500      # steady + peak blend, not the 3 GB mem_limit
_BOOT_DISK_AGENT_GB = 0.5     # per-agent image share + log drift
_DATA_DISK_AGENT_GB = 1.0     # /data footprint per agent (observed 50-200 MB, conservative)
_LOAD_PER_AGENT = 0.3         # sustained load contribution under typical Hebrew traffic
_BOOT_DISK_RESERVE_GB = 5.0   # OS + logs floor on /
_DATA_DISK_RESERVE_GB = 2.0   # snapshot + growth floor on /data
_CPU_HEADROOM = 0.5           # leave half a core of unallocated load


def _compute_capacity(live: dict[str, Any]) -> dict[str, Any] | None:
    """How many more OpenClaw agents fit on this VM before a resize.

    Returns None when the live payload is missing fields we need (so the
    frontend can render a graceful "unknown" state). Otherwise returns the
    minimum across four constraints (RAM, CPU, boot disk, /data) and names
    the binding one — the user wants to see *why* capacity is tight.
    """
    try:
        memory = live["memory"]
        cpu = live["cpu"]
        disk = live["disk"]
    except (KeyError, TypeError):
        return None

    available_mb = memory.get("available_mb")
    cores = cpu.get("cores")
    load_avg = cpu.get("load_avg_5m")
    root = disk.get("root") or {}
    data = disk.get("data") or {}
    root_free_gb = root.get("free_gb")
    data_free_gb = data.get("free_gb")

    if None in (available_mb, cores, load_avg, root_free_gb, data_free_gb):
        return None

    ram_budget_mb = available_mb - _SAFETY_MARGIN_MB - _RESERVED_OVERHEAD_MB
    ram_agents = max(0, int(ram_budget_mb // _TYPICAL_AGENT_MB))

    cpu_budget = cores - load_avg - _CPU_HEADROOM
    cpu_agents = max(0, int(cpu_budget // _LOAD_PER_AGENT))

    boot_budget_gb = root_free_gb - _BOOT_DISK_RESERVE_GB
    boot_agents = max(0, int(boot_budget_gb // _BOOT_DISK_AGENT_GB))

    data_budget_gb = data_free_gb - _DATA_DISK_RESERVE_GB
    data_agents = max(0, int(data_budget_gb // _DATA_DISK_AGENT_GB))

    per_constraint = {
        "ram": ram_agents,
        "cpu": cpu_agents,
        "boot_disk": boot_agents,
        "data_disk": data_agents,
    }
    binding, agents_remaining = min(per_constraint.items(), key=lambda kv: kv[1])

    return {
        "agents_remaining": agents_remaining,
        "binding_constraint": binding,
        "per_constraint": per_constraint,
        "assumptions": {
            "typical_agent_mb": _TYPICAL_AGENT_MB,
            "reserved_overhead_mb": _RESERVED_OVERHEAD_MB,
            "safety_margin_mb": _SAFETY_MARGIN_MB,
            "load_per_agent": _LOAD_PER_AGENT,
            "boot_disk_agent_gb": _BOOT_DISK_AGENT_GB,
            "data_disk_agent_gb": _DATA_DISK_AGENT_GB,
        },
    }


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

    # How many more agents fit — computed after the docker filter so the
    # tile matches the containers the user sees in the table below it.
    capacity = _compute_capacity(live) if live else None

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
            COUNT(*)                                                                AS requests,
            COUNT(*) FILTER (WHERE kind = 'llm')                                    AS llm_requests,
            COUNT(*) FILTER (WHERE kind = 'search')                                 AS search_requests,
            COUNT(*) FILTER (WHERE kind = 'embedding')                              AS embedding_requests,
            COALESCE(SUM(input_tokens), 0)::bigint                                  AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::bigint                                 AS output_tokens,
            COALESCE(SUM(cached_tokens), 0)::bigint                                 AS cached_tokens,
            COALESCE(SUM(search_queries), 0)::bigint                                AS search_queries,
            COALESCE(SUM(cost_micros), 0)::bigint                                   AS cost_micros,
            COALESCE(SUM(cost_micros) FILTER (WHERE kind = 'llm'), 0)::bigint       AS llm_cost_micros,
            COALESCE(SUM(cost_micros) FILTER (WHERE kind = 'search'), 0)::bigint    AS search_cost_micros,
            COALESCE(SUM(cost_micros) FILTER (WHERE kind = 'embedding'), 0)::bigint AS embedding_cost_micros
        FROM usage_events
        WHERE ts > now() - interval '24 hours'
        """,
    )

    # Per-hour cost split by kind — pivoted server-side so each row is one hour.
    cost_by_kind_per_hour = db._fetch_all(
        """
        SELECT
            date_trunc('hour', ts) AS hour,
            COALESCE(SUM(cost_micros) FILTER (WHERE kind = 'llm'),       0)::bigint AS llm_cost_micros,
            COALESCE(SUM(cost_micros) FILTER (WHERE kind = 'search'),    0)::bigint AS search_cost_micros,
            COALESCE(SUM(cost_micros) FILTER (WHERE kind = 'embedding'), 0)::bigint AS embedding_cost_micros,
            COUNT(*) FILTER (WHERE kind = 'llm')                                    AS llm_events,
            COUNT(*) FILTER (WHERE kind = 'search')                                 AS search_events,
            COUNT(*) FILTER (WHERE kind = 'embedding')                              AS embedding_events
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
        "capacity": capacity,
        "history": history,
        "events_per_hour": events_per_hour,
        "top_agents": top_agents,
        "meter_latency_1h": meter_latency,
        "today_totals": today_totals,
        "cost_by_kind_per_hour": cost_by_kind_per_hour,
        "tokens_per_hour": tokens_per_hour,
        "model_breakdown_7d": model_breakdown_7d,
    }


# ─── Coupons (superadmin CRUD) ──────────────────────────────────────────
# Codes are 12-char base32 by default; the admin can override on create.
# Plan + duration are immutable once a coupon exists — changing them
# would invalidate the redemption history's snapshot semantics. Use
# disable + create-new instead.


@router.get("/coupons")
async def admin_list_coupons(
    request: Request,
    _: dict = Depends(require_superadmin),
) -> dict[str, Any]:
    db = request.app.state.db
    return {"coupons": db.list_coupons()}


@router.post("/coupons", status_code=201)
async def admin_create_coupon(
    body: dict[str, Any] = Body(...),
    request: Request = None,  # type: ignore[assignment]
    user: dict = Depends(require_superadmin),
) -> dict[str, Any]:
    """Create a coupon. Body fields:

      code           — optional. Server-generates 12-char base32 if absent.
      plan_id        — required. Must match billing_plans.plan_id.
      duration_days  — required, 1..3650.
      max_redemptions — optional int. NULL = unlimited.
      valid_until    — optional ISO timestamp. NULL = no expiry.
      one_per_user   — optional bool, default True.
      notes          — optional string.

    Returns the new coupon row including the resolved code so the
    superadmin can copy it once. (Codes are also visible in the list
    afterwards — there's no secrecy here, the index is on upper(code).)
    """
    plan_id = body.get("plan_id")
    duration_days = body.get("duration_days")
    if not plan_id or not isinstance(plan_id, str):
        raise HTTPException(400, detail={"error": "plan_id_required"})
    if not isinstance(duration_days, int) or duration_days <= 0 or duration_days > 3650:
        raise HTTPException(
            400, detail={"error": "duration_days_invalid", "range": "1..3650"}
        )

    code = body.get("code") or coupons_lib.generate_code()
    code = code.strip().upper()
    if not code:
        raise HTTPException(400, detail={"error": "code_invalid"})

    max_redemptions = body.get("max_redemptions")
    if max_redemptions is not None and (
        not isinstance(max_redemptions, int) or max_redemptions <= 0
    ):
        raise HTTPException(400, detail={"error": "max_redemptions_invalid"})

    valid_until_raw = body.get("valid_until")
    valid_until = None
    if valid_until_raw:
        from datetime import datetime
        try:
            valid_until = datetime.fromisoformat(valid_until_raw.replace("Z", "+00:00"))
        except ValueError as exc:
            raise HTTPException(400, detail={"error": "valid_until_invalid"}) from exc

    one_per_user = bool(body.get("one_per_user", True))
    notes = (body.get("notes") or "").strip()

    db = request.app.state.db
    try:
        row = db.create_coupon(
            code=code,
            plan_id=plan_id,
            duration_days=duration_days,
            max_redemptions=max_redemptions,
            valid_until=valid_until,
            one_per_user=one_per_user,
            notes=notes,
            created_by=user["id"],
        )
    except Exception as exc:  # noqa: BLE001 — most likely unique-violation on code
        msg = str(exc)
        if "coupons_code_key" in msg or "unique" in msg.lower():
            raise HTTPException(409, detail={"error": "code_already_exists", "code": code}) from exc
        raise

    return row


@router.patch("/coupons/{coupon_id}")
async def admin_update_coupon(
    coupon_id: int,
    body: dict[str, Any] = Body(...),
    request: Request = None,  # type: ignore[assignment]
    _: dict = Depends(require_superadmin),
) -> dict[str, Any]:
    """Edit mutable coupon fields: notes, max_redemptions, valid_until,
    one_per_user. Plan and duration are intentionally immutable."""
    db = request.app.state.db
    fields: dict[str, Any] = {}
    if "notes" in body:
        fields["notes"] = (body["notes"] or "").strip()
    if "max_redemptions" in body:
        v = body["max_redemptions"]
        if v is not None and (not isinstance(v, int) or v <= 0):
            raise HTTPException(400, detail={"error": "max_redemptions_invalid"})
        fields["max_redemptions"] = v
    if "valid_until" in body:
        v = body["valid_until"]
        if v is None:
            fields["valid_until"] = None
        else:
            from datetime import datetime
            try:
                fields["valid_until"] = datetime.fromisoformat(v.replace("Z", "+00:00"))
            except ValueError as exc:
                raise HTTPException(400, detail={"error": "valid_until_invalid"}) from exc
    if "one_per_user" in body:
        fields["one_per_user"] = bool(body["one_per_user"])

    updated = db.update_coupon(coupon_id, **fields)
    if updated is None:
        raise HTTPException(404, detail={"error": "coupon_not_found"})
    return updated


@router.post("/coupons/{coupon_id}/disable")
async def admin_disable_coupon(
    coupon_id: int,
    request: Request,
    _: dict = Depends(require_superadmin),
) -> dict[str, Any]:
    db = request.app.state.db
    updated = db.set_coupon_disabled(coupon_id, True)
    if updated is None:
        raise HTTPException(404, detail={"error": "coupon_not_found"})
    return updated


@router.post("/coupons/{coupon_id}/enable")
async def admin_enable_coupon(
    coupon_id: int,
    request: Request,
    _: dict = Depends(require_superadmin),
) -> dict[str, Any]:
    db = request.app.state.db
    updated = db.set_coupon_disabled(coupon_id, False)
    if updated is None:
        raise HTTPException(404, detail={"error": "coupon_not_found"})
    return updated


@router.get("/coupons/{coupon_id}/redemptions")
async def admin_list_redemptions(
    coupon_id: int,
    request: Request,
    _: dict = Depends(require_superadmin),
) -> dict[str, Any]:
    db = request.app.state.db
    return {"redemptions": db.list_coupon_redemptions(coupon_id)}


# ─── Direct admin grant (no coupon) ────────────────────────────────────


@router.post("/tenants/{tenant_id}/grant-plan")
async def admin_grant_plan(
    tenant_id: int,
    body: dict[str, Any] = Body(...),
    request: Request = None,  # type: ignore[assignment]
    user: dict = Depends(require_superadmin),
) -> dict[str, Any]:
    """Activate a plan on a tenant directly, without a coupon code.

    Logged in coupon_redemptions with coupon_id=NULL and granted_by_admin
    set to the calling superadmin's id. Same supersession logic as a
    coupon redemption (immediate upgrade / queued downgrade / queued
    same-plan renewal).

    Body: {plan_id, duration_days}.
    """
    plan_id = body.get("plan_id")
    duration_days = body.get("duration_days")
    if not plan_id or not isinstance(plan_id, str):
        raise HTTPException(400, detail={"error": "plan_id_required"})
    if not isinstance(duration_days, int) or duration_days <= 0 or duration_days > 3650:
        raise HTTPException(
            400, detail={"error": "duration_days_invalid", "range": "1..3650"}
        )

    db = request.app.state.db
    # Resolve the tenant owner — that's the user_id we'll record as the
    # redemption's user_id (same convention coupons.redeem uses for
    # tenant ownership). If we recorded the admin as user_id the audit
    # would be confusing.
    tenant = db.get_tenant_by_id(tenant_id)
    if tenant is None:
        raise HTTPException(404, detail={"error": "tenant_not_found"})

    import asyncio
    try:
        result = await asyncio.to_thread(
            coupons_lib.redeem,
            db,
            user_id=int(tenant["owner_user_id"]),
            tenant_id=tenant_id,
            code=None,
            granted_by_admin=user["id"],
            plan_id_override=plan_id,
            duration_days_override=duration_days,
        )
    except coupons_lib.CouponError as exc:
        raise HTTPException(
            status_code=exc.http_status, detail={"error": exc.code, **exc.detail}
        ) from exc

    return {"redemption": result.to_dict()}
