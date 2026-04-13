"""App database — users, subscriptions, user-agent links."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import psycopg
from psycopg.rows import dict_row

logger = logging.getLogger(__name__)


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
            """SELECT ua.*, a.gateway_url
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
