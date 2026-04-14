"""Tenant routes — CRUD, members, invites, agents.

All tenant-scoped endpoints live under `/api/tenants/{tenant_id}/...`
except:
  - GET/POST /api/tenants        — list-my + create (unscoped)
  - Invite preview/accept lives in routes/invites.py (token-scoped)

Authorization flows through api.deps.get_active_tenant_member and
api.deps.require_tenant_role(...). 404 (not 403) is returned on
non-member access to avoid leaking tenant existence via email enumeration.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from api.deps import (
    TenantContext,
    get_active_tenant_member,
    get_current_user,
    require_tenant_role,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/tenants", tags=["tenants"])


# ─── Request/response shapes ────────────────────────────────────────────


class TenantCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    billing_email: str = ""


class TenantPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=80)
    billing_email: str | None = None


class MemberRoleChange(BaseModel):
    role: str = Field(..., pattern="^(admin|member)$")


class InviteCreate(BaseModel):
    # Minimal email validation — Resend will reject non-deliverable
    # addresses upstream anyway, and we don't want to pull in
    # pydantic[email] as a new dep to get EmailStr.
    email: str = Field(..., pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$", max_length=254)
    role: str = Field(..., pattern="^(admin|member)$")


class TransferOwner(BaseModel):
    new_owner_user_id: int


def _tenant_out(row: dict[str, Any], role: str | None = None) -> dict[str, Any]:
    """Shape a tenant row for the frontend. Role is included when we're
    resolving from the caller's perspective (list / detail)."""
    out = {
        "id": row["id"],
        "slug": row["slug"],
        "name": row["name"],
        "owner_user_id": row["owner_user_id"],
        "billing_email": row.get("billing_email", ""),
        "created_at": row["created_at"].isoformat() if row.get("created_at") else None,
    }
    if role is not None:
        out["role"] = role
    return out


# ─── Tenant CRUD (unscoped — caller is the current user) ────────────────


@router.get("")
async def list_my_tenants(
    request: Request, user: dict[str, Any] = Depends(get_current_user)
) -> dict[str, Any]:
    """List every tenant the caller belongs to, with their role on each.

    Called by the tenant switcher in the top nav + the post-login
    decision: if the caller has >1 tenants, route to /tenants (list
    view). If exactly 1, route straight into that tenant's dashboard.
    """
    db = request.app.state.db
    rows = db.list_user_tenants(user["id"])
    return {
        "tenants": [_tenant_out(r, role=r["role"]) for r in rows],
        "default_tenant_id": rows[0]["id"] if rows else None,
    }


