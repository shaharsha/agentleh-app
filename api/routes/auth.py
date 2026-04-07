"""Auth routes — sync user from Supabase JWT, get profile."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from api.deps import get_current_user

router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/me")
async def me(user: dict = Depends(get_current_user)):
    return {
        "id": user["id"],
        "email": user["email"],
        "full_name": user["full_name"],
        "phone": user["phone"],
        "gender": user["gender"],
        "onboarding_status": user["onboarding_status"],
    }


@router.post("/sync")
async def sync(user: dict = Depends(get_current_user)):
    return {
        "id": user["id"],
        "email": user["email"],
        "full_name": user["full_name"],
        "onboarding_status": user["onboarding_status"],
    }
