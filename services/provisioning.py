"""Agent provisioning — Protocol + mock implementation."""

from __future__ import annotations

import logging
import secrets
from dataclasses import dataclass, field
from typing import Protocol

logger = logging.getLogger(__name__)


@dataclass
class ProvisionResult:
    agent_id: str
    gateway_url: str = ""
    gateway_token: str = ""
    port: int = 0
    success: bool = True
    error: str = ""


class AgentProvisioner(Protocol):
    def provision(self, agent_id: str, phone: str, agent_name: str, user_name: str) -> ProvisionResult: ...
    def check_health(self, agent_id: str) -> bool: ...


class MockProvisioner:
    """Logs provisioning requests, inserts into DB, returns fake data."""

    def __init__(self, db=None):
        self.db = db

    def provision(self, agent_id: str, phone: str, agent_name: str, user_name: str) -> ProvisionResult:
        logger.info("MOCK: Provisioning agent %s for %s (phone: %s, name: %s)", agent_id, user_name, phone, agent_name)

        token = secrets.token_urlsafe(32)
        gateway_url = f"wss://gw.agentiko.io/{agent_id}/"

        # Insert into agents + phone_routes tables (same as create-agent.sh does)
        if self.db:
            from psycopg.rows import dict_row
            with self.db.connect() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """INSERT INTO agents (agent_id, gateway_url, gateway_token, session_scope)
                           VALUES (%s, %s, %s, 'per-peer')
                           ON CONFLICT (agent_id) DO NOTHING""",
                        (agent_id, gateway_url, token),
                    )
                    # Normalize phone
                    normalized = "".join(c for c in phone if c.isdigit())
                    cur.execute(
                        """INSERT INTO phone_routes (phone, agent_id)
                           VALUES (%s, %s)
                           ON CONFLICT (phone) DO UPDATE SET agent_id = EXCLUDED.agent_id""",
                        (normalized, agent_id),
                    )
                conn.commit()

        return ProvisionResult(
            agent_id=agent_id,
            gateway_url=gateway_url,
            gateway_token=token,
            port=18800,
            success=True,
        )

    def check_health(self, agent_id: str) -> bool:
        logger.info("MOCK: Health check for %s → healthy", agent_id)
        return True
