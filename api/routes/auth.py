"""Auth routes — sync user from Supabase JWT, get profile."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from api.deps import get_current_user

router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/me")
async def me(request: Request, user: dict = Depends(get_current_user)):
    """Profile + tenant memberships.

    The tenants list is included here (rather than requiring a separate
    GET /api/tenants call) so the frontend can make its post-login
    routing decision from a single request: 0 tenants → onboarding,
    1 → tenant dashboard, >1 → tenant picker with cached default.
    """
    db = request.app.state.db
    tenants = db.list_user_tenants(user["id"])
    return {
        "id": user["id"],
        "email": user["email"],
        "full_name": user["full_name"],
        "phone": user["phone"],
        "gender": user["gender"],
        "onboarding_status": user["onboarding_status"],
        "role": user.get("role", "user"),
        "tenants": [
            {
                "id": t["id"],
                "slug": t["slug"],
                "name": t["name"],
                "name_base": t.get("name_base"),
                "role": t["role"],
                "owner_user_id": t["owner_user_id"],
            }
            for t in tenants
        ],
        "default_tenant_id": tenants[0]["id"] if tenants else None,
    }


@router.post("/sync")
async def sync(user: dict = Depends(get_current_user)):
    return {
        "id": user["id"],
        "email": user["email"],
        "full_name": user["full_name"],
        "onboarding_status": user["onboarding_status"],
    }
