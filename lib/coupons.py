"""Coupon redemption + plan supersession logic.

A coupon grants ``(plan_id, duration_days)``. Redeeming it activates that
plan on a tenant by inserting a new row into ``agent_subscriptions``. The
meter (which already reads ``agent_subscriptions`` keyed on tenant_id)
picks the active row whose ``[period_start, period_end]`` window contains
``now()`` — so the entire flow plugs into the existing quota path
without changing the meter.

Supersession model
──────────────────
Append-only. Every redemption inserts a new ``agent_subscriptions`` row
plus a ``coupon_redemptions`` audit row. We never UPDATE the plan or the
period of an existing sub — that would corrupt the historical mapping
between ``usage_events`` and the pricing window they were billed against.

Decision matrix when redeeming plan ``P`` (duration ``D``) on a tenant
whose current active sub is ``S_old`` (plan ``P_old``, ends at ``T_end``):

    No active sub                 → period_start = now()                (immediate)
    Same plan (P == P_old)        → period_start = T_end                (renewal queue)
    Upgrade (price(P) > P_old)    → period_start = now(), supersede S_old (immediate switch)
    Downgrade (price(P) < P_old)  → period_start = T_end                (downgrade queue)

Plan ranking is derived from ``billing_plans.price_ils_cents`` — no new
column needed. ``wallet`` ranks below all paid plans because its base
allowance is zero.

Concurrency
───────────
The redeem path takes ``SELECT FOR UPDATE`` row locks on (a) the coupon
row and (b) the tenant's most-recent active sub. Two concurrent redeems
against the same tenant serialize cleanly. The
``coupon_redemptions_one_per_user_idx`` partial unique index is the
backstop for ``one_per_user=TRUE`` coupons in case the in-transaction
check races.
"""

from __future__ import annotations

import logging
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import psycopg

logger = logging.getLogger(__name__)


# ─── Errors ─────────────────────────────────────────────────────────────


class CouponError(Exception):
    """Base for coupon validation/redemption failures.

    Each subclass maps to a specific HTTP status in the route layer.
    Carries an optional ``detail`` dict for the API response body.
    """

    code: str = "coupon_error"
    http_status: int = 400

    def __init__(self, message: str = "", detail: dict[str, Any] | None = None) -> None:
        super().__init__(message or self.code)
        self.detail = detail or {}


class CouponNotFound(CouponError):
    code = "coupon_not_found"
    http_status = 404


class CouponDisabled(CouponError):
    code = "coupon_disabled"
    http_status = 410


class CouponExpired(CouponError):
    code = "coupon_expired"
    http_status = 410


class CouponNotYetValid(CouponError):
    code = "coupon_not_yet_valid"
    http_status = 410


class CouponExhausted(CouponError):
    code = "coupon_exhausted"
    http_status = 410


class CouponAlreadyRedeemed(CouponError):
    code = "coupon_already_redeemed"
    http_status = 409


class InvalidPlan(CouponError):
    code = "invalid_plan"
    http_status = 422


class InvalidDuration(CouponError):
    code = "invalid_duration"
    http_status = 422


# ─── Result ─────────────────────────────────────────────────────────────


@dataclass
class RedeemResult:
    subscription_id: int
    redemption_id: int
    tenant_id: int
    plan_id: str
    period_start: datetime
    period_end: datetime
    is_immediate: bool          # True if the sub takes effect now (no queue)
    superseded_subscription_id: int | None  # set on immediate upgrade

    def to_dict(self) -> dict[str, Any]:
        return {
            "subscription_id": self.subscription_id,
            "redemption_id": self.redemption_id,
            "tenant_id": self.tenant_id,
            "plan_id": self.plan_id,
            "period_start": self.period_start.isoformat(),
            "period_end": self.period_end.isoformat(),
            "is_immediate": self.is_immediate,
            "superseded_subscription_id": self.superseded_subscription_id,
        }


# ─── Code generation ────────────────────────────────────────────────────

# Base32 sans the easily-confused chars (I, L, O, U). 32 symbols give
# log2(32^12) ≈ 60 bits of entropy — random guessing is impractical and
# the route layer additionally rate-limits /preview.
_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"  # 30 chars (multiple of safety)


def generate_code(length: int = 12) -> str:
    """Random uppercase base32-like code, 12 chars by default.

    Avoids the I/L/O/U letters so handwritten codes don't get misread.
    The DB unique index is on ``upper(code)``, so casing in storage
    matches what we generate.
    """
    return "".join(secrets.choice(_CODE_ALPHABET) for _ in range(length))


