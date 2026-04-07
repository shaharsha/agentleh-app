"""Payment routes — mocked checkout and confirmation."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from api.deps import get_current_user

router = APIRouter(prefix="/payment", tags=["payment"])


class CheckoutRequest(BaseModel):
    plan: str = "starter"


class ConfirmRequest(BaseModel):
    session_id: str = "mock_session"


@router.post("/checkout")
async def checkout(
    body: CheckoutRequest,
    request: Request,
    user: dict = Depends(get_current_user),
):
    payment_service = request.app.state.payment
    result = payment_service.create_checkout(user["id"], body.plan)
    return result


@router.post("/confirm")
async def confirm(
    body: ConfirmRequest,
    request: Request,
    user: dict = Depends(get_current_user),
):
    payment_service = request.app.state.payment
    db = request.app.state.db

    result = payment_service.confirm(user["id"], body.session_id)
    if not result.get("success"):
        raise HTTPException(status_code=400, detail="Payment confirmation failed")

    sub = db.create_subscription(user["id"], plan=result.get("plan", "starter"))
    db.update_user(user["id"], onboarding_status="payment_done")

    return {"subscription": sub}
