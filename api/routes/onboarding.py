"""Onboarding routes — collect user/agent details, provision agent."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from api.deps import get_current_user

router = APIRouter(prefix="/onboarding", tags=["onboarding"])
logger = logging.getLogger(__name__)


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
    """Stream NDJSON progress from the provisioner, mirroring the shape
    of /tenants/{id}/agents so the two flows share a single real-progress
    UI on the frontend. Pre-flight validation + DB writes happen before
    the stream opens so the user sees an immediate HTTP error instead of
    a stream that closes without ever emitting a progress tick.
    """
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

    provisioner = request.app.state.provisioner
    agent_id = f"agent-{user['id']}-{body.agent_name.replace(' ', '-').lower()}"
    user_name = body.full_name or user["full_name"]

    async def event_stream():
        vm_result: dict[str, Any] | None = None

        # Forward progress from the VM daemon and capture the final
        # result so we can do post-provision DB work before telling the
        # browser we're done. Total steps: 4 from the VM + an optional
        # 5th for the welcome-template send when the agent has a phone
        # (matches routes/tenants.py so both flows animate identically).
        total_steps = 5 if phone else 4
        try:
            async for event in provisioner.provision_stream(
                agent_id=agent_id,
                phone=phone or "",
                agent_name=body.agent_name,
                user_name=user_name,
                tenant_id=tenant["id"],
                bot_gender=body.agent_gender,
                # Onboarding already collects user gender for the app_users
                # row above; forward it so create-agent.sh can persist it
                # for Hebrew conjugation in the agent's workspace.
                user_gender=body.gender,
                tts_voice_name=body.tts_voice_name or "",
            ):
                if event.get("type") == "result":
                    vm_result = event
                else:
                    if event.get("type") == "progress":
                        event["total"] = total_steps
                    yield json.dumps(event) + "\n"
        except Exception as exc:  # noqa: BLE001
            logger.exception("onboarding provision_stream failed for %s", agent_id)
            yield json.dumps({
                "type": "result",
                "success": False,
                "error": f"provision_stream error: {exc}",
            }) + "\n"
            return

        if vm_result is None or not vm_result.get("success"):
            yield json.dumps({
                "type": "result",
                "success": False,
                "error": (vm_result or {}).get("error", "provision_failed"),
            }) + "\n"
            return

        result_agent_id = vm_result.get("agent_id") or agent_id

        # Welcome-message step is only meaningful when WhatsApp is bound.
        # Skip entirely when onboarding without a phone so the progress
        # bar ends cleanly at 4/4 instead of a ghost "sending to nobody"
        # tick (mirrors routes/tenants.py:768-792).
        if phone:
            yield json.dumps({
                "type": "progress",
                "step": 5,
                "total": 5,
                "label": "Sending welcome message",
            }) + "\n"

            whatsapp = request.app.state.whatsapp
            try:
                await asyncio.wait_for(
                    asyncio.to_thread(
                        whatsapp.send_welcome, phone, body.agent_name, body.agent_gender
                    ),
                    timeout=15.0,
                )
            except Exception:  # noqa: BLE001
                # Non-fatal — agent is live regardless of welcome send
                logger.warning("welcome send errored for %s", result_agent_id, exc_info=True)

        # Only mark onboarding complete after a successful provision. If
        # we flipped this before the stream we'd leave the user in a
        # "complete but no agent" state on any mid-stream failure.
        db.update_user(user["id"], onboarding_status="complete")

        yield json.dumps({
            "type": "result",
            "success": True,
            "agent_id": result_agent_id,
            "gateway_url": vm_result.get("gateway_url") or "",
            "port": vm_result.get("port") or 0,
            "status": "active",
            "tenant_id": tenant["id"],
        }) + "\n"

    return StreamingResponse(event_stream(), media_type="application/x-ndjson")