# ─── Plan tier comparison ───────────────────────────────────────────────


def compare_plan_tier(price_a: int, price_b: int) -> int:
    """Return -1 / 0 / +1 ordering of two plans by price_ils_cents.

    The single source of truth for "is this an upgrade?" — derived from
    the catalog price so adding a new plan tier needs no code change.
    The ``wallet`` plan has price=0 and naturally lands at the bottom.
    """
    if price_a < price_b:
        return -1
    if price_a > price_b:
        return 1
    return 0


# ─── Internal helpers ───────────────────────────────────────────────────


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _normalize_code(code: str) -> str:
    """Strip whitespace, uppercase. The DB index is on upper(code) so
    the exact stored casing doesn't matter for lookups, but keeping the
    in-memory form upper makes log lines + comparisons trivial."""
    return (code or "").strip().upper()


def _validate_coupon_row(row: dict[str, Any], user_id: int, *, db_cur) -> None:
    """Static validation: disabled / expired / exhausted. Per-user
    uniqueness is checked separately because it needs a join.

    All of these map to a 410 Gone (or 409 Conflict for already-redeemed)
    so the user gets a clear "this code can't be used" signal rather
    than a generic 4xx.
    """
    if row["disabled_at"] is not None:
        raise CouponDisabled(detail={"code": row["code"]})

    now = _now()
    if row["valid_from"] is not None and now < row["valid_from"]:
        raise CouponNotYetValid(
            detail={"code": row["code"], "valid_from": row["valid_from"].isoformat()}
        )
    if row["valid_until"] is not None and now > row["valid_until"]:
        raise CouponExpired(
            detail={"code": row["code"], "valid_until": row["valid_until"].isoformat()}
        )

    if (
        row["max_redemptions"] is not None
        and row["redemption_count"] >= row["max_redemptions"]
    ):
        raise CouponExhausted(
            detail={
                "code": row["code"],
                "redemption_count": row["redemption_count"],
                "max_redemptions": row["max_redemptions"],
            }
        )

    if row["one_per_user"]:
        db_cur.execute(
            """
            SELECT 1 FROM coupon_redemptions
             WHERE coupon_id = %s AND user_id = %s
             LIMIT 1
            """,
            (row["id"], user_id),
        )
        if db_cur.fetchone() is not None:
            raise CouponAlreadyRedeemed(detail={"code": row["code"]})


def _exhaustion_behavior(billing_mode: str, allows_overage: bool) -> str:
    if billing_mode == "wallet":
        return "wallet"
    if allows_overage:
        return "allow-overage"
    return "hard-block"


def _compute_schedule(
    *,
    new_plan_row: dict[str, Any],
    duration_days: int,
    current_active: dict[str, Any] | None,
) -> tuple[datetime, datetime, int | None]:
    """Decide period_start, period_end, and which-old-sub-to-supersede.

    Returns (period_start, period_end, superseded_sub_id_or_none).
    See the module docstring for the matrix this implements.
    """
    now = _now()

    if current_active is None:
        period_start = now
        period_end = now + timedelta(days=duration_days)
        return period_start, period_end, None

    new_price = int(new_plan_row["price_ils_cents"])
    old_price = int(current_active["price_ils_cents"])
    cmp = compare_plan_tier(new_price, old_price)
    same_plan = current_active["plan_id"] == new_plan_row["plan_id"]
    old_end: datetime = current_active["period_end"]

    if same_plan or cmp < 0:
        # Renewal (same plan) or downgrade — queue at old period_end.
        period_start = old_end
        period_end = old_end + timedelta(days=duration_days)
        return period_start, period_end, None

    # Upgrade — immediate switch, supersede the running sub.
    period_start = now
    period_end = now + timedelta(days=duration_days)
    return period_start, period_end, int(current_active["id"])


# ─── Lookups (read-only helpers used by routes + redeem()) ─────────────


