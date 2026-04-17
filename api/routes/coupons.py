"""User-facing coupon endpoints: redeem and preview.

The redeem endpoint is the only path that can activate a plan on a
tenant in the no-Stripe era. It calls into ``app.lib.coupons.redeem``
which atomically validates the coupon, computes the supersession
schedule, inserts the new ``agent_subscriptions`` row, and writes the
audit row.

Both endpoints require an authenticated user and verify the caller is
``owner|admin`` on the target tenant. Preview is read-only and used
by the redemption page to show the user what they're about to commit
to before they click Redeem.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from api.deps import TenantContext, get_current_user, require_tenant_role
from lib import coupons as coupons_lib

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/coupons", tags=["coupons"])


# ─── Rate limit ────────────────────────────────────────────────────────
# Tiny in-memory token-leak per user_id. The point isn't to stop a
# determined attacker — codes have ~60 bits of entropy so blind guessing
# is impractical anyway — it's to keep noisy /preview probes from a
# buggy frontend or a curious user from hammering the DB. Per-process is
# fine because Cloud Run prod is single-instance always-on for the app.

_RATE_BUCKETS: dict[int, deque[float]] = defaultdict(deque)
_RATE_WINDOW_SEC = 60.0
_RATE_LIMIT = 30  # 30 attempts/min per user — well above any legit UI rate


def _check_rate(user_id: int) -> None:
    now = time.monotonic()
    bucket = _RATE_BUCKETS[user_id]
    while bucket and (now - bucket[0]) > _RATE_WINDOW_SEC:
        bucket.popleft()
    if len(bucket) >= _RATE_LIMIT:
        raise HTTPException(
            status_code=429,
            detail={"error": "rate_limited", "retry_after_sec": int(_RATE_WINDOW_SEC)},
        )
    bucket.append(now)


# ─── Error mapper ──────────────────────────────────────────────────────


def _raise_for(exc: coupons_lib.CouponError) -> None:
    """Map our typed coupon errors to HTTPException with consistent shape."""
    raise HTTPException(
        status_code=exc.http_status,
        detail={"error": exc.code, **exc.detail},
    )


# ─── Schemas ───────────────────────────────────────────────────────────


class RedeemRequest(BaseModel):
    code: str = Field(..., min_length=1, max_length=64)
    # Optional on first-time redemption: if the user has no tenant yet
    # (the default-tenant create normally happens inside onboarding/submit),
    # we lazily create it here so the user can redeem before they've
    # touched the agent-onboarding form.
    tenant_id: int | None = None


class PreviewRequest(BaseModel):
    code: str = Field(..., min_length=1, max_length=64)
    tenant_id: int | None = None


# ─── Routes ────────────────────────────────────────────────────────────


@router.post("/redeem")
async def redeem_route(
    body: RedeemRequest,
    request: Request,
    user: dict = Depends(get_current_user),
):
    """Redeem a coupon to activate / extend / upgrade a plan on a tenant.

    Caller must be ``owner|admin`` on the tenant. The supersession
    decision (immediate vs. queued vs. supersede) is made server-side
    based on the tenant's current active sub and the coupon's plan tier;
    the response includes the resolved schedule so the UI can show an
    accurate "your plan starts on X / ends on Y" message.
    """
    _check_rate(user["id"])

    db = request.app.state.db

    # Resolve target tenant. If the caller passed a tenant_id, verify
    # they're owner/admin on it. If they didn't, auto-resolve to their
    # default — and lazily create it if they're a brand-new user with
    # no tenants yet (onboarding-first redemption case).
    if body.tenant_id is not None:
        membership = db.get_tenant_membership(body.tenant_id, user["id"])
        if membership is None or membership["role"] not in ("owner", "admin"):
            raise HTTPException(
                status_code=404,  # 404 not 403 — don't leak tenant existence
                detail={"error": "tenant_not_found"},
            )
        tenant_id = body.tenant_id
    else:
        owned = db.list_user_tenants(user["id"])
        owned_as_owner_or_admin = [t for t in owned if t["role"] in ("owner", "admin")]
        if owned_as_owner_or_admin:
            tenant_id = owned_as_owner_or_admin[0]["id"]
        else:
            tenant = db.ensure_default_tenant(user["id"])
            tenant_id = tenant["id"]

    try:
        result = await asyncio.to_thread(
            coupons_lib.redeem,
            db,
            user_id=user["id"],
            tenant_id=tenant_id,
            code=body.code,
        )
    except coupons_lib.CouponError as exc:
        _raise_for(exc)
    except Exception as exc:  # noqa: BLE001
        logger.exception("redeem_route failed user=%s code=%s", user["id"], body.code)
        raise HTTPException(status_code=500, detail={"error": "internal", "message": str(exc)})

    # Flip onboarding status forward if the user is still on `pending`.
    # First successful redemption means they have a plan now → next step
    # is provisioning their first agent (state 'plan_active'). The
    # OnboardingPage gate reads this to know what to show.
    if user.get("onboarding_status") == "pending":
        db.update_user(user["id"], onboarding_status="plan_active")

    return {"redemption": result.to_dict()}


@router.post("/preview")
async def preview_route(
    body: PreviewRequest,
    request: Request,
    user: dict = Depends(get_current_user),
):
    """Compute (without persisting) what redeem would do.

    Used by the redemption page to render "this code grants עסקי for
    30 days" before the user commits. Same auth + rate-limit as redeem,
    plus an optional ``tenant_id`` so the schedule projection (renewal /
    upgrade / queued) is accurate when the user has already chosen a
    target tenant in the UI.
    """
    _check_rate(user["id"])

    db = request.app.state.db
    if body.tenant_id is not None:
        membership = db.get_tenant_membership(body.tenant_id, user["id"])
        if membership is None or membership["role"] not in ("owner", "admin"):
            raise HTTPException(status_code=404, detail={"error": "tenant_not_found"})

    try:
        result = await asyncio.to_thread(
            coupons_lib.preview,
            db,
            code=body.code,
            user_id=user["id"],
            tenant_id=body.tenant_id,
        )
    except coupons_lib.CouponError as exc:
        _raise_for(exc)

    return result


@router.get("/me/redemptions")
async def my_redemptions(
    request: Request,
    user: dict = Depends(get_current_user),
):
    """The caller's own redemption history. Useful for a future
    'Billing' tab in the user profile."""
    db = request.app.state.db
    rows = db.list_user_redemptions(user["id"])
    return {"redemptions": rows}