@router.post("", status_code=201)
async def create_tenant_route(
    body: TenantCreate,
    request: Request,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Create an additional tenant. Caller becomes its owner.

    Not called for the default tenant — that one is created implicitly
    by onboarding/submit or ensure_default_tenant().
    """
    db = request.app.state.db
    tenant = db.create_tenant(
        name=body.name,
        owner_user_id=user["id"],
        billing_email=body.billing_email or user["email"],
    )
    logger.info("tenant created id=%s by user=%s", tenant["id"], user["id"])
    return _tenant_out(tenant, role="owner")


@router.get("/{tenant_id}")
async def get_tenant_detail(
    tenant_id: int,
    request: Request,
    ctx: TenantContext = Depends(get_active_tenant_member),
) -> dict[str, Any]:
    """Full tenant detail for the settings page: tenant + members + agent
    count + pending invite count. Subscription lives on the dashboard
    endpoint (joined with meter spend)."""
    db = request.app.state.db
    members = db.list_tenant_members(tenant_id)
    agents = db.list_tenant_agents(tenant_id)
    pending_invites = db.list_pending_invites(tenant_id)
    return {
        "tenant": _tenant_out(ctx.tenant, role=ctx.role),
        "members": [
            {
                "user_id": m["user_id"],
                "email": m["email"],
                "full_name": m["full_name"],
                "role": m["role"],
                "joined_at": m["joined_at"].isoformat() if m.get("joined_at") else None,
            }
            for m in members
        ],
        "agents": [
            {
                "agent_id": a["agent_id"],
                "agent_name": a["agent_name"],
                "agent_gender": a["agent_gender"],
                "status": a["status"],
            }
            for a in agents
        ],
        "pending_invites": [
            {
                "id": i["id"],
                "email": i["email"],
                "role": i["role"],
                "expires_at": i["expires_at"].isoformat() if i.get("expires_at") else None,
            }
            for i in pending_invites
        ],
    }


@router.patch("/{tenant_id}")
async def update_tenant_route(
    tenant_id: int,
    body: TenantPatch,
    request: Request,
    ctx: TenantContext = Depends(require_tenant_role("admin")),
) -> dict[str, Any]:
    db = request.app.state.db
    fields: dict[str, Any] = {}
    if body.name is not None:
        fields["name"] = body.name
    if body.billing_email is not None:
        fields["billing_email"] = body.billing_email
    if not fields:
        return _tenant_out(ctx.tenant, role=ctx.role)
    updated = db.update_tenant(tenant_id, **fields)
    return _tenant_out(updated, role=ctx.role)


@router.delete("/{tenant_id}", status_code=204)
async def delete_tenant_route(
    tenant_id: int,
    request: Request,
    ctx: TenantContext = Depends(require_tenant_role("owner")),
) -> None:
    """Soft-delete a tenant. Enforces the last-tenant invariant: an
    owner must always own at least one other tenant, otherwise delete
    is blocked with 409. Downstream code always assumes
    `user.tenants.length >= 1` so we never leave a user orphaned."""
    db = request.app.state.db
    if db.count_user_owned_tenants(ctx.user_id) <= 1:
        raise HTTPException(
            status_code=409,
            detail={
                "error": "last_tenant",
                "hint": "create another workspace before deleting this one",
            },
        )
    db.soft_delete_tenant(tenant_id)
    logger.info("tenant soft-deleted id=%s by user=%s", tenant_id, ctx.user_id)


@router.post("/{tenant_id}/transfer-owner")
async def transfer_owner_route(
    tenant_id: int,
    body: TransferOwner,
    request: Request,
    ctx: TenantContext = Depends(require_tenant_role("owner")),
) -> dict[str, Any]:
    """Transfer ownership to another existing member. The old owner is
    demoted to admin in the same transaction (partial unique index on
    role='owner' allows this via the demote-then-promote ordering inside
    db.transfer_tenant_owner)."""
    db = request.app.state.db
    try:
        db.transfer_tenant_owner(tenant_id, body.new_owner_user_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"error": str(exc)})
    return {"tenant_id": tenant_id, "new_owner_user_id": body.new_owner_user_id}


# ─── Members ────────────────────────────────────────────────────────────


@router.get("/{tenant_id}/members")
async def list_members(
    tenant_id: int,
    request: Request,
    ctx: TenantContext = Depends(get_active_tenant_member),
) -> dict[str, Any]:
    db = request.app.state.db
    members = db.list_tenant_members(tenant_id)
    return {
        "members": [
            {
                "user_id": m["user_id"],
                "email": m["email"],
                "full_name": m["full_name"],
                "role": m["role"],
                "joined_at": m["joined_at"].isoformat() if m.get("joined_at") else None,
            }
            for m in members
        ]
    }


@router.patch("/{tenant_id}/members/{user_id}")
async def change_member_role(
    tenant_id: int,
    user_id: int,
    body: MemberRoleChange,
    request: Request,
    ctx: TenantContext = Depends(require_tenant_role("owner")),
) -> dict[str, Any]:
    db = request.app.state.db
    if user_id == ctx.tenant["owner_user_id"]:
        raise HTTPException(
            status_code=400,
            detail={"error": "cannot_demote_owner_use_transfer"},
        )
    try:
        updated = db.set_member_role(tenant_id, user_id, body.role)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"error": str(exc)})
    if updated is None:
        raise HTTPException(status_code=404, detail={"error": "member_not_found"})
    return {"user_id": user_id, "role": updated["role"]}


@router.delete("/{tenant_id}/members/{user_id}", status_code=204)
async def remove_member(
    tenant_id: int,
    user_id: int,
    request: Request,
    ctx: TenantContext = Depends(require_tenant_role("admin")),
) -> None:
    db = request.app.state.db
    if user_id == ctx.tenant["owner_user_id"]:
        raise HTTPException(
            status_code=400,
            detail={"error": "cannot_remove_owner"},
        )
    db.remove_tenant_member(tenant_id, user_id)


# ─── Invites ────────────────────────────────────────────────────────────


@router.post("/{tenant_id}/invites", status_code=201)
async def create_invite_route(
    tenant_id: int,
    body: InviteCreate,
    request: Request,
    ctx: TenantContext = Depends(require_tenant_role("admin")),
) -> dict[str, Any]:
    """Create a tenant invite + send the email via Resend.

    The raw token is returned in the response (one-time) so the inviter
    can copy the link manually if the email fails to send. This is our
    belt-and-suspenders against Resend outages: every invite is always
    shareable even if email is down.
    """
    db = request.app.state.db
    expires_at = datetime.now(timezone.utc) + timedelta(days=7)
    invite_row, raw_token = db.create_invite(
        tenant_id=tenant_id,
        email=body.email,
        role=body.role,
        invited_by=ctx.user_id,
        expires_at=expires_at,
    )

    # Build the accept URL — the frontend serves /invites/accept as a
    # public route that reads ?token=... and calls POST /api/invites/accept.
    import os
    app_base = os.environ.get("APP_PUBLIC_URL", "https://app.agentiko.io").rstrip("/")
    accept_url = f"{app_base}/invites/accept?token={raw_token}"

    # Email send is best-effort — DB row always exists so the inviter
    # can fall back to copy-link on the frontend.
    email_sent = False
    email_error: str | None = None
    try:
        from services.email import send_invite_email

        await send_invite_email(
            to=body.email,
            tenant_name=ctx.tenant["name"],
            inviter_name=ctx.user.get("full_name") or ctx.user["email"],
            role=body.role,
            accept_url=accept_url,
        )
        email_sent = True
    except Exception as exc:  # noqa: BLE001
        logger.warning("invite email send failed: %s", exc)
        email_error = str(exc)

    return {
        "invite": {
            "id": invite_row["id"],
            "email": invite_row["email"],
            "role": invite_row["role"],
            "expires_at": invite_row["expires_at"].isoformat(),
        },
        "accept_url": accept_url,
        "email_sent": email_sent,
        "email_error": email_error,
    }


@router.get("/{tenant_id}/invites")
async def list_invites(
    tenant_id: int,
    request: Request,
    ctx: TenantContext = Depends(require_tenant_role("admin")),
) -> dict[str, Any]:
    db = request.app.state.db
    rows = db.list_pending_invites(tenant_id)
    return {
        "invites": [
            {
                "id": r["id"],
                "email": r["email"],
                "role": r["role"],
                "created_at": r["created_at"].isoformat() if r.get("created_at") else None,
                "expires_at": r["expires_at"].isoformat() if r.get("expires_at") else None,
            }
            for r in rows
        ]
    }


@router.delete("/{tenant_id}/invites/{invite_id}", status_code=204)
async def revoke_invite_route(
    tenant_id: int,
    invite_id: int,
    request: Request,
    ctx: TenantContext = Depends(require_tenant_role("admin")),
) -> None:
    db = request.app.state.db
    db.revoke_invite(invite_id)


# ─── Tenant-scoped agents ───────────────────────────────────────────────


@router.get("/{tenant_id}/agents")
async def list_agents(
    tenant_id: int,
    request: Request,
    ctx: TenantContext = Depends(get_active_tenant_member),
) -> dict[str, Any]:
    db = request.app.state.db
    agents = db.list_tenant_agents(tenant_id)
    return {
        "agents": [
            {
                "agent_id": a["agent_id"],
                "agent_name": a["agent_name"],
                "agent_gender": a["agent_gender"],
                "status": a["status"],
                "gateway_url": a["gateway_url"],
            }
            for a in agents
        ]
    }


class AgentCreate(BaseModel):
    # agent_name is the agent's display name (Hebrew or otherwise).
    # We slug it + tenant_id into the DB agent_id to guarantee uniqueness.
    agent_name: str = Field(..., min_length=1, max_length=40)
    agent_gender: str = Field("", max_length=20)
    phone: str = Field(..., min_length=6, max_length=30)
    user_name: str = Field("", max_length=60)
    tts_voice_name: str | None = None


@router.post("/{tenant_id}/agents", status_code=201)
async def provision_agent(
    tenant_id: int,
    body: AgentCreate,
    request: Request,
    ctx: TenantContext = Depends(require_tenant_role("admin")),
) -> dict[str, Any]:
    """Spawn a real OpenClaw container in an existing tenant.

    Calls the provisioner (MockProvisioner locally, VmHttpProvisioner on
    Cloud Run), which shells out to the VM's create-agent.sh via the
    provision-api.py daemon. The agent_id is derived from the tenant +
    a slug of the agent name so collisions across tenants are impossible.
    """
    import re
    import secrets as _secrets

    db = request.app.state.db

    # Build a DB-safe agent_id: slugged agent_name + short random suffix
    # keyed to tenant so different tenants can reuse "barber" / "reception"
    # without colliding.
    slug = re.sub(r"[^a-z0-9-]+", "-", body.agent_name.lower()).strip("-") or "agent"
    suffix = _secrets.token_hex(2)
    agent_id = f"t{tenant_id}-{slug}-{suffix}"

    provisioner = request.app.state.provisioner
    result = provisioner.provision(
        agent_id=agent_id,
        phone=body.phone,
        agent_name=body.agent_name,
        user_name=body.user_name or ctx.user.get("full_name") or "",
        tenant_id=tenant_id,
    )
    if not result.success:
        raise HTTPException(
            status_code=502,
            detail={"error": "provision_failed", "message": result.error},
        )

    # Stamp optional fields that the provisioner doesn't thread through
    # the Protocol (tts_voice_name, agent_gender). Same pattern the
    # onboarding flow uses — done as a plain UPDATE after the row exists.
    if body.tts_voice_name:
        db._execute(  # noqa: SLF001 — private helper on the same repo
            "UPDATE agents SET tts_voice_name = %s WHERE agent_id = %s",
            (body.tts_voice_name, result.agent_id),
        )
    if body.agent_gender:
        db._execute(  # noqa: SLF001
            """
            UPDATE app_user_agents_legacy SET agent_gender = %s
             WHERE agent_id = %s
            """,
            (body.agent_gender, result.agent_id),
        )

    # Register the user→agent legacy link via the compat view so the
    # existing admin panel joins keep working. The INSTEAD OF INSERT
    # trigger redirects this to app_user_agents_legacy.
    try:
        db.create_user_agent(
            user_id=ctx.user_id,
            agent_id=result.agent_id,
            agent_name=body.agent_name,
            agent_gender=body.agent_gender,
        )
    except Exception:  # noqa: BLE001
        # Non-fatal — the real agent exists, the legacy link is just
        # metadata for admin reads during the Phase 3 transition.
        logger.warning("create_user_agent link failed for %s", result.agent_id)

    return {
        "agent_id": result.agent_id,
        "gateway_url": result.gateway_url,
        "port": result.port,
        "status": "active",
    }
