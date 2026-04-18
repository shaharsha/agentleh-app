"""Onboarding routes — collect user/agent details, provision agent."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from api.deps import get_current_user

router = APIRouter(prefix="/onboarding", tags=["onboarding"])


class OnboardingSubmit(BaseModel):
    full_name: str = ""
    # Phone is optional — mirrors the standalone agent-create flow in
    # routes/tenants.py. When omitted, the agent is provisioned without a
    # WhatsApp binding and the user can connect one later from the Bridges
    # panel.
    phone: str | None = None
    gender: str
    agent_name: str
    agent_gender: str
    # Optional — if the onboarding UI's voice picker was skipped (e.g. older
    # client), we fall back to the DB column default ('Kore'). The new
    # picker sends this field populated with whichever voice the user chose
    # from the manifest at /api/voices/manifest.
    tts_voice_name: str | None = None


@router.post("/submit")
async def submit(
    body: OnboardingSubmit,
    request: Request,
    user: dict = Depends(get_current_user),
):
    db = request.app.state.db

    # Onboarding state machine after the coupon migration:
    #   pending      → no plan, no agent → must redeem before onboarding
    #   plan_active  → plan active, no agent → submit creates the agent
    #   complete     → at least one agent exists
    # We accept plan_active here. `pending` means the user hasn't redeemed
    # a coupon yet; the frontend should not have surfaced this form, but
    # we reject explicitly with the correct error so the UX can recover.
    if user["onboarding_status"] == "pending":
        raise HTTPException(
            status_code=402,
            detail={
                "error": "no_active_subscription",
                "message_he": "יש להפעיל תוכנית לפני הקמת סוכן",
            },
        )
    if user["onboarding_status"] not in ("plan_active",):
        raise HTTPException(status_code=400, detail="Already onboarded")

    # Update user profile. Only overwrite phone when the caller actually
    # provided one — otherwise keep whatever is already on the app_users
    # row so an optional-phone onboarding can't blank out a phone the user
    # already gave us through another path.
    phone = (body.phone or "").strip() or None
    update_fields: dict[str, str] = {
        "full_name": body.full_name or user["full_name"],
        "gender": body.gender,
    }
    if phone:
        update_fields["phone"] = phone
    db.update_user(user["id"], **update_fields)

    # Ensure a default tenant exists before provisioning. ensure_default_tenant
    # is idempotent — if the user already has a tenant (e.g., they were invited
    # into someone else's workspace before doing their own onboarding), we
    # create their personal one anyway so `default_tenant_id` is stable.
    fresh_user = db.get_user_by_id(user["id"]) or user
    tenant = db.ensure_default_tenant(fresh_user["id"])

    # Provision agent (mocked on dev; VmHttpProvisioner on prod once wired).
    # The provisioner is responsible for inserting into `agents` with
    # tenant_id=tenant["id"] — create_agent.sh on the VM does this via its
    # new --tenant-id flag. MockProvisioner needs the same treatment.
    import asyncio

    provisioner = request.app.state.provisioner
    agent_id = f"agent-{user['id']}-{body.agent_name.replace(' ', '-').lower()}"

    result = await asyncio.to_thread(
        provisioner.provision,
        agent_id=agent_id,
        phone=phone or "",
        agent_name=body.agent_name,
        user_name=body.full_name or user["full_name"],
        tenant_id=tenant["id"],
        bot_gender=body.agent_gender,
        # Onboarding already collects user gender for the app_users row
        # above (db.update_user gender=body.gender). Forward it to the
        # provisioner too so create-agent.sh can store it in the agent's
        # OpenClaw workspace for Hebrew personalization.
        user_gender=body.gender,
        tts_voice_name=body.tts_voice_name or "",
    )

    if not result.success:
        raise HTTPException(status_code=500, detail=f"Provisioning failed: {result.error}")

    # Welcome message only makes sense when WhatsApp is actually wired up —
    # skip when the agent was provisioned without a phone so we don't send
    # a template to nobody (mirrors routes/tenants.py:768-792).
    if phone:
        whatsapp = request.app.state.whatsapp
        whatsapp.send_welcome(phone, body.agent_name, body.agent_gender)

    # Mark onboarding complete
    db.update_user(user["id"], onboarding_status="complete")

    return {
        "agent_id": result.agent_id,
        "status": "active",
        "agent": {
            "agent_id": result.agent_id,
            "agent_name": body.agent_name,
            "agent_gender": body.agent_gender,
            "status": "active",
        },
        "tenant_id": tenant["id"],
    }
