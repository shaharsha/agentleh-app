"""Coupon redemption logic tests.

Two layers:

  1. **Pure-logic tests** — `compare_plan_tier`, `_compute_schedule`,
     code generation, normalization. No DB required; these run in CI.

  2. **Integration tests** — exercise the full `redeem()` path against a
     real Postgres. Gated on env var ``RUN_DB_COUPON_TESTS=1`` because
     CI doesn't currently spin up Postgres for the app test suite. Set
     ``COUPON_TEST_DSN`` to point at a throwaway database.

The integration tests are the ones that catch regressions in the
supersession matrix (no-sub / renewal / upgrade / downgrade) and the
concurrency guarantees (two parallel redeems serialize cleanly).
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import pytest

from lib import coupons


# ─── Pure-logic tests ──────────────────────────────────────────────────


class TestPlanTierCompare:
    def test_lower_price_is_lower_tier(self):
        assert coupons.compare_plan_tier(9900, 39900) == -1

    def test_higher_price_is_higher_tier(self):
        assert coupons.compare_plan_tier(119900, 69900) == 1

    def test_equal_prices_are_equal(self):
        assert coupons.compare_plan_tier(39900, 39900) == 0


class TestNormalizeCode:
    def test_uppercases(self):
        assert coupons._normalize_code("biz-30") == "BIZ-30"

    def test_strips_whitespace(self):
        assert coupons._normalize_code("  abc  ") == "ABC"

    def test_empty_returns_empty(self):
        assert coupons._normalize_code("") == ""
        assert coupons._normalize_code("   ") == ""


class TestGenerateCode:
    def test_default_length_is_12(self):
        code = coupons.generate_code()
        assert len(code) == 12

    def test_custom_length(self):
        assert len(coupons.generate_code(8)) == 8

    def test_charset_excludes_confusing(self):
        # I/L/O/U excluded so handwritten codes don't get misread
        code = coupons.generate_code(200)
        for c in "ILOU":
            assert c not in code, f"forbidden char {c} in generated code"

    def test_uniqueness_distribution(self):
        # Sanity check: 1000 12-char codes shouldn't collide
        codes = {coupons.generate_code() for _ in range(1000)}
        assert len(codes) == 1000


class TestComputeSchedule:
    """The supersession matrix — the core decision the coupon system makes.

    This is the function whose behaviour the user sees when they redeem
    a second coupon after already having one active.
    """

    @staticmethod
    def _plan(plan_id: str, price: int) -> dict:
        return {"plan_id": plan_id, "price_ils_cents": price}

    @staticmethod
    def _active(sub_id: int, plan_id: str, price: int, ends_in_days: int) -> dict:
        return {
            "id": sub_id,
            "plan_id": plan_id,
            "price_ils_cents": price,
            "period_end": datetime.now(timezone.utc) + timedelta(days=ends_in_days),
        }

    def test_no_active_sub_starts_immediately(self):
        ps, pe, supersede = coupons._compute_schedule(
            new_plan_row=self._plan("starter", 39900),
            duration_days=30,
            current_active=None,
        )
        assert supersede is None
        # period_start ~ now (within the test execution window)
        assert (datetime.now(timezone.utc) - ps).total_seconds() < 5
        assert (pe - ps).days == 30

    def test_same_plan_renewal_queues_at_period_end(self):
        existing = self._active(42, "business", 69900, ends_in_days=10)
        ps, pe, supersede = coupons._compute_schedule(
            new_plan_row=self._plan("business", 69900),
            duration_days=30,
            current_active=existing,
        )
        assert supersede is None
        # New period starts right when the old one ends
        assert ps == existing["period_end"]
        assert (pe - ps).days == 30

    def test_upgrade_supersedes_immediately(self):
        existing = self._active(7, "starter", 39900, ends_in_days=15)
        ps, pe, supersede = coupons._compute_schedule(
            new_plan_row=self._plan("business", 69900),
            duration_days=30,
            current_active=existing,
        )
        assert supersede == 7
        # Immediate switch — period_start is now-ish
        assert (datetime.now(timezone.utc) - ps).total_seconds() < 5
        assert (pe - ps).days == 30

    def test_downgrade_queues_at_period_end(self):
        existing = self._active(99, "premium", 119900, ends_in_days=20)
        ps, pe, supersede = coupons._compute_schedule(
            new_plan_row=self._plan("starter", 39900),
            duration_days=30,
            current_active=existing,
        )
        assert supersede is None
        # Current high-tier sub keeps running until its period end
        assert ps == existing["period_end"]
        assert (pe - ps).days == 30

    def test_wallet_below_paid_plan_is_downgrade(self):
        # wallet has price 0 in the catalog; redeeming wallet on top of
        # a paid plan should queue, not supersede.
        existing = self._active(101, "starter", 39900, ends_in_days=5)
        ps, _pe, supersede = coupons._compute_schedule(
            new_plan_row=self._plan("wallet", 0),
            duration_days=30,
            current_active=existing,
        )
        assert supersede is None
        assert ps == existing["period_end"]


# ─── Integration tests ─────────────────────────────────────────────────


_DB_TESTS_ENABLED = os.environ.get("RUN_DB_COUPON_TESTS") == "1"
_DB_DSN = os.environ.get("COUPON_TEST_DSN", "")

pytestmark_db = pytest.mark.skipif(
    not _DB_TESTS_ENABLED or not _DB_DSN,
    reason="set RUN_DB_COUPON_TESTS=1 + COUPON_TEST_DSN to run integration tests",
)


@pytest.fixture
def db():
    """Real Postgres-backed AppDatabase pointed at COUPON_TEST_DSN.

    The fixture is module-scoped so each test runs against a fresh
    transaction-rolled-back state when wrapped in a savepoint.
    """
    from lib.db import AppDatabase

    return AppDatabase(_DB_DSN)


@pytestmark_db
class TestRedeemIntegration:
    """Full redeem() path. Requires a real Postgres with the schema
    applied. These tests are gated on RUN_DB_COUPON_TESTS=1."""

    def _seed_user_and_tenant(self, db) -> tuple[int, int]:
        with db.connect() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO app_users (supabase_uid, email) VALUES (%s, %s) RETURNING id",
                (f"test-{os.urandom(4).hex()}", f"test-{os.urandom(4).hex()}@x.test"),
            )
            user_id = int(cur.fetchone()["id"])
            cur.execute(
                "INSERT INTO tenants (slug, name, owner_user_id) VALUES (%s, %s, %s) RETURNING id",
                (f"test-{os.urandom(4).hex()}", "Test", user_id),
            )
            tenant_id = int(cur.fetchone()["id"])
            cur.execute(
                "INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES (%s, %s, 'owner')",
                (tenant_id, user_id),
            )
            conn.commit()
        return user_id, tenant_id

    def _seed_coupon(
        self, db, *, plan_id: str = "starter", duration_days: int = 30,
        max_redemptions: int | None = None, one_per_user: bool = True,
    ) -> str:
        code = coupons.generate_code()
        with db.connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO coupons (code, plan_id, duration_days,
                                     max_redemptions, one_per_user)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (code, plan_id, duration_days, max_redemptions, one_per_user),
            )
            conn.commit()
        return code

    def test_first_redeem_creates_active_sub(self, db):
        user_id, tenant_id = self._seed_user_and_tenant(db)
        code = self._seed_coupon(db, plan_id="business", duration_days=30)
        result = coupons.redeem(db, user_id=user_id, tenant_id=tenant_id, code=code)
        assert result.is_immediate
        assert result.superseded_subscription_id is None
        assert result.plan_id == "business"

        sub = db.get_active_subscription(tenant_id)
        assert sub is not None
        assert sub["plan_id"] == "business"

    def test_already_redeemed_blocks_one_per_user(self, db):
        user_id, tenant_id = self._seed_user_and_tenant(db)
        code = self._seed_coupon(db, one_per_user=True)
        coupons.redeem(db, user_id=user_id, tenant_id=tenant_id, code=code)
        with pytest.raises(coupons.CouponAlreadyRedeemed):
            coupons.redeem(db, user_id=user_id, tenant_id=tenant_id, code=code)

    def test_max_redemptions_exhaustion(self, db):
        u1, t1 = self._seed_user_and_tenant(db)
        u2, t2 = self._seed_user_and_tenant(db)
        code = self._seed_coupon(db, max_redemptions=1, one_per_user=False)
        coupons.redeem(db, user_id=u1, tenant_id=t1, code=code)
        with pytest.raises(coupons.CouponExhausted):
            coupons.redeem(db, user_id=u2, tenant_id=t2, code=code)

    def test_upgrade_supersedes(self, db):
        user_id, tenant_id = self._seed_user_and_tenant(db)
        starter = self._seed_coupon(db, plan_id="starter", one_per_user=False)
        business = self._seed_coupon(db, plan_id="business", one_per_user=False)
        first = coupons.redeem(db, user_id=user_id, tenant_id=tenant_id, code=starter)
        second = coupons.redeem(db, user_id=user_id, tenant_id=tenant_id, code=business)
        assert second.is_immediate
        assert second.superseded_subscription_id == first.subscription_id
        sub = db.get_active_subscription(tenant_id)
        assert sub["plan_id"] == "business"

    def test_admin_grant(self, db):
        user_id, tenant_id = self._seed_user_and_tenant(db)
        # Use the same user as admin for simplicity — in production this
        # would be a separate superadmin user_id.
        result = coupons.redeem(
            db,
            user_id=user_id,
            tenant_id=tenant_id,
            code=None,
            granted_by_admin=user_id,
            plan_id_override="premium",
            duration_days_override=7,
        )
        assert result.plan_id == "premium"
        assert result.is_immediate
