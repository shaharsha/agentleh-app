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
                        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    )
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
