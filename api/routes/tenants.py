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
from fastapi.responses import StreamingResponse
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
    resolving from the caller's perspective (list / detail).

    `name_base` is the raw owner-name source string when this tenant
    was auto-generated at onboarding; NULL once the user renames it.
    The frontend uses it to render per-language default names via the
    <TenantName /> helper. See app/lib/db.py::update_tenant for how
    it's nulled on user rename.
    """
    out = {
        "id": row["id"],
        "slug": row["slug"],
        "name": row["name"],
        "name_base": row.get("name_base"),
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
    db.log_audit(
        tenant_id=tenant["id"],
        actor_user_id=user["id"],
        action="tenant.create",
        target_type="tenant",
        target_id=str(tenant["id"]),
        metadata={"name": tenant["name"], "slug": tenant["slug"]},
    )
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
    active_sub = db.get_active_subscription(tenant_id)
    sub_view = None
    if active_sub is not None:
        sub_view = {
            "id": active_sub["id"],
            "plan_id": active_sub["plan_id"],
            "plan_name_he": active_sub["plan_name_he"],
            "billing_mode": active_sub["billing_mode"],
            "status": active_sub["status"],
            "period_start": active_sub["period_start"].isoformat(),
            "period_end": active_sub["period_end"].isoformat(),
            "base_allowance_micros": int(active_sub["base_allowance_micros"]),
            "used_micros": int(active_sub["used_micros"]),
            "overage_enabled": bool(active_sub["overage_enabled"]),
            "overage_cap_micros": (
                int(active_sub["overage_cap_micros"])
                if active_sub["overage_cap_micros"] is not None else None
            ),
            "overage_used_micros": int(active_sub["overage_used_micros"]),
        }
    return {
        "tenant": _tenant_out(ctx.tenant, role=ctx.role),
        "subscription": sub_view,
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
    before = ctx.tenant
    updated = db.update_tenant(tenant_id, **fields)
    db.log_audit(
        tenant_id=tenant_id,
        actor_user_id=ctx.user_id,
        action="tenant.rename" if "name" in fields else "tenant.update",
        target_type="tenant",
        target_id=str(tenant_id),
        metadata={
            k: {"old": before.get(k), "new": updated.get(k) if updated else None}
            for k in fields
        },
    )
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
    db.log_audit(
        tenant_id=tenant_id,
        actor_user_id=ctx.user_id,
        action="tenant.delete",
        target_type="tenant",
        target_id=str(tenant_id),
        metadata={"name": ctx.tenant.get("name")},
    )
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
    db.log_audit(
        tenant_id=tenant_id,
        actor_user_id=ctx.user_id,
        action="tenant.transfer_owner",
        target_type="user",
        target_id=str(body.new_owner_user_id),
        metadata={
            "old_owner_user_id": ctx.tenant.get("owner_user_id"),
            "new_owner_user_id": body.new_owner_user_id,
        },
    )
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
    previous = db.get_tenant_membership(tenant_id, user_id)
    try:
        updated = db.set_member_role(tenant_id, user_id, body.role)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"error": str(exc)})
    if updated is None:
        raise HTTPException(status_code=404, detail={"error": "member_not_found"})
    db.log_audit(
        tenant_id=tenant_id,
        actor_user_id=ctx.user_id,
        action="member.change_role",
        target_type="user",
        target_id=str(user_id),
        metadata={
            "old_role": previous["role"] if previous else None,
            "new_role": updated["role"],
        },
    )
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
    previous = db.get_tenant_membership(tenant_id, user_id)
    db.remove_tenant_member(tenant_id, user_id)
    db.log_audit(
        tenant_id=tenant_id,
        actor_user_id=ctx.user_id,
        action="member.remove",
        target_type="user",
        target_id=str(user_id),
        metadata={"role_at_removal": previous["role"] if previous else None},
    )


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

    db.log_audit(
        tenant_id=tenant_id,
        actor_user_id=ctx.user_id,
        action="member.invite",
        target_type="invite",
        target_id=str(invite_row["id"]),
        metadata={
            "email": invite_row["email"],
            "role": invite_row["role"],
            "email_sent": email_sent,
        },
    )

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
    db.log_audit(
        tenant_id=tenant_id,
        actor_user_id=ctx.user_id,
        action="invite.revoke",
        target_type="invite",
        target_id=str(invite_id),
    )


# ─── Audit log ─────────────────────────────────────────────────────────


@router.get("/{tenant_id}/audit")
async def list_audit(
    tenant_id: int,
    request: Request,
    limit: int = 100,
    offset: int = 0,
    ctx: TenantContext = Depends(require_tenant_role("admin")),
) -> dict[str, Any]:
    """Time-descending audit feed for this tenant. Visible to admin+
    (owners + admins); members don't see audit history.

    Each row carries the action name, target, metadata, actor (email +
    name for humans, NULL for system-initiated actions), and timestamp.
    """
    db = request.app.state.db
    limit = max(1, min(int(limit), 500))
    offset = max(0, int(offset))
    rows = db.list_tenant_audit(tenant_id, limit=limit, offset=offset)
    return {
        "events": [
            {
                "id": r["id"],
                "actor_user_id": r["actor_user_id"],
                "actor_email": r.get("actor_email"),
                "actor_full_name": r.get("actor_full_name"),
                "action": r["action"],
                "target_type": r.get("target_type"),
                "target_id": r.get("target_id"),
                "metadata": r.get("metadata"),
                "created_at": r["created_at"].isoformat() if r.get("created_at") else None,
            }
            for r in rows
        ],
        "limit": limit,
        "offset": offset,
    }


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


def _normalize_phone_e164(raw: str, default_region: str = "IL") -> str:
    """Parse any reasonable phone input and return it in E.164 (+CCXX…).

    Accepts Israeli local (``050-123-4567``, ``050 1234567``, ``0501234567``)
    and any international format (``+972…``, ``972…`` with any separators,
    or other countries in E.164). Uses Israel as the fallback region when
    no `+` prefix is present, since most Agentiko users are Israeli — a
    US/EU user must include the leading ``+``.

    Raises ``HTTPException(400)`` on unparseable or impossible numbers so
    the caller can surface a clean error to the UI.
    """
    import phonenumbers
    try:
        parsed = phonenumbers.parse(raw, default_region)
    except phonenumbers.NumberParseException as exc:
        raise HTTPException(
            status_code=400,
            detail={"error": "invalid_phone", "message": str(exc)},
        ) from exc
    if not phonenumbers.is_possible_number(parsed) or not phonenumbers.is_valid_number(parsed):
        raise HTTPException(
            status_code=400,
            detail={"error": "invalid_phone", "message": "Not a valid phone number"},
        )
    return phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)


@router.post("/{tenant_id}/agents")
async def provision_agent(
    tenant_id: int,
    body: AgentCreate,
    request: Request,
    ctx: TenantContext = Depends(require_tenant_role("admin")),
) -> StreamingResponse:
    """Spawn a real OpenClaw container in an existing tenant (streaming).

    Returns an NDJSON stream of events so the browser can render real
    progress (not a fake timer). Event shapes:

      {"type": "progress", "step": 1, "total": 4, "label": "Preparing workspace"}
      {"type": "result",   "success": true,  "agent_id": "...", "gateway_url": "...", "port": 18791}
      {"type": "result",   "success": false, "error": "..."}

    The final event is always a "result" — either success or failure.
    """
    import json as _json
    import re
    import secrets as _secrets

    db = request.app.state.db

    # Plan gate: tenant must have an active subscription window covering
    # now() before we'll spend resources on a VM container. The meter
    # would also reject the agent's first request with 402 once it ran,
    # but blocking up-front saves the user from a confusing
    # "your-fresh-agent-can't-talk" experience.
    active_sub = db.get_active_subscription(tenant_id)
    if active_sub is None:
        raise HTTPException(
            status_code=402,
            detail={
                "error": "no_active_subscription",
                # provisionTenantAgent in lib/api.ts surfaces detail.message;
                # the Hebrew copy renders inline in the agent-create modal.
                "message": "יש להפעיל תוכנית כדי ליצור סוכנים",
                "message_en": "Activate a plan before creating agents",
                "redeem_path": f"/tenants/{tenant_id}/redeem",
            },
        )

    # Normalize phone to E.164 before anything touches the DB or the VM.
    # Accepts Israeli local ("050-123-4567") and any international format.
    phone_e164 = _normalize_phone_e164(body.phone)

    # Build a DB-safe agent_id: slugged agent_name + short random suffix
    # keyed to tenant so different tenants can reuse "barber" / "reception"
    # without colliding.
    slug = re.sub(r"[^a-z0-9-]+", "-", body.agent_name.lower()).strip("-") or "agent"
    suffix = _secrets.token_hex(2)
    agent_id = f"t{tenant_id}-{slug}-{suffix}"

    provisioner = request.app.state.provisioner
    user_name = body.user_name or ctx.user.get("full_name") or ""

    async def event_stream():
        vm_result: dict[str, Any] | None = None

        # Forward progress events from the VM daemon, capture the final
        # result so we can do post-provision DB work before telling the
        # browser we're done. The VM emits 4 steps; we add a 5th for the
        # welcome-message send, so rewrite `total` here for consistency.
        try:
            async for event in provisioner.provision_stream(
                agent_id=agent_id,
                phone=phone_e164,
                agent_name=body.agent_name,
                user_name=user_name,
                tenant_id=tenant_id,
                bot_gender=body.agent_gender,
                tts_voice_name=body.tts_voice_name or "",
            ):
                if event.get("type") == "result":
                    vm_result = event
                else:
                    if event.get("type") == "progress":
                        event["total"] = 5
                    yield _json.dumps(event) + "\n"
        except Exception as exc:  # noqa: BLE001
            logger.exception("provision_stream failed for %s", agent_id)
            yield _json.dumps({
                "type": "result",
                "success": False,
                "error": f"provision_stream error: {exc}",
            }) + "\n"
            return

        if vm_result is None or not vm_result.get("success"):
            yield _json.dumps({
                "type": "result",
                "success": False,
                "error": (vm_result or {}).get("error", "provision_failed"),
            }) + "\n"
            return

        # agent_name, bot_gender, and tts_voice_name were persisted
        # atomically by create-agent.sh during the INSERT — no follow-up
        # UPDATE needed. agent_id from the VM result is authoritative.
        result_agent_id = vm_result.get("agent_id") or agent_id

        db.log_audit(
            tenant_id=tenant_id,
            actor_user_id=ctx.user_id,
            action="agent.create",
            target_type="agent",
            target_id=result_agent_id,
            metadata={
                "agent_name": body.agent_name,
                "agent_gender": body.agent_gender,
                "phone": phone_e164,
                "tts_voice_name": body.tts_voice_name,
            },
        )

        # Kick off the WhatsApp template hello message. Emit a progress
        # event so the browser gets a visual tick while the bridge
        # round-trips to Meta, then fire the actual send in a thread so
        # a slow Meta response doesn't block the stream completion.
        yield _json.dumps({
            "type": "progress",
            "step": 5,
            "total": 5,
            "label": "Sending welcome message",
        }) + "\n"

        import asyncio as _asyncio

        whatsapp = request.app.state.whatsapp
        try:
            sent = await _asyncio.wait_for(
                _asyncio.to_thread(whatsapp.send_welcome, phone_e164, body.agent_name),
                timeout=15.0,
            )
            if not sent:
                logger.info("welcome message not sent for agent=%s phone=%s", result_agent_id, phone_e164)
        except Exception:  # noqa: BLE001
            # Non-fatal — agent is live regardless of welcome-message success
            logger.warning("welcome send errored for agent=%s", result_agent_id, exc_info=True)

        yield _json.dumps({
            "type": "result",
            "success": True,
            "agent_id": result_agent_id,
            "gateway_url": vm_result.get("gateway_url") or "",
            "port": vm_result.get("port") or 0,
            "status": "active",
        }) + "\n"

    return StreamingResponse(
        event_stream(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache, no-store, no-transform", "X-Accel-Buffering": "no"},
    )


@router.delete("/{tenant_id}/agents/{agent_id}", status_code=204)
async def delete_agent(
    tenant_id: int,
    agent_id: str,
    request: Request,
    ctx: TenantContext = Depends(require_tenant_role("admin")),
) -> None:
    """Soft-delete an agent: VM cleanup (backup + teardown) then DB tombstone.

    Order: VM first, DB second. If VM cleanup fails, the agent row stays
    active and the user can retry. If DB first, VM resources become
    permanently orphaned.

    The DB step is now a soft delete (``deleted_at`` stamp) — the agent's
    ``usage_events`` and display name survive so the Usage tab can still
    show its historical spend with a "(deleted)" label. See
    ``Db.soft_delete_agent`` for what's preserved vs what's torn down.
    """
    import asyncio

    db = request.app.state.db

    # Verify agent belongs to this tenant and isn't already deleted
    agent_tenant_id = db.get_agent_tenant_id(agent_id)
    if agent_tenant_id is None or agent_tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail={"error": "agent_not_found"})

    # Step 1: VM deprovision (backup to GCS + container teardown)
    provisioner = request.app.state.provisioner
    result = await asyncio.to_thread(provisioner.deprovision, agent_id)
    if not result.success:
        raise HTTPException(
            status_code=502,
            detail={"error": "deprovision_failed", "message": result.error},
        )

    # Step 2: DB soft-delete (tombstone + clear live state)
    db.soft_delete_agent(agent_id)

    db.log_audit(
        tenant_id=tenant_id,
        actor_user_id=ctx.user_id,
        action="agent.delete",
        target_type="agent",
        target_id=agent_id,
        metadata={"backup_path": result.backup_path},
    )

    logger.info(
        "agent deleted agent_id=%s tenant=%s by user=%s backup=%s",
        agent_id,
        tenant_id,
        ctx.user_id,
        result.backup_path,
    )
