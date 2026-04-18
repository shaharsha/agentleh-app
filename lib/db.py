"""App database — users, subscriptions, user-agent links."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import psycopg
from psycopg.rows import dict_row

logger = logging.getLogger(__name__)


class AuthError(Exception):
    """Typed auth-layer errors raised by get_user_for_auth. Carry the
    wire-shape fields the frontend's error dictionary expects so the
    dependency layer can raise HTTPException without having to translate
    codes a second time."""

    code: str = "auth_error"
    http_status: int = 401
    message: str = "Authentication failed"
    message_he: str = "שגיאת אימות"


class AuthAccountRevoked(AuthError):
    """Signed-in Supabase identity maps to an app_users row whose
    deleted_at is set — either by supabase_uid (same uid, soft-deleted)
    or by email collision (different uid, old row soft-deleted). Either
    way the account was revoked; we do not silently resurrect from JWT
    claims. Contact support to restore."""

    code = "account_revoked"
    http_status = 403
    message = "Your account has been deleted. Contact support to restore access."
    message_he = "חשבונך נמחק. לשחזור גישה פנה לתמיכה."


class AuthEmailAlreadyRegistered(AuthError):
    """A live app_users row owns this email under a different
    supabase_uid. Most likely the user deleted + re-created their
    Supabase account with the same address. Rebinding the existing row
    to the new uid is account takeover, so we refuse and send them back
    to sign in with their original auth method."""

    code = "email_already_registered"
    http_status = 409
    message = (
        "This email is already registered under a different sign-in method. "
        "Sign in with your original method (Google, email, etc.)."
    )
    message_he = (
        "כתובת אימייל זו כבר רשומה עם שיטת כניסה אחרת. "
        "היכנס עם שיטת הכניסה המקורית שלך (Google, אימייל וכדומה)."
    )


def _default_tenant_name(name_base: str) -> str:
    """Build a script-appropriate default workspace name.

    Mixing RTL Hebrew with the English "'s workspace" suffix renders
    garbled via the Unicode Bidi Algorithm — the apostrophe-s and the
    word "workspace" get visually reordered around the Hebrew portion
    and the result looks broken even though the character sequence
    is technically correct.

    We detect Hebrew (U+0590..U+05FF) in the name and switch to a
    fully-Hebrew template ("מרחב העבודה של <name>") which reads
    naturally right-to-left. Latin / mixed-non-Hebrew names keep the
    original "<name>'s workspace" template.

    Examples:
        "Shahar Shavit"   -> "Shahar Shavit's workspace"
        "שחר שביט"        -> "מרחב העבודה של שחר שביט"
        "alice"           -> "alice's workspace"
    """
    has_hebrew = any("\u0590" <= c <= "\u05FF" for c in name_base)
    if has_hebrew:
        return f"מרחב העבודה של {name_base}"
    return f"{name_base}'s workspace"


@dataclass
class AppDatabase:
    dsn: str

    def __post_init__(self) -> None:
        self.dsn = str(self.dsn)

    def connect(self):
        return psycopg.connect(self.dsn, row_factory=dict_row)

    def _fetch_one(self, sql: str, params: tuple = ()) -> dict[str, Any] | None:
        with self.connect() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, params)
                row = cur.fetchone()
        return dict(row) if row else None

    def _fetch_all(self, sql: str, params: tuple = ()) -> list[dict[str, Any]]:
        with self.connect() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, params)
                rows = cur.fetchall()
        return [dict(r) for r in rows]

    def _execute(self, sql: str, params: tuple = ()) -> int:
        with self.connect() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, params)
                rowcount = cur.rowcount
            conn.commit()
        return rowcount

    # ── Schema ────────────────────────────────────────────────────────

    def init(self) -> None:
        with self.connect() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS app_users (
                        id SERIAL PRIMARY KEY,
                        supabase_uid TEXT NOT NULL UNIQUE,
                        email TEXT NOT NULL UNIQUE,
                        full_name TEXT NOT NULL DEFAULT '',
                        phone TEXT NOT NULL DEFAULT '',
                        gender TEXT NOT NULL DEFAULT '',
                        onboarding_status TEXT NOT NULL DEFAULT 'pending',
                        role TEXT NOT NULL DEFAULT 'user',
                        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    )
                """)
                # Backfill role column on existing installations
                cur.execute("""
                    ALTER TABLE app_users
                    ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'
                """)
                # NOTE: the legacy `app_subscriptions` table was dropped
                # by meter migration 017. The real per-tenant subscription
                # state lives in `agent_subscriptions` (keyed on
                # tenant_id) which the meter owns. Plan activation now
                # flows through coupon redemption — see app/lib/coupons.py.

                # Ensure agents + phone_routes exist (bridge owns these,
                # but we bootstrap them here too so a fresh app database
                # can run the FK-bearing CREATEs above without ordering
                # against the bridge's startup).
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS agents (
                        agent_id TEXT PRIMARY KEY,
                        gateway_url TEXT NOT NULL,
                        gateway_token TEXT NOT NULL,
                        session_scope TEXT NOT NULL DEFAULT 'main'
                    )
                """)
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS phone_routes (
                        phone TEXT PRIMARY KEY,
                        agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE
                    )
                """)
                # Short-URL table for WhatsApp connect links. Maps a
                # random 10-char base62 code → the full JWT-laden start
                # URL. 15-min TTL matches the JWT TTL so an expired
                # link produces the same error everywhere. Table is
                # tiny and cleaned up lazily on lookup; no background
                # job needed.
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS oauth_connect_shortlinks (
                        code TEXT PRIMARY KEY,
                        long_url TEXT NOT NULL,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                        expires_at TIMESTAMPTZ NOT NULL,
                        used_at TIMESTAMPTZ
                    )
                """)
                cur.execute("""
                    CREATE INDEX IF NOT EXISTS oauth_connect_shortlinks_expires_idx
                    ON oauth_connect_shortlinks(expires_at)
                """)
            conn.commit()
        logger.info("Database schema initialized")

    # ── OAuth connect shortlinks ─────────────────────────────────────

    def create_oauth_shortlink(
        self, *, code: str, long_url: str, expires_at
    ) -> None:
        """Insert a new shortlink row. Caller generates the code; this
        helper just persists it. PK collision would raise; with a
        62^10 keyspace it's negligible but the caller can retry."""
        self._execute(
            """
            INSERT INTO oauth_connect_shortlinks (code, long_url, expires_at)
            VALUES (%s, %s, %s)
            """,
            (code, long_url, expires_at),
        )

    def get_oauth_shortlink(self, code: str) -> dict[str, Any] | None:
        """Look up a shortlink by code. Returns None if missing or
        expired. Side effect: marks used_at on the first read so we
        get a lightweight 'was this clicked?' signal."""
        from datetime import datetime, timezone

        row = self._fetch_one(
            """
            SELECT code, long_url, created_at, expires_at, used_at
            FROM oauth_connect_shortlinks
            WHERE code = %s
            """,
            (code,),
        )
        if row is None:
            return None
        expires_at = row["expires_at"]
        if expires_at and expires_at < datetime.now(timezone.utc):
            return None
        if row["used_at"] is None:
            # Best-effort used-at update; no guarantee of uniqueness.
            # Failures are swallowed so a DB hiccup doesn't 500 the
            # redirect path.
            try:
                self._execute(
                    """
                    UPDATE oauth_connect_shortlinks
                    SET used_at = now()
                    WHERE code = %s AND used_at IS NULL
                    """,
                    (code,),
                )
            except Exception:  # noqa: BLE001
                pass
        return row

    # ── Users ─────────────────────────────────────────────────────────

    # Auth gate. Returns the active row or raises a typed AuthError.
    #
    # SELECT-first-then-INSERT (not an UPSERT) so a soft-deleted account
    # cannot silently resurrect itself on the next authenticated request.
    # The original upsert did that — a user deleted in Supabase whose
    # still-valid JWT hit /auth/me would be re-created from JWT claims.
    #
    # The INSERT's ON CONFLICT only covers the supabase_uid unique
    # constraint; `email` is separately UNIQUE (`app_users_email_key`).
    # A row under a different supabase_uid sharing this email therefore
    # raises psycopg.errors.UniqueViolation — we catch it and raise a
    # typed AuthError the dependency layer can translate to a structured
    # HTTPException. Without this, the UniqueViolation propagates as a
    # default FastAPI 500 with string-shaped `detail`, which the coupon
    # route's frontend wrapper falls back to "coupon_error" for.
    def get_user_for_auth(
        self,
        supabase_uid: str,
        email: str,
        full_name: str = "",
    ) -> dict[str, Any]:
        with self.connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT * FROM app_users WHERE supabase_uid = %s",
                    (supabase_uid,),
                )
                row = cur.fetchone()
                if row is not None:
                    if row["deleted_at"] is not None:
                        raise AuthAccountRevoked()
                    return dict(row)
                # First sighting of this Supabase UID — insert. ON CONFLICT
                # DO NOTHING handles the race where two concurrent requests
                # both hit the SELECT miss; the second INSERT no-ops and the
                # follow-up SELECT below picks up the winner.
                try:
                    cur.execute(
                        """INSERT INTO app_users (supabase_uid, email, full_name)
                           VALUES (%s, %s, %s)
                           ON CONFLICT (supabase_uid) DO NOTHING
                           RETURNING *""",
                        (supabase_uid, email, full_name),
                    )
                except psycopg.errors.UniqueViolation as exc:
                    # Email collision: another app_users row owns this
                    # email under a different supabase_uid. Branch on
                    # whether that row is live (account takeover risk —
                    # reject) or soft-deleted (revoked — reject without
                    # resurrection).
                    conn.rollback()
                    other = self._fetch_one(
                        "SELECT deleted_at FROM app_users WHERE lower(email) = lower(%s)",
                        (email,),
                    )
                    if other is None:
                        # UniqueViolation on a constraint we don't
                        # recognize — surface the original error rather
                        # than silently swallowing it.
                        raise exc
                    if other["deleted_at"] is not None:
                        raise AuthAccountRevoked() from exc
                    raise AuthEmailAlreadyRegistered() from exc
                row = cur.fetchone()
                if row is None:
                    cur.execute(
                        "SELECT * FROM app_users WHERE supabase_uid = %s",
                        (supabase_uid,),
                    )
                    row = cur.fetchone()
                    if row is not None and row["deleted_at"] is not None:
                        raise AuthAccountRevoked()
            conn.commit()
        if row is None:
            # Concurrent-insert race with a soft-deleted winner? Defensive —
            # should be unreachable given the branches above.
            raise AuthError()
        return dict(row)

    def soft_delete_user(self, user_id: int) -> dict[str, Any] | None:
        """Mark the app_users row deleted. Idempotent on already-deleted rows
        (re-sets deleted_at to now). FK targets (tenants, coupons, audit log,
        subscriptions) are preserved — soft-delete keeps historical records
        intact while the auth gate treats the account as revoked."""
        return self._execute(
            """UPDATE app_users
                  SET deleted_at = COALESCE(deleted_at, now())
                WHERE id = %s
            RETURNING *""",
            (user_id,),
        )

    def get_user_by_uid(self, supabase_uid: str) -> dict[str, Any] | None:
        return self._fetch_one(
            "SELECT * FROM app_users WHERE supabase_uid = %s AND deleted_at IS NULL",
            (supabase_uid,),
        )

    def get_user_by_id(self, user_id: int) -> dict[str, Any] | None:
        return self._fetch_one("SELECT * FROM app_users WHERE id = %s", (user_id,))

    def update_user(self, user_id: int, **fields) -> dict[str, Any] | None:
        allowed = {"full_name", "phone", "gender", "onboarding_status"}
        sets = []
        params: list[Any] = []
        for k, v in fields.items():
            if k in allowed:
                sets.append(f"{k} = %s")
                params.append(v)
        if not sets:
            return self.get_user_by_id(user_id)
        params.append(user_id)
        self._execute(f"UPDATE app_users SET {', '.join(sets)} WHERE id = %s", tuple(params))
        return self.get_user_by_id(user_id)

    # ── Per-tenant subscription read helper ───────────────────────────
    # Mirrors the meter's load_active_subscription query (filtered to
    # active rows whose [period_start, period_end] window contains now()).
    # Used by:
    #   - the agent-creation gate in routes/tenants.py
    #   - the tenant dashboard "current plan" pill
    #   - coupons.preview() for projecting supersession outcomes

    def get_active_subscription(self, tenant_id: int) -> dict[str, Any] | None:
        return self._fetch_one(
            """
            SELECT s.id, s.tenant_id, s.plan_id, s.status,
                   s.period_start, s.period_end,
                   s.base_allowance_micros, s.used_micros,
                   s.overage_enabled, s.overage_cap_micros, s.overage_used_micros,
                   s.plan_has_tts,
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

    # ── Coupons (admin CRUD) ──────────────────────────────────────────
    # Coupon redemption logic itself lives in app/lib/coupons.py — these
    # helpers are the read/list/admin-mutate side. The redemption path
    # writes to coupons + coupon_redemptions + agent_subscriptions in
    # one transaction with explicit row locks; bypass these helpers for
    # that path.

    def list_coupons(self) -> list[dict[str, Any]]:
        return self._fetch_all(
            """
            SELECT c.id, c.code, c.plan_id, c.duration_days,
                   c.max_redemptions, c.redemption_count,
                   c.valid_from, c.valid_until, c.one_per_user,
                   c.notes, c.disabled_at, c.created_by, c.created_at,
                   p.name_he AS plan_name_he, p.price_ils_cents,
                   creator.email AS created_by_email
              FROM coupons c
              JOIN billing_plans p ON p.plan_id = c.plan_id
              LEFT JOIN app_users creator ON creator.id = c.created_by
             ORDER BY c.created_at DESC
            """
        )

    def get_coupon(self, coupon_id: int) -> dict[str, Any] | None:
        return self._fetch_one(
            """
            SELECT c.*, p.name_he AS plan_name_he, p.price_ils_cents
              FROM coupons c
              JOIN billing_plans p ON p.plan_id = c.plan_id
             WHERE c.id = %s
            """,
            (coupon_id,),
        )

    def create_coupon(
        self,
        *,
        code: str,
        plan_id: str,
        duration_days: int,
        max_redemptions: int | None,
        valid_until,
        one_per_user: bool,
        notes: str,
        created_by: int,
    ) -> dict[str, Any]:
        with self.connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO coupons (
                        code, plan_id, duration_days, max_redemptions,
                        valid_until, one_per_user, notes, created_by
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    RETURNING *
                    """,
                    (
                        code, plan_id, duration_days, max_redemptions,
                        valid_until, one_per_user, notes, created_by,
                    ),
                )
                row = cur.fetchone()
            conn.commit()
        return dict(row) if row else {}

    def update_coupon(self, coupon_id: int, **fields) -> dict[str, Any] | None:
        """Update mutable coupon fields. Plan and duration are immutable
        post-create — changing them would invalidate the redemption
        history's plan/duration snapshot semantics."""
        allowed = {"notes", "max_redemptions", "valid_until", "one_per_user"}
        sets, params = [], []
        for k, v in fields.items():
            if k in allowed:
                sets.append(f"{k} = %s")
                params.append(v)
        if not sets:
            return self.get_coupon(coupon_id)
        params.append(coupon_id)
        self._execute(
            f"UPDATE coupons SET {', '.join(sets)} WHERE id = %s",
            tuple(params),
        )
        return self.get_coupon(coupon_id)

    def set_coupon_disabled(self, coupon_id: int, disabled: bool) -> dict[str, Any] | None:
        if disabled:
            self._execute("UPDATE coupons SET disabled_at = now() WHERE id = %s", (coupon_id,))
        else:
            self._execute("UPDATE coupons SET disabled_at = NULL WHERE id = %s", (coupon_id,))
        return self.get_coupon(coupon_id)

    def list_coupon_redemptions(self, coupon_id: int) -> list[dict[str, Any]]:
        return self._fetch_all(
            """
            SELECT r.id, r.coupon_id, r.user_id, r.tenant_id,
                   r.subscription_id, r.plan_id, r.duration_days,
                   r.period_start, r.period_end,
                   r.granted_by_admin, r.redeemed_at,
                   u.email AS user_email, u.full_name AS user_full_name,
                   t.name AS tenant_name, t.slug AS tenant_slug,
                   admin_u.email AS granted_by_admin_email
              FROM coupon_redemptions r
              JOIN app_users u ON u.id = r.user_id
              JOIN tenants t ON t.id = r.tenant_id
              LEFT JOIN app_users admin_u ON admin_u.id = r.granted_by_admin
             WHERE r.coupon_id = %s
             ORDER BY r.redeemed_at DESC
            """,
            (coupon_id,),
        )

    def list_user_redemptions(self, user_id: int) -> list[dict[str, Any]]:
        return self._fetch_all(
            """
            SELECT r.id, r.coupon_id, r.tenant_id, r.subscription_id,
                   r.plan_id, r.duration_days, r.period_start, r.period_end,
                   r.granted_by_admin, r.redeemed_at,
                   c.code AS coupon_code,
                   t.name AS tenant_name
              FROM coupon_redemptions r
              LEFT JOIN coupons c ON c.id = r.coupon_id
              JOIN tenants t ON t.id = r.tenant_id
             WHERE r.user_id = %s
             ORDER BY r.redeemed_at DESC
            """,
            (user_id,),
        )

    # ── Admin (superadmin panel) ──────────────────────────────────────
    # Read-through helpers that join across app_users, tenant_memberships,
    # agents, agent_subscriptions, and billing_plans. The meter owns writes
    # to agent_subscriptions + usage_events — these methods are READ ONLY.
    # Post-Phase-4 (meter migration 018) the legacy `app_user_agents`
    # junction is gone; agent_name lives on `agents.agent_name`,
    # agent_gender on `agents.bot_gender`, and "owner" is derived via
    # `agents.tenant_id → tenants.owner_user_id`.

    def list_all_users_with_agent_counts(self) -> list[dict[str, Any]]:
        # Count agents owned by tenants the user owns (mirrors the previous
        # semantics: pre-Phase-4 each agent had exactly one user via the
        # legacy junction; post-Phase-4 each agent belongs to exactly one
        # tenant which has exactly one owner).
        return self._fetch_all(
            """
            SELECT
                u.id, u.email, u.full_name, u.phone, u.role,
                u.onboarding_status, u.created_at,
                COUNT(DISTINCT a.agent_id) FILTER (WHERE a.deleted_at IS NULL)
                    AS agent_count
            FROM app_users u
            LEFT JOIN tenants t
                   ON t.owner_user_id = u.id AND t.deleted_at IS NULL
            LEFT JOIN agents a
                   ON a.tenant_id = t.id
            GROUP BY u.id
            ORDER BY u.created_at DESC
            """
        )

    def list_all_agents_with_owner_and_plan(self) -> list[dict[str, Any]]:
        return self._fetch_all(
            """
            SELECT
                a.agent_id,
                a.gateway_url,
                a.session_scope,
                a.tenant_id,
                a.agent_name,
                a.bot_gender                            AS agent_gender,
                CASE WHEN a.deleted_at IS NULL
                     THEN 'active' ELSE 'deleted' END   AS link_status,
                u.id        AS user_id,
                u.email     AS user_email,
                u.full_name AS user_full_name,
                u.role      AS user_role,
                s.id                     AS subscription_id,
                s.plan_id,
                s.status                 AS subscription_status,
                s.period_start,
                s.period_end,
                s.base_allowance_micros,
                s.used_micros,
                s.overage_enabled,
                s.overage_cap_micros,
                s.overage_used_micros,
                s.wallet_balance_micros,
                p.name_he                AS plan_name_he,
                p.billing_mode,
                p.price_ils_cents
            FROM agents a
            LEFT JOIN tenants   t ON t.id = a.tenant_id
            LEFT JOIN app_users u ON u.id = t.owner_user_id
            LEFT JOIN LATERAL (
                SELECT *
                FROM agent_subscriptions s
                WHERE s.tenant_id = a.tenant_id
                  AND s.status = 'active'
                  AND now() BETWEEN s.period_start AND s.period_end
                ORDER BY s.period_start DESC
                LIMIT 1
            ) s ON TRUE
            LEFT JOIN billing_plans p ON p.plan_id = s.plan_id
            WHERE a.deleted_at IS NULL
            ORDER BY u.created_at DESC NULLS LAST, a.agent_id
            """
        )

    def get_agent_details(self, agent_id: str) -> dict[str, Any] | None:
        return self._fetch_one(
            """
            SELECT
                a.agent_id, a.gateway_url, a.session_scope, a.tenant_id,
                a.agent_name,
                a.bot_gender                            AS agent_gender,
                CASE WHEN a.deleted_at IS NULL
                     THEN 'active' ELSE 'deleted' END   AS link_status,
                u.id AS user_id, u.email AS user_email,
                u.full_name AS user_full_name, u.role AS user_role
            FROM agents a
            LEFT JOIN tenants   t ON t.id = a.tenant_id
            LEFT JOIN app_users u ON u.id = t.owner_user_id
            WHERE a.agent_id = %s AND a.deleted_at IS NULL
            """,
            (agent_id,),
        )

    def list_recent_usage_events(
        self, agent_id: str, limit: int = 50
    ) -> list[dict[str, Any]]:
        return self._fetch_all(
            """
            SELECT
                event_id, ts, kind, upstream, model,
                input_tokens, output_tokens, cached_tokens, search_queries,
                cost_micros, notional_cost_micros, is_overage,
                upstream_status, latency_ms
            FROM usage_events
            WHERE agent_id = %s
            ORDER BY ts DESC
            LIMIT %s
            """,
            (agent_id, limit),
        )

    def list_billing_plans(self) -> list[dict[str, Any]]:
        return self._fetch_all(
            """
            SELECT
                plan_id, name_he, price_ils_cents, billing_mode,
                base_allowance_micros, allows_overage, default_overage_cap_micros,
                default_overage_markup_bps, rate_limit_rpm, active
            FROM billing_plans
            WHERE active
            ORDER BY price_ils_cents
            """
        )

    def set_user_role(self, user_id: int, role: str) -> dict[str, Any] | None:
        """Superadmin-only: promote/demote a user."""
        self._execute("UPDATE app_users SET role = %s WHERE id = %s", (role, user_id))
        return self.get_user_by_id(user_id)

    # ── Tenants ───────────────────────────────────────────────────────
    # Multi-tenancy layer: a tenant is the billing boundary; one user can
    # belong to many tenants with per-tenant roles ('owner' | 'admin' |
    # 'member'). Every real (non-stub) user gets a default tenant at
    # onboarding time via ensure_default_tenant(). All meter hot-path state
    # lives in `agent_subscriptions` keyed on tenant_id — the tenant holds
    # one shared pool across all its agents.

    def ensure_default_tenant(self, user_id: int) -> dict[str, Any]:
        """Return the user's default tenant, creating it on first call.

        Idempotent: if the user already owns a tenant, returns their
        oldest-owned one. Otherwise creates a fresh tenant + owner
        membership in one transaction and returns the new row.

        Stores `name_base` (the raw owner name, e.g. "שחר שביט") so the
        frontend can render the workspace label in the active display
        language — Hebrew template in he mode, English template in en
        mode — without ever mangling what the user stored. When the
        user explicitly renames the tenant via update_tenant(),
        name_base is nulled out and the literal `name` is shown from
        then on.
        """
        existing = self._fetch_one(
            """
            SELECT t.*
              FROM tenants t
              JOIN tenant_memberships tm
                ON tm.tenant_id = t.id
               AND tm.user_id   = %s
               AND tm.role      = 'owner'
             WHERE t.deleted_at IS NULL
             ORDER BY t.created_at ASC
             LIMIT 1
            """,
            (user_id,),
        )
        if existing:
            return existing

        user = self.get_user_by_id(user_id)
        if user is None:
            raise ValueError(f"user {user_id} not found")

        email_local = (user["email"] or "user").split("@", 1)[0].lower()
        slug = f"{email_local}-{user_id}"
        name_base = user["full_name"] or email_local
        # `name` is the fallback display string used by admin tools,
        # email templates, and any consumer that doesn't know about
        # name_base. Built via _default_tenant_name so the stored form
        # is always script-consistent (Hebrew template for Hebrew
        # names, English for Latin).
        name = _default_tenant_name(name_base)
        billing_email = user["email"] or ""

        with self.connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO tenants (slug, name, name_base, owner_user_id, billing_email)
                    VALUES (%s, %s, %s, %s, %s)
                    RETURNING *
                    """,
                    (slug, name, name_base, user_id, billing_email),
                )
                tenant = cur.fetchone()
                cur.execute(
                    """
                    INSERT INTO tenant_memberships (tenant_id, user_id, role)
                    VALUES (%s, %s, 'owner')
                    ON CONFLICT DO NOTHING
                    """,
                    (tenant["id"], user_id),
                )
            conn.commit()
        return dict(tenant)

    def create_tenant(
        self,
        *,
        name: str,
        owner_user_id: int,
        billing_email: str = "",
    ) -> dict[str, Any]:
        """Create a new tenant owned by owner_user_id. Used for the
        'create additional workspace' flow after the default tenant exists.

        Generates a URL-safe slug from the tenant name with a random 4-char
        suffix to avoid collisions with existing tenants (including the
        default `<email>-<user_id>` slug).
        """
        import re
        import secrets

        base = re.sub(r"[^a-z0-9-]+", "-", name.strip().lower()).strip("-") or "workspace"
        suffix = secrets.token_hex(2)
        slug = f"{base}-{suffix}"

        with self.connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO tenants (slug, name, owner_user_id, billing_email)
                    VALUES (%s, %s, %s, %s)
                    RETURNING *
                    """,
                    (slug, name.strip(), owner_user_id, billing_email),
                )
                tenant = cur.fetchone()
                cur.execute(
                    """
                    INSERT INTO tenant_memberships (tenant_id, user_id, role)
                    VALUES (%s, %s, 'owner')
                    """,
                    (tenant["id"], owner_user_id),
                )
            conn.commit()
        return dict(tenant)

    def get_tenant_by_id(self, tenant_id: int) -> dict[str, Any] | None:
        return self._fetch_one(
            "SELECT * FROM tenants WHERE id = %s AND deleted_at IS NULL",
            (tenant_id,),
        )

    def get_tenant_by_slug(self, slug: str) -> dict[str, Any] | None:
        return self._fetch_one(
            "SELECT * FROM tenants WHERE slug = %s AND deleted_at IS NULL",
            (slug,),
        )

    def list_user_tenants(self, user_id: int) -> list[dict[str, Any]]:
        """List every tenant the user is a member of with their role.

        Returns name_base so the UI can render per-language default
        tenant names. NULL name_base = user-renamed = render name
        literally.
        """
        return self._fetch_all(
            """
            SELECT t.id, t.slug, t.name, t.name_base, t.owner_user_id,
                   t.billing_email, t.created_at, tm.role
              FROM tenants t
              JOIN tenant_memberships tm ON tm.tenant_id = t.id
             WHERE tm.user_id = %s AND t.deleted_at IS NULL
             ORDER BY t.created_at ASC
            """,
            (user_id,),
        )

    def get_tenant_membership(self, tenant_id: int, user_id: int) -> dict[str, Any] | None:
        """Used by get_active_tenant_member dep — returns None for non-members."""
        return self._fetch_one(
            """
            SELECT tm.tenant_id, tm.user_id, tm.role, tm.joined_at
              FROM tenant_memberships tm
              JOIN tenants t ON t.id = tm.tenant_id
             WHERE tm.tenant_id = %s AND tm.user_id = %s AND t.deleted_at IS NULL
            """,
            (tenant_id, user_id),
        )

    def list_tenant_members(self, tenant_id: int) -> list[dict[str, Any]]:
        """Members of a tenant with their user profile for the UI."""
        return self._fetch_all(
            """
            SELECT u.id AS user_id, u.email, u.full_name,
                   tm.role, tm.joined_at
              FROM tenant_memberships tm
              JOIN app_users u ON u.id = tm.user_id
             WHERE tm.tenant_id = %s
             ORDER BY CASE tm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
                      tm.joined_at ASC
            """,
            (tenant_id,),
        )

    def update_tenant(self, tenant_id: int, **fields) -> dict[str, Any] | None:
        """Rename / update billing_email. Only whitelisted columns.

        When the user changes `name`, we null out `name_base` in the
        same UPDATE so the frontend stops treating it as a system
        default and shows the literal value from then on. This is how
        we distinguish "I accepted the auto-generated default" (where
        we want per-language rendering) from "I typed my own name"
        (where we must preserve what the user wrote byte-for-byte).
        """
        allowed = {"name", "billing_email"}
        sets = []
        params: list[Any] = []
        for k, v in fields.items():
            if k in allowed:
                sets.append(f"{k} = %s")
                params.append(v)
        if not sets:
            return self.get_tenant_by_id(tenant_id)
        if "name" in fields:
            sets.append("name_base = NULL")
        params.append(tenant_id)
        self._execute(
            f"UPDATE tenants SET {', '.join(sets)} WHERE id = %s AND deleted_at IS NULL",
            tuple(params),
        )
        return self.get_tenant_by_id(tenant_id)

    def count_user_owned_tenants(self, user_id: int) -> int:
        """For the last-tenant-delete guard: a user must always own at least
        one non-deleted tenant so downstream code can assume a default exists."""
        row = self._fetch_one(
            """
            SELECT COUNT(*)::int AS n
              FROM tenants
             WHERE owner_user_id = %s AND deleted_at IS NULL
            """,
            (user_id,),
        )
        return int(row["n"]) if row else 0

    def soft_delete_tenant(self, tenant_id: int) -> None:
        self._execute(
            "UPDATE tenants SET deleted_at = now() WHERE id = %s AND deleted_at IS NULL",
            (tenant_id,),
        )

    def get_agent_tenant_id(self, agent_id: str) -> int | None:
        """Resolve agent → tenant for live operations (delete, integrations,
        voice update). Returns None for both unknown and soft-deleted
        agents — callers should treat both as 404.
        """
        row = self._fetch_one(
            "SELECT tenant_id FROM agents WHERE agent_id = %s AND deleted_at IS NULL",
            (agent_id,),
        )
        return row["tenant_id"] if row else None

    def get_agent_for_phone(self, phone: str) -> dict[str, Any] | None:
        """Look up the agent currently bound to a phone number.

        Normalizes to digits-only to match the bridge's phone_routes
        storage format (see bridge/agents.py:_normalize_phone). Returns
        {agent_id, tenant_id} or None. Used by:
          - the /api/agents/check-phone pre-flight on agent creation
          - the provision_agent hard duplicate guard
          - the PATCH /bridges/whatsapp edit-phone duplicate guard
        Soft-deleted agents are excluded so their old phone can be reused.
        """
        import re
        digits = re.sub(r"\D", "", phone or "")
        if not digits:
            return None
        return self._fetch_one(
            """
            SELECT pr.agent_id, a.tenant_id
              FROM phone_routes pr
              JOIN agents a ON a.agent_id = pr.agent_id
             WHERE pr.phone = %s AND a.deleted_at IS NULL
            """,
            (digits,),
        )

    def get_phone_for_agent(self, agent_id: str) -> str | None:
        """Return the digits-only phone currently routed to this agent, or None."""
        row = self._fetch_one(
            "SELECT phone FROM phone_routes WHERE agent_id = %s",
            (agent_id,),
        )
        return row["phone"] if row else None

    # ── Agent bridges (WhatsApp / Telegram / Web Chat) ────────────────
    # Source of truth for which bridges are connected per-agent. The
    # WhatsApp row is kept consistent with `phone_routes` inside the
    # same transaction by set_whatsapp_bridge(). Telegram rows carry the
    # Secret Manager secret_name that holds the real bot token — the
    # token itself never lives in Postgres.

    def get_agent_bridges(self, agent_id: str) -> list[dict[str, Any]]:
        """All bridge rows for one agent. Ordered whatsapp → telegram → web
        for deterministic UI rendering."""
        return self._fetch_all(
            """
            SELECT agent_id, bridge_type, enabled, config,
                   connected_at, updated_at
              FROM agent_bridges
             WHERE agent_id = %s
             ORDER BY CASE bridge_type
                          WHEN 'whatsapp' THEN 0
                          WHEN 'telegram' THEN 1
                          WHEN 'web'      THEN 2
                          ELSE 9
                      END
            """,
            (agent_id,),
        )

    def set_whatsapp_bridge(self, agent_id: str, phone_e164: str | None) -> None:
        """Connect, change, or disconnect the WhatsApp bridge atomically.

        Contract
        ────────
        - phone_e164=None (or empty) → disconnect: deletes the
          phone_routes row for this agent and marks agent_bridges.whatsapp
          enabled=false (config kept as audit trail for last known phone).
        - phone_e164=<E.164 string> → connect / change: normalizes to
          digits, DELETE-then-INSERT the phone_routes row scoped to this
          agent (so changing phones doesn't leave the old one orphaned),
          and UPSERT the agent_bridges.whatsapp row. The caller is
          responsible for the duplicate-phone guard BEFORE calling this
          (e.g. via get_agent_for_phone). We trust the DB's PK as the
          final backstop but don't want to hit it because a conflict
          here leaves the transaction rolled back with no good error.

        Idempotent on the happy path — calling twice with the same phone
        is a no-op after the first call.
        """
        import re
        digits = re.sub(r"\D", "", phone_e164 or "")
        with self.connect() as conn:
            with conn.cursor() as cur:
                # Always drop the agent's existing phone_routes row first.
                # This way "change phone" frees the old number for reuse
                # atomically with claiming the new one.
                cur.execute(
                    "DELETE FROM phone_routes WHERE agent_id = %s",
                    (agent_id,),
                )
                if digits:
                    cur.execute(
                        """
                        INSERT INTO phone_routes (phone, agent_id)
                        VALUES (%s, %s)
                        """,
                        (digits, agent_id),
                    )
                    cur.execute(
                        """
                        INSERT INTO agent_bridges
                            (agent_id, bridge_type, enabled, config, connected_at)
                        VALUES (%s, 'whatsapp', TRUE,
                                jsonb_build_object('phone', %s::text),
                                now())
                        ON CONFLICT (agent_id, bridge_type) DO UPDATE SET
                            enabled      = EXCLUDED.enabled,
                            config       = EXCLUDED.config,
                            connected_at = COALESCE(agent_bridges.connected_at,
                                                    EXCLUDED.connected_at)
                        """,
                        (agent_id, digits),
                    )
                else:
                    # Disconnect: flip enabled=false. Keep the last phone
                    # in config for audit ("previously connected to X").
                    cur.execute(
                        """
                        UPDATE agent_bridges
                           SET enabled = FALSE
                         WHERE agent_id = %s AND bridge_type = 'whatsapp'
                        """,
                        (agent_id,),
                    )
            conn.commit()

    def upsert_telegram_bridge(
        self,
        agent_id: str,
        *,
        bot_username: str,
        bot_display_name: str,
        secret_name: str,
    ) -> None:
        """Record a connected Telegram bot. Caller has already validated
        the token via getMe and stored it in Secret Manager under
        secret_name. We persist the IDENTITY (username + display name
        for the UI) plus the secret_name pointer — never the token itself.
        """
        self._execute(
            """
            INSERT INTO agent_bridges
                (agent_id, bridge_type, enabled, config, connected_at)
            VALUES (%s, 'telegram', TRUE,
                    jsonb_build_object(
                        'bot_username', %s::text,
                        'bot_display_name', %s::text,
                        'secret_name', %s::text
                    ),
                    now())
            ON CONFLICT (agent_id, bridge_type) DO UPDATE SET
                enabled      = EXCLUDED.enabled,
                config       = EXCLUDED.config,
                connected_at = EXCLUDED.connected_at
            """,
            (agent_id, bot_username, bot_display_name, secret_name),
        )

    def disconnect_telegram_bridge(self, agent_id: str) -> dict[str, Any] | None:
        """Flip the Telegram bridge to disabled. Returns the pre-update
        config (so the caller can revoke the Secret Manager secret +
        issue the openclaw.json config patch to disable the channel).
        Returns None if no row existed (no-op)."""
        existing = self._fetch_one(
            """
            SELECT config
              FROM agent_bridges
             WHERE agent_id = %s AND bridge_type = 'telegram'
            """,
            (agent_id,),
        )
        if existing is None:
            return None
        self._execute(
            """
            UPDATE agent_bridges
               SET enabled = FALSE
             WHERE agent_id = %s AND bridge_type = 'telegram'
            """,
            (agent_id,),
        )
        return existing

    def soft_delete_agent(self, agent_id: str) -> None:
        """Tombstone the agent: stamp ``deleted_at`` and clear live-routing
        state. Preserves billing-relevant rows (usage_events, agents_meter_keys
        as revoked, the agents row itself with its `agent_name`) so the
        Usage tab can render historical per-agent spend with a "(deleted)"
        label.

        What we keep
        ────────────
        - ``agents`` row itself (just `deleted_at` set, `gateway_url` cleared
          so any leftover routing code fails fast). Its `agent_name` +
          `bot_gender` columns remain populated and are the only source of
          the human-readable label for the Usage breakdown.
        - ``usage_events`` — append-only, source of truth for billing.

        What we remove (live-state, security/PII)
        ─────────────────────────────────────────
        - ``phone_routes`` — frees the WhatsApp number for re-use.
        - ``agents_meter_keys`` — revoked rather than deleted (audit trail).
        - ``agent_google_credentials`` / ``agent_nylas_credentials`` — the
          OAuth refresh token / Nylas grant has already been revoked at the
          provider in the calling route; deleting the local row removes the
          PII (email + scope set). The provider revocation is what stops
          token use; the local delete is hygiene.
        """
        with self.connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE agents SET deleted_at = now(), gateway_url = '' "
                    "WHERE agent_id = %s AND deleted_at IS NULL",
                    (agent_id,),
                )
                cur.execute("DELETE FROM phone_routes WHERE agent_id = %s", (agent_id,))
                cur.execute(
                    "UPDATE agents_meter_keys SET revoked_at = now() "
                    "WHERE agent_id = %s AND revoked_at IS NULL",
                    (agent_id,),
                )
                cur.execute(
                    "DELETE FROM agent_google_credentials WHERE agent_id = %s",
                    (agent_id,),
                )
                cur.execute(
                    "DELETE FROM agent_nylas_credentials WHERE agent_id = %s",
                    (agent_id,),
                )
            conn.commit()

    def transfer_tenant_owner(self, tenant_id: int, new_owner_user_id: int) -> None:
        """Atomic ownership transfer. The new owner must already be a member.
        Demotes the old owner to 'admin'."""
        with self.connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT owner_user_id FROM tenants WHERE id = %s AND deleted_at IS NULL FOR UPDATE",
                    (tenant_id,),
                )
                row = cur.fetchone()
                if row is None:
                    raise ValueError("tenant not found")
                old_owner_id = row["owner_user_id"]
                if old_owner_id == new_owner_user_id:
                    return
                # Verify new owner is a member
                cur.execute(
                    "SELECT 1 FROM tenant_memberships WHERE tenant_id = %s AND user_id = %s",
                    (tenant_id, new_owner_user_id),
                )
                if cur.fetchone() is None:
                    raise ValueError("new owner must already be a member")
                # Demote old owner → admin first (the partial unique owner index
                # allows this because we update to 'admin' before re-setting).
                cur.execute(
                    "UPDATE tenant_memberships SET role = 'admin' WHERE tenant_id = %s AND user_id = %s",
                    (tenant_id, old_owner_id),
                )
                cur.execute(
                    "UPDATE tenant_memberships SET role = 'owner' WHERE tenant_id = %s AND user_id = %s",
                    (tenant_id, new_owner_user_id),
                )
                cur.execute(
                    "UPDATE tenants SET owner_user_id = %s WHERE id = %s",
                    (new_owner_user_id, tenant_id),
                )
            conn.commit()

    def set_member_role(self, tenant_id: int, user_id: int, role: str) -> dict[str, Any] | None:
        """Change a member's role. Blocked from promoting to 'owner' — use
        transfer_tenant_owner() for that."""
        if role not in ("admin", "member"):
            raise ValueError("role must be 'admin' or 'member' (use transfer_tenant_owner for owner changes)")
        self._execute(
            "UPDATE tenant_memberships SET role = %s WHERE tenant_id = %s AND user_id = %s",
            (role, tenant_id, user_id),
        )
        return self.get_tenant_membership(tenant_id, user_id)

    def remove_tenant_member(self, tenant_id: int, user_id: int) -> None:
        """Remove a member from the tenant. Caller must verify the target
        is not the owner — the partial unique index on role='owner' would
        allow this but we'd leave the tenant owner-less, breaking invariants."""
        self._execute(
            """
            DELETE FROM tenant_memberships
             WHERE tenant_id = %s
               AND user_id   = %s
               AND role     <> 'owner'
            """,
            (tenant_id, user_id),
        )

    def list_tenant_agents(self, tenant_id: int) -> list[dict[str, Any]]:
        """Active agents for this tenant — soft-deleted agents are filtered.
        For the Usage tab's per-agent breakdown (which must show deleted
        agents alongside live ones), use ``list_tenant_agents_with_deleted``.

        Post-Phase-4 (meter migration 018) the legacy junction is gone;
        agent_name + bot_gender live on the `agents` row directly and are
        written atomically by create-agent.sh during INSERT, so no
        defensive coalescing is needed here.
        """
        return self._fetch_all(
            """
            SELECT a.agent_id,
                   a.gateway_url,
                   a.session_scope,
                   a.tenant_id,
                   a.agent_name,
                   a.bot_gender   AS agent_gender,
                   'active'       AS status,
                   a.created_at   AS created_at
              FROM agents a
             WHERE a.tenant_id = %s AND a.deleted_at IS NULL
             ORDER BY a.created_at DESC
            """,
            (tenant_id,),
        )

    def list_tenant_agents_with_deleted(self, tenant_id: int) -> list[dict[str, Any]]:
        """All agents for this tenant including soft-deleted tombstones.

        Returned rows include ``deleted_at`` (ISO timestamp or None). The
        Usage tab uses this to keep historical per-agent spend attributable
        — usage_events are append-only and tenants paid for that traffic,
        so the rows belong on the breakdown even after delete.

        Active rows sort first (by created_at desc), then deleted rows
        (by deleted_at desc — most recently deleted first).
        """
        return self._fetch_all(
            """
            SELECT a.agent_id,
                   a.gateway_url,
                   a.session_scope,
                   a.tenant_id,
                   a.deleted_at,
                   a.agent_name,
                   a.bot_gender   AS agent_gender,
                   CASE WHEN a.deleted_at IS NULL
                        THEN 'active' ELSE 'deleted' END   AS status,
                   a.created_at   AS created_at
              FROM agents a
             WHERE a.tenant_id = %s
             ORDER BY (a.deleted_at IS NULL) DESC,
                      a.deleted_at DESC NULLS LAST,
                      a.created_at DESC
            """,
            (tenant_id,),
        )

    # ── Tenant invites ────────────────────────────────────────────────

    def create_invite(
        self,
        *,
        tenant_id: int,
        email: str,
        role: str,
        invited_by: int,
        expires_at,
    ) -> tuple[dict[str, Any], str]:
        """Create a pending invite. Returns (invite_row, raw_token).

        The raw token is the only copy that ever leaves the server — it
        goes in the email link. The DB stores sha256(token) only, so
        leaking the DB doesn't leak valid invite links.
        """
        import hashlib
        import secrets

        if role not in ("admin", "member"):
            raise ValueError("role must be 'admin' or 'member'")

        raw_token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(raw_token.encode("utf-8")).digest()

        with self.connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO tenant_invites
                        (tenant_id, email, role, token_hash, invited_by, expires_at)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    RETURNING id, tenant_id, email, role, invited_by,
                              created_at, expires_at, accepted_at, revoked_at
                    """,
                    (tenant_id, email.strip().lower(), role, token_hash, invited_by, expires_at),
                )
                row = cur.fetchone()
            conn.commit()
        return dict(row), raw_token

    def get_invite_by_token(self, raw_token: str) -> dict[str, Any] | None:
        """Look up an invite by its raw token. Returns the row (including
        expiry + acceptance state) for the caller to validate."""
        import hashlib

        token_hash = hashlib.sha256(raw_token.encode("utf-8")).digest()
        return self._fetch_one(
            """
            SELECT i.id, i.tenant_id, i.email, i.role, i.invited_by,
                   i.created_at, i.expires_at, i.accepted_at, i.revoked_at,
                   t.name AS tenant_name, t.slug AS tenant_slug,
                   u.email AS inviter_email, u.full_name AS inviter_name
              FROM tenant_invites i
              JOIN tenants t ON t.id = i.tenant_id AND t.deleted_at IS NULL
              JOIN app_users u ON u.id = i.invited_by
             WHERE i.token_hash = %s
            """,
            (token_hash,),
        )

    def list_pending_invites(self, tenant_id: int) -> list[dict[str, Any]]:
        return self._fetch_all(
            """
            SELECT id, email, role, invited_by, created_at, expires_at
              FROM tenant_invites
             WHERE tenant_id = %s
               AND accepted_at IS NULL
               AND revoked_at IS NULL
               AND expires_at > now()
             ORDER BY created_at DESC
            """,
            (tenant_id,),
        )

    def revoke_invite(self, invite_id: int) -> None:
        self._execute(
            "UPDATE tenant_invites SET revoked_at = now() WHERE id = %s AND accepted_at IS NULL",
            (invite_id,),
        )

    def accept_invite(self, invite_id: int, accepted_by_user_id: int) -> dict[str, Any]:
        """Atomic accept: mark invite accepted + create-or-escalate the membership.

        Monotonic role guarantee: if the user already has a membership on this
        tenant with equal-or-higher role than the invite, the accept is a
        no-op on the membership (invite is still marked consumed). An owner
        accepting a member-invite stays an owner. Escalation (member invited
        as admin/owner) is allowed and applied.

        Raises ValueError if the invite is already accepted, revoked, or
        expired. Returns the final membership row.
        """
        _ROLE_RANK = {"member": 0, "admin": 1, "owner": 2}

        with self.connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id, tenant_id, role, accepted_at, revoked_at, expires_at
                      FROM tenant_invites
                     WHERE id = %s
                     FOR UPDATE
                    """,
                    (invite_id,),
                )
                invite = cur.fetchone()
                if invite is None:
                    raise ValueError("invite not found")
                if invite["revoked_at"] is not None:
                    raise ValueError("invite revoked")
                if invite["accepted_at"] is not None:
                    raise ValueError("invite already accepted")

                from datetime import datetime, timezone
                if invite["expires_at"] < datetime.now(timezone.utc):
                    raise ValueError("invite expired")

                cur.execute(
                    """
                    SELECT role, joined_at
                      FROM tenant_memberships
                     WHERE tenant_id = %s AND user_id = %s
                     FOR UPDATE
                    """,
                    (invite["tenant_id"], accepted_by_user_id),
                )
                existing = cur.fetchone()

                invite_rank = _ROLE_RANK[invite["role"]]
                existing_rank = _ROLE_RANK[existing["role"]] if existing else -1

                if existing and existing_rank >= invite_rank:
                    membership = {
                        "tenant_id": invite["tenant_id"],
                        "user_id": accepted_by_user_id,
                        "role": existing["role"],
                        "joined_at": existing["joined_at"],
                    }
                else:
                    cur.execute(
                        """
                        INSERT INTO tenant_memberships (tenant_id, user_id, role)
                        VALUES (%s, %s, %s)
                        ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role
                        RETURNING tenant_id, user_id, role, joined_at
                        """,
                        (invite["tenant_id"], accepted_by_user_id, invite["role"]),
                    )
                    membership = cur.fetchone()

                cur.execute(
                    """
                    UPDATE tenant_invites
                       SET accepted_at = now(), accepted_by = %s
                     WHERE id = %s
                    """,
                    (accepted_by_user_id, invite_id),
                )
            conn.commit()
        return dict(membership)

    # ── Tenant audit log ─────────────────────────────────────────────
    # Append-only record of every state-changing tenant action. See
    # meter/migrations/020_tenant_audit_log.sql for the schema + the
    # action namespace convention. Call this from every mutation route
    # right after the DB change lands (or from inside the same
    # transaction for paths that build their own cursor).

    def log_audit(
        self,
        *,
        tenant_id: int,
        action: str,
        actor_user_id: int | None = None,
        target_type: str | None = None,
        target_id: str | None = None,
        metadata: dict[str, Any] | None = None,
        ip_address: str | None = None,
        user_agent: str | None = None,
    ) -> None:
        """Write one audit row. Never raises to the caller — audit
        logging is best-effort. Failures are logged and swallowed so an
        audit write never blocks a real mutation.

        `actor_user_id=None` signals a system-initiated action (e.g.
        Grow webhook subscription renewal, scheduled invite expiry).
        The UI renders these with a "system" label.
        """
        import json

        try:
            self._execute(
                """
                INSERT INTO tenant_audit_log
                    (tenant_id, actor_user_id, action,
                     target_type, target_id, metadata,
                     ip_address, user_agent)
                VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s::inet, %s)
                """,
                (
                    tenant_id,
                    actor_user_id,
                    action,
                    target_type,
                    target_id,
                    json.dumps(metadata) if metadata is not None else None,
                    ip_address,
                    user_agent,
                ),
            )
        except Exception:  # noqa: BLE001
            logger.warning(
                "audit log write failed for tenant=%s action=%s actor=%s",
                tenant_id, action, actor_user_id, exc_info=True,
            )

    # ── Superadmin: cross-tenant views ───────────────────────────────
    # These power the admin panel's Tenants tab + impersonation flow.
    # All READ-only; mutation of tenant state goes through the same
    # routes any tenant owner would use.

    def list_all_tenants(self) -> list[dict[str, Any]]:
        """Every non-deleted tenant with owner + active plan inlined.

        Used by the admin Tenants tab. One row per tenant, ordered by
        created_at DESC so the newest workspace is at the top. The
        active-sub join is a LATERAL LIMIT 1 because a tenant can have
        both a superseded and an active row for the same period window.
        """
        return self._fetch_all(
            """
            SELECT
                t.id,
                t.slug,
                t.name,
                t.name_base,
                t.created_at,
                t.billing_email,
                t.owner_user_id,
                u.email        AS owner_email,
                u.full_name    AS owner_full_name,
                (SELECT COUNT(*) FROM tenant_memberships tm WHERE tm.tenant_id = t.id) AS member_count,
                (SELECT COUNT(*) FROM agents a WHERE a.tenant_id = t.id AND a.deleted_at IS NULL) AS agent_count,
                s.plan_id,
                s.status        AS subscription_status,
                s.period_start  AS subscription_period_start,
                s.period_end    AS subscription_period_end,
                p.name_he       AS plan_name_he,
                p.price_ils_cents
              FROM tenants t
              JOIN app_users u ON u.id = t.owner_user_id
              LEFT JOIN LATERAL (
                  SELECT *
                    FROM agent_subscriptions s
                   WHERE s.tenant_id = t.id
                     AND s.status = 'active'
                     AND now() BETWEEN s.period_start AND s.period_end
                   ORDER BY s.period_start DESC
                   LIMIT 1
              ) s ON TRUE
              LEFT JOIN billing_plans p ON p.plan_id = s.plan_id
             WHERE t.deleted_at IS NULL
             ORDER BY t.created_at DESC
            """
        )

    def get_tenant_full_detail(self, tenant_id: int) -> dict[str, Any] | None:
        """Single-tenant view for the admin drawer. Combines the tenant
        row, its members + roles, its active + soft-deleted agents, the
        active subscription, and the last 20 audit events — all in one
        payload so the UI doesn't need to orchestrate four fetches."""
        tenant = self._fetch_one(
            """
            SELECT t.*, u.email AS owner_email, u.full_name AS owner_full_name
              FROM tenants t
              JOIN app_users u ON u.id = t.owner_user_id
             WHERE t.id = %s
            """,
            (tenant_id,),
        )
        if tenant is None:
            return None
        return {
            "tenant": tenant,
            "members": self.list_tenant_members(tenant_id),
            "agents": self.list_tenant_agents_with_deleted(tenant_id),
            "subscription": self.get_active_subscription(tenant_id),
            "recent_audit": self.list_tenant_audit(tenant_id, limit=20),
            "pending_invites": self.list_pending_invites(tenant_id),
        }

    def list_tenant_audit(
        self, tenant_id: int, *, limit: int = 100, offset: int = 0
    ) -> list[dict[str, Any]]:
        """Time-descending audit feed for one tenant. Includes the
        actor's email so the UI doesn't need a separate JOIN round-trip
        per row. Default page size 100 matches the TenantPage Audit
        tab's initial render."""
        return self._fetch_all(
            """
            SELECT
                a.id,
                a.tenant_id,
                a.actor_user_id,
                u.email        AS actor_email,
                u.full_name    AS actor_full_name,
                a.action,
                a.target_type,
                a.target_id,
                a.metadata,
                a.ip_address,
                a.user_agent,
                a.created_at
              FROM tenant_audit_log a
              LEFT JOIN app_users u ON u.id = a.actor_user_id
             WHERE a.tenant_id = %s
             ORDER BY a.created_at DESC, a.id DESC
             LIMIT %s OFFSET %s
            """,
            (tenant_id, limit, offset),
        )
