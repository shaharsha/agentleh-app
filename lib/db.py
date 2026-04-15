"""App database — users, subscriptions, user-agent links."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import psycopg
from psycopg.rows import dict_row

logger = logging.getLogger(__name__)


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
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS app_subscriptions (
                        id SERIAL PRIMARY KEY,
                        user_id INTEGER NOT NULL REFERENCES app_users(id),
                        plan TEXT NOT NULL DEFAULT 'starter',
                        status TEXT NOT NULL DEFAULT 'mock_active',
                        external_id TEXT NOT NULL DEFAULT '',
                        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    )
                """)
                # Ensure agents table exists (bridge creates it, but
                # we need it for the FK in app_user_agents)
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
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS app_user_agents (
                        id SERIAL PRIMARY KEY,
                        user_id INTEGER NOT NULL REFERENCES app_users(id),
                        agent_id TEXT NOT NULL REFERENCES agents(agent_id),
                        agent_name TEXT NOT NULL DEFAULT '',
                        agent_gender TEXT NOT NULL DEFAULT '',
                        status TEXT NOT NULL DEFAULT 'provisioning',
                        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                        UNIQUE(user_id, agent_id)
                    )
                """)
            conn.commit()
        logger.info("Database schema initialized")

    # ── Users ─────────────────────────────────────────────────────────

    def upsert_user(self, supabase_uid: str, email: str, full_name: str = "") -> dict[str, Any]:
        with self.connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """INSERT INTO app_users (supabase_uid, email, full_name)
                       VALUES (%s, %s, %s)
                       ON CONFLICT (supabase_uid) DO UPDATE SET
                         email = EXCLUDED.email,
                         full_name = CASE WHEN app_users.full_name = '' THEN EXCLUDED.full_name ELSE app_users.full_name END
                       RETURNING *""",
                    (supabase_uid, email, full_name),
                )
                row = cur.fetchone()
            conn.commit()
        return dict(row) if row else {}

    def get_user_by_uid(self, supabase_uid: str) -> dict[str, Any] | None:
        return self._fetch_one("SELECT * FROM app_users WHERE supabase_uid = %s", (supabase_uid,))

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

    # ── Subscriptions ─────────────────────────────────────────────────

    def create_subscription(self, user_id: int, plan: str = "starter", status: str = "mock_active") -> dict[str, Any]:
        with self.connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO app_subscriptions (user_id, plan, status) VALUES (%s, %s, %s) RETURNING *",
                    (user_id, plan, status),
                )
                row = cur.fetchone()
            conn.commit()
        return dict(row) if row else {}

    def get_subscription(self, user_id: int) -> dict[str, Any] | None:
        return self._fetch_one(
            "SELECT * FROM app_subscriptions WHERE user_id = %s ORDER BY created_at DESC LIMIT 1",
            (user_id,),
        )

    # ── User Agents ───────────────────────────────────────────────────

    def create_user_agent(self, user_id: int, agent_id: str, agent_name: str, agent_gender: str) -> dict[str, Any]:
        with self.connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """INSERT INTO app_user_agents (user_id, agent_id, agent_name, agent_gender, status)
                       VALUES (%s, %s, %s, %s, 'active') RETURNING *""",
                    (user_id, agent_id, agent_name, agent_gender),
                )
                row = cur.fetchone()
            conn.commit()
        return dict(row) if row else {}

    def get_user_agents(self, user_id: int) -> list[dict[str, Any]]:
        return self._fetch_all(
            """SELECT ua.*, a.gateway_url, a.tenant_id, a.tts_voice_name
               FROM app_user_agents ua
               JOIN agents a ON a.agent_id = ua.agent_id
               WHERE ua.user_id = %s
               ORDER BY ua.created_at DESC""",
            (user_id,),
        )

    # ── Admin (superadmin panel) ──────────────────────────────────────
    # Read-through helpers that join across app_users, app_user_agents,
    # agents, agent_subscriptions, and billing_plans. The meter owns writes
    # to agent_subscriptions + usage_events — these methods are READ ONLY.

    def list_all_users_with_agent_counts(self) -> list[dict[str, Any]]:
        return self._fetch_all(
            """
            SELECT
                u.id, u.email, u.full_name, u.phone, u.role,
                u.onboarding_status, u.created_at,
                COUNT(DISTINCT ua.agent_id) AS agent_count
            FROM app_users u
            LEFT JOIN app_user_agents ua ON ua.user_id = u.id
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
                ua.agent_name,
                ua.agent_gender,
                ua.status AS link_status,
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
            LEFT JOIN app_user_agents ua ON ua.agent_id = a.agent_id
            LEFT JOIN app_users       u  ON u.id = ua.user_id
            LEFT JOIN LATERAL (
                SELECT *
                FROM agent_subscriptions s
                WHERE s.agent_id = a.agent_id
                  AND s.status = 'active'
                  AND now() BETWEEN s.period_start AND s.period_end
                ORDER BY s.period_start DESC
                LIMIT 1
            ) s ON TRUE
            LEFT JOIN billing_plans p ON p.plan_id = s.plan_id
            ORDER BY u.created_at DESC NULLS LAST, a.agent_id
            """
        )

    def get_agent_details(self, agent_id: str) -> dict[str, Any] | None:
        return self._fetch_one(
            """
            SELECT
                a.agent_id, a.gateway_url, a.session_scope,
                ua.agent_name, ua.agent_gender, ua.status AS link_status,
                u.id AS user_id, u.email AS user_email,
                u.full_name AS user_full_name, u.role AS user_role
            FROM agents a
            LEFT JOIN app_user_agents ua ON ua.agent_id = a.agent_id
            LEFT JOIN app_users       u  ON u.id = ua.user_id
            WHERE a.agent_id = %s
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
        """All agents belonging to this tenant, joined with the compat view
        so agent_name + agent_gender metadata comes along for free."""
        return self._fetch_all(
            """
            SELECT a.agent_id,
                   a.gateway_url,
                   a.session_scope,
                   a.tenant_id,
                   COALESCE(ual.agent_name,   a.agent_id) AS agent_name,
                   COALESCE(ual.agent_gender, '')         AS agent_gender,
                   COALESCE(ual.status,       'active')   AS status,
                   COALESCE(ual.created_at,   now())      AS created_at
              FROM agents a
              LEFT JOIN app_user_agents_legacy ual ON ual.agent_id = a.agent_id
             WHERE a.tenant_id = %s
             ORDER BY created_at DESC
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
        """Atomic accept: mark invite accepted + create the membership.

        Raises ValueError if the invite is already accepted, revoked, or
        expired. Returns the newly-created (or existing) membership row.
        """
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
