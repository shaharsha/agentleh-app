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

    if user["onboarding_status"] not in ("payment_done", "pending"):
        raise HTTPException(status_code=400, detail="Already onboarded or payment required")

    # Update user profile
    db.update_user(
        user["id"],
        full_name=body.full_name or user["full_name"],
        phone=body.phone,
        gender=body.gender,
    )

    # Provision agent (mocked)
    provisioner = request.app.state.provisioner
    agent_id = f"agent-{user['id']}-{body.agent_name.replace(' ', '-').lower()}"

    result = provisioner.provision(
        agent_id=agent_id,
        phone=body.phone,
        agent_name=body.agent_name,
        user_name=body.full_name or user["full_name"],
    )

    if not result.success:
        raise HTTPException(status_code=500, detail=f"Provisioning failed: {result.error}")

    # Create user-agent link
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

    return {"agent_id": result.agent_id, "status": "active", "agent": user_agent}
