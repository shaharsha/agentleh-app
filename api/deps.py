"""FastAPI dependencies."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from api.auth import decode_supabase_jwt
from lib.db import AuthError

_bearer = HTTPBearer()

# Role hierarchy for require_tenant_role — 'higher' role satisfies all
# 'lower' requirements. Superadmin bypasses every tenant role check but
# still passes through get_active_tenant_member so request.state.tenant
# is always populated for downstream handlers.
_ROLE_ORDER = {"member": 0, "admin": 1, "owner": 2, "superadmin": 3}


@dataclass
class TenantContext:
    """Carried on every tenant-scoped request. `role` is the effective
    role (highest of the caller's membership role + 'superadmin' if the
    underlying app_user has that global role). `user` is the app_users
    row; `tenant` is the tenants row."""

    tenant: dict[str, Any]
    user: dict[str, Any]
    role: str

    @property
    def tenant_id(self) -> int:
        return int(self.tenant["id"])

    @property
    def user_id(self) -> int:
        return int(self.user["id"])


def get_db(request: Request):
    return request.app.state.db


async def get_current_user(
    request: Request,
    creds: HTTPAuthorizationCredentials = Depends(_bearer),
) -> dict[str, Any]:
    """Decode Supabase JWT → resolve active app_users row → return user dict.

    Revoked-account protection: a valid JWT on its own is not enough. The
    DB gate below distinguishes three cases — active user (return the row),
    first-time login (insert and return), and a soft-deleted or
    email-conflicted row (raise a typed AuthError, translated here to a
    structured HTTPException). Before this change the call was an
    unconditional UPSERT, which meant a JWT issued before a user was
    deleted could silently resurrect them.

    All error responses use the dict `{error, message, message_he}` shape
    the frontend's error-mapping layer expects. Raw string-detail 401/500s
    would cascade through `_couponCall` and surface as a generic
    "coupon_error" in the UI.
    """
    try:
        payload = decode_supabase_jwt(creds.credentials)
    except ValueError as e:
        raise HTTPException(
            status_code=401,
            detail={
                "error": "invalid_token",
                "message": str(e),
                "message_he": "אסימון האימות אינו תקף",
            },
        )

    uid = payload.get("sub")
    email = payload.get("email", "")
    name = payload.get("user_metadata", {}).get("full_name", "")

    if not uid:
        raise HTTPException(
            status_code=401,
            detail={
                "error": "invalid_token",
                "message": "Missing sub in token",
                "message_he": "אסימון האימות אינו תקף",
            },
        )

    db = request.app.state.db
    try:
        user = db.get_user_for_auth(supabase_uid=uid, email=email, full_name=name)
    except AuthError as exc:
        raise HTTPException(
            status_code=exc.http_status,
            detail={
                "error": exc.code,
                "message": exc.message,
                "message_he": exc.message_he,
            },
        )
    return user


def get_active_tenant_member(
    tenant_id: int,
    request: Request,
    user: dict[str, Any] = Depends(get_current_user),
) -> TenantContext:
    """Resolve the caller's role within a tenant-scoped route.

    - Returns 404 (not 403) on non-member access so we don't leak tenant
      existence to probes.
    - Superadmins bypass membership but still get a valid context so
      every handler can use ctx.tenant_id uniformly.
    - The tenant row itself is loaded fresh (not cached) — cheap with the
      tenants_pkey hit and keeps the dashboard reflecting recent renames.
    """
    db = request.app.state.db
    tenant = db.get_tenant_by_id(tenant_id)
    if tenant is None:
        raise HTTPException(status_code=404, detail={"error": "tenant_not_found"})

    membership = db.get_tenant_membership(tenant_id, user["id"])
    if membership is None:
        if user.get("role") == "superadmin":
            return TenantContext(tenant=tenant, user=user, role="superadmin")
        raise HTTPException(status_code=404, detail={"error": "tenant_not_found"})

    return TenantContext(tenant=tenant, user=user, role=membership["role"])


def require_tenant_role(minimum: str):
    """FastAPI dependency factory: require at least `minimum` role on the
    tenant resolved by get_active_tenant_member.

    Usage:
        @router.patch("/tenants/{tenant_id}")
        async def update(
            body: TenantPatch,
            ctx: TenantContext = Depends(require_tenant_role("admin")),
        ): ...
    """
    if minimum not in _ROLE_ORDER:
        raise ValueError(f"unknown role: {minimum}")

    def _dep(ctx: TenantContext = Depends(get_active_tenant_member)) -> TenantContext:
        if _ROLE_ORDER[ctx.role] < _ROLE_ORDER[minimum]:
            raise HTTPException(
                status_code=403,
                detail={"error": "insufficient_role", "required": minimum, "actual": ctx.role},
            )
        return ctx

    return _dep