def get_coupon_by_code(conn, code: str) -> dict[str, Any] | None:
    """Look up a coupon by its (case-insensitive) code. Read-only.

    Used by the /preview endpoint to show the user what they're about
    to redeem, and by redeem() before taking the row lock.
    """
    normalized = _normalize_code(code)
    if not normalized:
        return None
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT c.*, p.name_he AS plan_name_he, p.price_ils_cents,
                   p.billing_mode, p.allows_overage,
                   p.default_overage_cap_micros, p.default_overage_markup_bps,
                   p.base_allowance_micros, p.plan_has_tts
              FROM coupons c
              JOIN billing_plans p ON p.plan_id = c.plan_id
             WHERE upper(c.code) = %s
            """,
            (normalized,),
        )
        row = cur.fetchone()
    return dict(row) if row else None


def get_active_subscription(conn, tenant_id: int) -> dict[str, Any] | None:
    """Mirror of the meter's ``load_active_subscription`` query, scoped to
    a tenant. Read-only. Used by the agent-creation gate, the /preview
    endpoint to render the supersession outcome, and the dashboard.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT s.id, s.tenant_id, s.plan_id, s.status,
                   s.period_start, s.period_end,
                   s.base_allowance_micros, s.used_micros,
                   s.overage_enabled, s.overage_cap_micros, s.overage_used_micros,
                   p.name_he AS plan_name_he,
                   p.price_ils_cents, p.billing_mode, p.allows_overage
              FROM agent_subscriptions s
              JOIN billing_plans p ON p.plan_id = s.plan_id
             WHERE s.tenant_id = %s
               AND s.status = 'active'
               AND now() BETWEEN s.period_start AND s.period_end
             ORDER BY s.period_start DESC
             LIMIT 1
            """,
            (tenant_id,),
        )
        row = cur.fetchone()
    return dict(row) if row else None


# ─── Main entry: redeem() ──────────────────────────────────────────────


def redeem(
    db,
    *,
    user_id: int,
    tenant_id: int,
    code: str | None,
    granted_by_admin: int | None = None,
    plan_id_override: str | None = None,
    duration_days_override: int | None = None,
) -> RedeemResult:
    """Redeem a coupon (or perform a direct admin grant) on a tenant.

    Atomic: validates, computes the schedule, inserts the new
    agent_subscriptions row, optionally supersedes the prior active one,
    inserts the audit row, bumps the coupon's redemption count — all in
    one transaction with row-level locks on the coupon and the prior
    active sub.

    Two modes, mutually exclusive:

    - **Coupon redemption**: ``code`` is set, ``granted_by_admin`` is None.
      Plan/duration come from the coupon row.
    - **Admin grant**: ``code`` is None, ``granted_by_admin`` is the
      superadmin's user_id, and ``plan_id_override`` +
      ``duration_days_override`` are required.

    Raises a ``CouponError`` subclass on validation failures (the route
    layer maps these to the right HTTP status).
    """
    if code is None:
        # Admin grant
        if granted_by_admin is None:
            raise ValueError("granted_by_admin required when code is None")
        if not plan_id_override:
            raise InvalidPlan(detail={"reason": "plan_id_override required for admin grant"})
        if not duration_days_override or duration_days_override <= 0:
            raise InvalidDuration(
                detail={"reason": "duration_days_override required for admin grant"}
            )
    else:
        if granted_by_admin is not None:
            raise ValueError("cannot pass both code and granted_by_admin")

    with db.connect() as conn:
        with conn.cursor() as cur:
            # 1. Lock the coupon row (or skip for admin grant).
            coupon_row: dict[str, Any] | None = None
            plan_id: str
            duration_days: int
            if code is not None:
                normalized = _normalize_code(code)
                cur.execute(
                    """
                    SELECT *
                      FROM coupons
                     WHERE upper(code) = %s
                     FOR UPDATE
                    """,
                    (normalized,),
                )
                coupon_row = cur.fetchone()
                if coupon_row is None:
                    raise CouponNotFound(detail={"code": normalized})
                _validate_coupon_row(dict(coupon_row), user_id, db_cur=cur)
                plan_id = coupon_row["plan_id"]
                duration_days = int(coupon_row["duration_days"])
            else:
                plan_id = plan_id_override  # type: ignore[assignment]
                duration_days = int(duration_days_override)  # type: ignore[arg-type]

            # 2. Load the plan row (catalog source of defaults).
            cur.execute(
                """
                SELECT plan_id, name_he, price_ils_cents, billing_mode,
                       base_allowance_micros, allows_overage,
                       default_overage_cap_micros, default_overage_markup_bps,
                       plan_has_tts
                  FROM billing_plans
                 WHERE plan_id = %s
                """,
                (plan_id,),
            )
            plan_row = cur.fetchone()
            if plan_row is None:
                raise InvalidPlan(detail={"plan_id": plan_id})
            plan = dict(plan_row)

            # 3. Lock the tenant's currently-active sub (if any). We
            # take FOR UPDATE on the latest-by-period_start active sub
            # in the now() window — exactly the row supersession
            # decisions key on. Two concurrent redeems on the same
            # tenant serialize on this row.
            cur.execute(
                """
                SELECT s.id, s.plan_id, s.period_start, s.period_end,
                       p.price_ils_cents
                  FROM agent_subscriptions s
                  JOIN billing_plans p ON p.plan_id = s.plan_id
                 WHERE s.tenant_id = %s
                   AND s.status = 'active'
                   AND now() BETWEEN s.period_start AND s.period_end
                 ORDER BY s.period_start DESC
                 LIMIT 1
                 FOR UPDATE OF s
                """,
                (tenant_id,),
            )
            current_active_row = cur.fetchone()
            current_active = dict(current_active_row) if current_active_row else None

            # 4. Compute the schedule.
            period_start, period_end, supersede_id = _compute_schedule(
                new_plan_row=plan,
                duration_days=duration_days,
                current_active=current_active,
            )

            # 5. Verify the tenant exists (for a clean 404 instead of an
            # FK violation) and insert the new sub row.
            cur.execute(
                """
                SELECT 1 FROM tenants
                 WHERE id = %s AND deleted_at IS NULL
                """,
                (tenant_id,),
            )
            if cur.fetchone() is None:
                raise InvalidPlan(detail={"reason": "tenant_not_found", "tenant_id": tenant_id})

            exhaustion = _exhaustion_behavior(
                plan["billing_mode"], plan["allows_overage"]
            )

            try:
                cur.execute(
                    """
                    INSERT INTO agent_subscriptions (
                        tenant_id, plan_id, status,
                        period_start, period_end, exhaustion_behavior,
                        base_allowance_micros, overage_enabled,
                        overage_cap_micros, overage_markup_bps,
                        plan_has_tts
                    ) VALUES (
                        %s, %s, 'active',
                        %s, %s, %s,
                        %s, %s,
                        %s, %s,
                        %s
                    )
                    RETURNING id
                    """,
                    (
                        tenant_id,
                        plan["plan_id"],
                        period_start,
                        period_end,
                        exhaustion,
                        plan["base_allowance_micros"],
                        plan["allows_overage"],
                        plan["default_overage_cap_micros"],
                        plan["default_overage_markup_bps"],
                        plan["plan_has_tts"],
                    ),
                )
            except psycopg.errors.UniqueViolation as exc:
                # The (tenant_id, period_start) unique index can collide
                # if two redeems land at the exact same microsecond. Vanishingly
                # rare; surface as a generic 409 so the user can retry.
                raise CouponAlreadyRedeemed(
                    detail={"reason": "concurrent_redeem", "tenant_id": tenant_id}
                ) from exc
            new_sub_id = int(cur.fetchone()["id"])

            # 6. Supersede the old active sub on immediate upgrades.
            if supersede_id is not None:
                cur.execute(
                    "UPDATE agent_subscriptions SET status = 'superseded' WHERE id = %s",
                    (supersede_id,),
                )

            # 7. Insert the audit row.
            cur.execute(
                """
                INSERT INTO coupon_redemptions (
                    coupon_id, user_id, tenant_id, subscription_id,
                    plan_id, duration_days, period_start, period_end,
                    granted_by_admin
                ) VALUES (
                    %s, %s, %s, %s,
                    %s, %s, %s, %s,
                    %s
                )
                RETURNING id
                """,
                (
                    coupon_row["id"] if coupon_row else None,
                    user_id,
                    tenant_id,
                    new_sub_id,
                    plan["plan_id"],
                    duration_days,
                    period_start,
                    period_end,
                    granted_by_admin,
                ),
            )
            redemption_id = int(cur.fetchone()["id"])

            # 8. Bump the coupon's redemption count (skip for admin grants).
            if coupon_row is not None:
                cur.execute(
                    "UPDATE coupons SET redemption_count = redemption_count + 1 WHERE id = %s",
                    (coupon_row["id"],),
                )

            conn.commit()

    is_immediate = supersede_id is not None or current_active is None
    logger.info(
        "coupon redeem ok: user=%s tenant=%s plan=%s sub=%s immediate=%s code=%s admin=%s",
        user_id, tenant_id, plan["plan_id"], new_sub_id, is_immediate,
        coupon_row["code"] if coupon_row else "(admin-grant)",
        granted_by_admin,
    )

    return RedeemResult(
        subscription_id=new_sub_id,
        redemption_id=redemption_id,
        tenant_id=tenant_id,
        plan_id=plan["plan_id"],
        period_start=period_start,
        period_end=period_end,
        is_immediate=is_immediate,
        superseded_subscription_id=supersede_id,
    )


# ─── Preview (read-only, used by /preview endpoint + UI) ───────────────


def preview(
    db,
    *,
    code: str,
    user_id: int,
    tenant_id: int | None,
) -> dict[str, Any]:
    """Compute what redeem() WOULD do without persisting anything.

    Returns the coupon details + the projected schedule against the
    tenant's current active sub. Intended for the redemption page so
    the user sees exactly what they're about to commit to.

    All validation runs except the ``one_per_user`` check, which is
    surfaced as a non-fatal flag so the UI can warn but still let the
    user see the coupon details. (If they hit Redeem, the route layer
    will then reject with CouponAlreadyRedeemed.)
    """
    with db.connect() as conn:
        coupon = get_coupon_by_code(conn, code)
        if coupon is None:
            raise CouponNotFound(detail={"code": _normalize_code(code)})

        if coupon["disabled_at"] is not None:
            raise CouponDisabled(detail={"code": coupon["code"]})

        now = _now()
        if coupon["valid_from"] is not None and now < coupon["valid_from"]:
            raise CouponNotYetValid(detail={"code": coupon["code"]})
        if coupon["valid_until"] is not None and now > coupon["valid_until"]:
            raise CouponExpired(detail={"code": coupon["code"]})
        if (
            coupon["max_redemptions"] is not None
            and coupon["redemption_count"] >= coupon["max_redemptions"]
        ):
            raise CouponExhausted(detail={"code": coupon["code"]})

        already_redeemed = False
        if coupon["one_per_user"]:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT 1 FROM coupon_redemptions
                     WHERE coupon_id = %s AND user_id = %s
                     LIMIT 1
                    """,
                    (coupon["id"], user_id),
                )
                already_redeemed = cur.fetchone() is not None

        current_active = (
            get_active_subscription(conn, tenant_id) if tenant_id is not None else None
        )

    plan_view = {
        "plan_id": coupon["plan_id"],
        "name_he": coupon["plan_name_he"],
        "price_ils_cents": int(coupon["price_ils_cents"]),
        "billing_mode": coupon["billing_mode"],
        "base_allowance_micros": int(coupon["base_allowance_micros"]),
        "allows_overage": bool(coupon["allows_overage"]),
        "plan_has_tts": bool(coupon["plan_has_tts"]),
    }

    if current_active is None:
        schedule = {
            "kind": "immediate",
            "period_start": _now().isoformat(),
            "period_end": (_now() + timedelta(days=int(coupon["duration_days"]))).isoformat(),
            "supersedes_subscription_id": None,
        }
    else:
        new_price = int(coupon["price_ils_cents"])
        old_price = int(current_active["price_ils_cents"])
        same_plan = current_active["plan_id"] == coupon["plan_id"]
        cmp = compare_plan_tier(new_price, old_price)
        if same_plan or cmp < 0:
            kind = "renewal" if same_plan else "downgrade_queued"
            ps = current_active["period_end"]
            pe = ps + timedelta(days=int(coupon["duration_days"]))
            schedule = {
                "kind": kind,
                "period_start": ps.isoformat(),
                "period_end": pe.isoformat(),
                "supersedes_subscription_id": None,
            }
        else:
            schedule = {
                "kind": "upgrade_immediate",
                "period_start": _now().isoformat(),
                "period_end": (_now() + timedelta(days=int(coupon["duration_days"]))).isoformat(),
                "supersedes_subscription_id": int(current_active["id"]),
            }

    return {
        "code": coupon["code"],
        "duration_days": int(coupon["duration_days"]),
        "plan": plan_view,
        "schedule": schedule,
        "one_per_user": bool(coupon["one_per_user"]),
        "already_redeemed_by_user": already_redeemed,
        "max_redemptions": coupon["max_redemptions"],
        "redemption_count": int(coupon["redemption_count"]),
    }
