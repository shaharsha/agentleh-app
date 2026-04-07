"""Dashboard routes — agent status overview."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from api.deps import get_current_user

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("")
async def dashboard(request: Request, user: dict = Depends(get_current_user)):
    db = request.app.state.db
    agents = db.get_user_agents(user["id"])
    subscription = db.get_subscription(user["id"])

    return {
        "user": {
            "id": user["id"],
            "email": user["email"],
            "full_name": user["full_name"],
            "phone": user["phone"],
            "onboarding_status": user["onboarding_status"],
        },
        "agents": agents,
        "subscription": subscription,
    }
