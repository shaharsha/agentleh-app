"""Onboarding routes — collect user/agent details, provision agent."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from api.deps import get_current_user

router = APIRouter(prefix="/onboarding", tags=["onboarding"])


class OnboardingSubmit(BaseModel):
    full_name: str = ""
    phone: str
    gender: str
    agent_name: str
    agent_gender: str
    # Optional — if the onboarding UI's voice picker was skipped (e.g. older
    # client), we fall back to the DB column default ('Kore'). The new
    # picker sends this field populated with whichever voice the user chose
    # from the manifest at /api/voices/manifest.
    tts_voice_name: str | None = None


@router.get("/status")
async def status(user: dict = Depends(get_current_user), request: Request = None):
    db = request.app.state.db
    agents = db.get_user_agents(user["id"])
    return {
        "onboarding_status": user["onboarding_status"],
        "user": {
            "full_name": user["full_name"],
            "phone": user["phone"],
            "gender": user["gender"],
        },
        "agents": agents,
    }


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

    # Update user profile
    db.update_user(
        user["id"],
        full_name=body.full_name or user["full_name"],
        phone=body.phone,
        gender=body.gender,
    )

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
        phone=body.phone,
        agent_name=body.agent_name,
        user_name=body.full_name or user["full_name"],
        tenant_id=tenant["id"],
    )

    if not result.success:
        raise HTTPException(status_code=500, detail=f"Provisioning failed: {result.error}")

    # Persist user's voice pick — runs AFTER provisioning so the row
    # already exists. Done as a separate UPDATE (not a provisioner param)
    # because the Protocol is co-owned with the multi-tenancy refactor;
    # adding kwargs there would ripple through every implementation. The
    # agents.tts_voice_name column defaults to 'Kore' (see meter migration
    # 008), so older onboarding clients that don't send the field produce
    # agents with the default voice — no regression.
    if body.tts_voice_name:
        db._execute(
            "UPDATE agents SET tts_voice_name = %s WHERE agent_id = %s",
            (body.tts_voice_name, result.agent_id),
        )

    # Create legacy user-agent link via the compat view (which has an
    # INSTEAD OF INSERT trigger writing to app_user_agents_legacy). Kept
    # through Phase 3 so existing admin dashboard joins keep working.
    user_agent = db.create_user_agent(
        user_id=user["id"],
        agent_id=result.agent_id,
        agent_name=body.agent_name,
        agent_gender=body.agent_gender,
    )

    # Send welcome message (mocked)
    whatsapp = request.app.state.whatsapp
    whatsapp.send_welcome(body.phone, body.agent_name)

    # Mark onboarding complete
    db.update_user(user["id"], onboarding_status="complete")

    return {
        "agent_id": result.agent_id,
        "status": "active",
        "agent": user_agent,
        "tenant_id": tenant["id"],
    }
