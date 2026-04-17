"""Agent provisioning — Protocol + mock + real VM-daemon implementation.

Two implementations:

  MockProvisioner   — inserts a stub row into `agents` but never brings up
                      an OpenClaw container. Used for local tests only.
                      Writes a bogus gateway_url that the bridge can't
                      actually reach, so "real" message traffic through
                      a mock-provisioned agent will never work. That's
                      fine for testing the tenant CRUD flows.

  VmHttpProvisioner — calls the agent-config `provision-api.py` daemon
                      running as a systemd service on openclaw-prod /
                      openclaw-dev. The daemon shells out to
                      create-agent.sh, returns the real ws:// gateway
                      URL, a real meter key, and the port. This is what
                      runs in dev + prod Cloud Run.

The implementation is picked via the `AGENTLEH_PROVISIONER` env var:
  - `mock` (default for local dev)
  - `vm`   (default for Cloud Run, reads VM daemon URL + token from env)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

logger = logging.getLogger(__name__)


@dataclass
class ProvisionResult:
    agent_id: str
    gateway_url: str = ""
    gateway_token: str = ""
    port: int = 0
    success: bool = True
    error: str = ""


@dataclass
class DeprovisionResult:
    agent_id: str
    success: bool = True
    error: str = ""
    backup_path: str = ""


class AgentProvisioner(Protocol):
    def provision(
        self,
        agent_id: str,
        phone: str,
        agent_name: str,
        user_name: str,
        tenant_id: int,
        bot_gender: str = "",
        user_gender: str = "",
        tts_voice_name: str = "",
    ) -> ProvisionResult: ...
    def provision_stream(
        self,
        agent_id: str,
        phone: str,
        agent_name: str,
        user_name: str,
        tenant_id: int,
        bot_gender: str = "",
        user_gender: str = "",
        tts_voice_name: str = "",
    ) -> AsyncIterator[dict[str, Any]]: ...
    def deprovision(self, agent_id: str) -> DeprovisionResult: ...
    def check_health(self, agent_id: str) -> bool: ...


class MockProvisioner:
    """Logs provisioning requests, inserts into DB, returns fake data.

    ONLY for local dev + tests. Does NOT actually bring up an OpenClaw
    container — the gateway_url it writes will not accept websocket
    connections. For a real provision path on dev/prod Cloud Run use
    VmHttpProvisioner which calls the VM daemon.
    """

    def __init__(self, db=None, gateway_base_url: str = ""):
        self.db = db
        # Fallback to a realistic ws:// URL so test assertions match the
        # shape create-agent.sh produces (ws://10.10.0.x:port).
        self.gateway_base_url = gateway_base_url or "ws://127.0.0.1:18800"

    def provision(
        self,
        agent_id: str,
        phone: str,
        agent_name: str,
        user_name: str,
        tenant_id: int,
        bot_gender: str = "",
        user_gender: str = "",
        tts_voice_name: str = "",
    ) -> ProvisionResult:
        logger.info(
            "MOCK: Provisioning agent %s for %s (phone: %s, name: %s, tenant: %s, bot_gender: %s, user_gender: %s, voice: %s)",
            agent_id,
            user_name,
            phone,
            agent_name,
            tenant_id,
            bot_gender,
            user_gender,
            tts_voice_name,
        )

        token = secrets.token_urlsafe(32)
        gateway_url = self.gateway_base_url

        # Insert into agents + phone_routes tables (same as create-agent.sh
        # does on the VM). The full row is written atomically — agent_name,
        # bot_gender, and tts_voice_name are persisted at provision time so
        # downstream readers never see a partially-populated agent.
        if self.db:
            with self.db.connect() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """INSERT INTO agents
                               (agent_id, gateway_url, gateway_token, session_scope,
                                tenant_id, agent_name, bot_gender, tts_voice_name)
                           VALUES (%s, %s, %s, 'per-peer', %s, %s, %s,
                                   COALESCE(NULLIF(%s, ''), 'Kore'))
                           ON CONFLICT (agent_id) DO UPDATE SET
                               gateway_url = EXCLUDED.gateway_url,
                               gateway_token = EXCLUDED.gateway_token,
                               tenant_id = EXCLUDED.tenant_id,
                               agent_name = EXCLUDED.agent_name,
                               bot_gender = EXCLUDED.bot_gender,
                               tts_voice_name = EXCLUDED.tts_voice_name""",
                        (
                            agent_id, gateway_url, token, tenant_id,
                            agent_name or agent_id,
                            bot_gender or "male",
                            tts_voice_name,
                        ),
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

    async def provision_stream(
        self,
        agent_id: str,
        phone: str,
        agent_name: str,
        user_name: str,
        tenant_id: int,
        bot_gender: str = "",
        user_gender: str = "",
        tts_voice_name: str = "",
    ) -> AsyncIterator[dict[str, Any]]:
        """Mock streaming provision — emits a few fake progress events
        then the actual DB insert + result. Useful for local dev UI work
        without spinning up the VM daemon."""
        steps = [
            (1, 4, "Preparing workspace"),
            (2, 4, "Setting up database"),
            (3, 4, "Starting container"),
            (4, 4, "Waiting for agent to be ready"),
        ]
        for step, total, label in steps:
            yield {"type": "progress", "step": step, "total": total, "label": label}
            await asyncio.sleep(0.3)

        result = self.provision(
            agent_id, phone, agent_name, user_name, tenant_id,
            bot_gender=bot_gender, user_gender=user_gender, tts_voice_name=tts_voice_name,
        )
        yield {
            "type": "result",
            "success": result.success,
            "agent_id": result.agent_id,
            "gateway_url": result.gateway_url,
            "gateway_token": result.gateway_token,
            "port": result.port,
            "error": result.error,
        }

    def deprovision(self, agent_id: str) -> DeprovisionResult:
        logger.info("MOCK: Deprovisioning agent %s", agent_id)
        return DeprovisionResult(agent_id=agent_id, backup_path="gs://mock-backup/")

    def check_health(self, agent_id: str) -> bool:
        logger.info("MOCK: Health check for %s → healthy", agent_id)
        return True


class VmHttpProvisioner:
    """Real provisioner — calls the VM's provision-api.py daemon via
    Direct VPC egress from Cloud Run.

    Config (all env vars, set in the app's Cloud Run deploy):
      AGENTLEH_PROVISION_API_URL   — e.g. "http://10.10.0.3:9200" (dev)
      AGENTLEH_PROVISION_API_TOKEN — bearer token matching the VM's
                                     /opt/agentleh/.env PROVISION_API_TOKEN
                                     (both sides get the same value from
                                     Secret Manager `provision-api-token`)

    The daemon takes 30–60s to return a successful provision (Docker
    pull + container start + health check). We use a 150s client
    timeout to leave headroom over the daemon's 120s internal budget.
    """

    def __init__(self, db=None, base_url: str = "", token: str = ""):
        self.db = db
        self.base_url = (base_url or os.environ.get("AGENTLEH_PROVISION_API_URL", "")).rstrip("/")
        self.token = token or os.environ.get("AGENTLEH_PROVISION_API_TOKEN", "")
        if not self.base_url or not self.token:
            logger.warning(
                "VmHttpProvisioner: AGENTLEH_PROVISION_API_URL or "
                "AGENTLEH_PROVISION_API_TOKEN not set — provisioning will fail"
            )

    def provision(
        self,
        agent_id: str,
        phone: str,
        agent_name: str,
        user_name: str,
        tenant_id: int,
        bot_gender: str = "",
        user_gender: str = "",
        tts_voice_name: str = "",
    ) -> ProvisionResult:
        logger.info(
            "VmHttpProvisioner: provisioning agent=%s tenant=%s phone=%s",
            agent_id,
            tenant_id,
            phone,
        )

        payload: dict[str, object] = {
            "agent_id": agent_id,
            "phone": phone,
            "tenant_id": tenant_id,
        }
        if agent_name:
            payload["agent_name"] = agent_name
        if user_name:
            payload["user_name"] = user_name
        if bot_gender:
            payload["bot_gender"] = bot_gender
        if user_gender:
            payload["user_gender"] = user_gender
        if tts_voice_name:
            payload["tts_voice_name"] = tts_voice_name

        try:
            # httpx.Client (sync) — the onboarding route is async but
            # calls provisioner.provision() directly, not as await.
            with httpx.Client(timeout=150.0) as client:
                resp = client.post(
                    f"{self.base_url}/provision",
                    json=payload,
                    headers={"Authorization": f"Bearer {self.token}"},
                )
        except httpx.HTTPError as exc:
            logger.error("provision-api unreachable: %s", exc)
            return ProvisionResult(
                agent_id=agent_id,
                success=False,
                error=f"provision-api unreachable: {exc}",
            )

        if resp.status_code >= 400:
            # Daemon returned a JSON error body
            try:
                err = resp.json()
            except Exception:  # noqa: BLE001
                err = {"error": "http_error", "status": resp.status_code, "body": resp.text[:400]}
            logger.error("provision-api %s: %s", resp.status_code, err)
            # Prefer stdout (where create-agent.sh sends diagnostic messages
            # like "health check not passing") over stderr (where Docker
            # compose sends progress output like "Container Creating/Started").
            # Take the tail — the real diagnostic is at the end of stdout.
            diag = (err.get("stdout") or "").strip() or (err.get("stderr") or err.get("detail", "")).strip()
            return ProvisionResult(
                agent_id=agent_id,
                success=False,
                error=f"{err.get('error', 'unknown')}: {diag[-400:]}",
            )

        result = resp.json()
        if not result.get("success"):
            diag = (result.get("stdout") or "").strip() or (result.get("stderr") or "").strip()
            error_msg = result.get("error", "unknown")
            if diag:
                error_msg = f"{error_msg}: {diag[-400:]}"
            return ProvisionResult(
                agent_id=agent_id,
                success=False,
                error=error_msg,
            )

        return ProvisionResult(
            agent_id=result.get("agent_id") or agent_id,
            gateway_url=result.get("gateway_url") or "",
            gateway_token=result.get("gateway_token") or "",
            port=int(result.get("port") or 0),
            success=True,
        )

    async def provision_stream(
        self,
        agent_id: str,
        phone: str,
        agent_name: str,
        user_name: str,
        tenant_id: int,
        bot_gender: str = "",
        user_gender: str = "",
        tts_voice_name: str = "",
    ) -> AsyncIterator[dict[str, Any]]:
        """Streaming provision — connects to the daemon's /provision-stream
        endpoint and yields NDJSON events (progress + final result) as
        they arrive. Does not block the event loop (httpx.AsyncClient).
        """
        logger.info(
            "VmHttpProvisioner: streaming provision agent=%s tenant=%s phone=%s",
            agent_id,
            tenant_id,
            phone,
        )

        payload: dict[str, object] = {
            "agent_id": agent_id,
            "phone": phone,
            "tenant_id": tenant_id,
        }
        if agent_name:
            payload["agent_name"] = agent_name
        if user_name:
            payload["user_name"] = user_name
        if bot_gender:
            payload["bot_gender"] = bot_gender
        if user_gender:
            payload["user_gender"] = user_gender
        if tts_voice_name:
            payload["tts_voice_name"] = tts_voice_name

        try:
            async with httpx.AsyncClient(timeout=180.0) as client:
                async with client.stream(
                    "POST",
                    f"{self.base_url}/provision-stream",
                    json=payload,
                    headers={"Authorization": f"Bearer {self.token}"},
                ) as resp:
                    if resp.status_code >= 400:
                        body_text = await resp.aread()
                        try:
                            err = json.loads(body_text.decode("utf-8"))
                        except Exception:  # noqa: BLE001
                            err = {"error": "http_error", "body": body_text.decode("utf-8", "replace")[:400]}
                        logger.error("provision-stream %s: %s", resp.status_code, err)
                        yield {
                            "type": "result",
                            "success": False,
                            "error": f"{err.get('error', 'unknown')}: {err.get('detail', '')[:400]}",
                        }
                        return

                    async for line in resp.aiter_lines():
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            event = json.loads(line)
                        except json.JSONDecodeError:
                            logger.warning("malformed stream line: %s", line[:200])
                            continue
                        yield event
        except httpx.HTTPError as exc:
            logger.error("provision-stream unreachable: %s", exc)
            yield {
                "type": "result",
                "success": False,
                "error": f"provision-api unreachable: {exc}",
            }

    def deprovision(self, agent_id: str) -> DeprovisionResult:
        logger.info("VmHttpProvisioner: deprovisioning agent=%s", agent_id)

        try:
            with httpx.Client(timeout=150.0) as client:
                resp = client.post(
                    f"{self.base_url}/deprovision",
                    json={"agent_id": agent_id},
                    headers={"Authorization": f"Bearer {self.token}"},
                )
        except httpx.HTTPError as exc:
            logger.error("provision-api unreachable (deprovision): %s", exc)
            return DeprovisionResult(
                agent_id=agent_id,
                success=False,
                error=f"provision-api unreachable: {exc}",
            )

        if resp.status_code >= 400:
            try:
                err = resp.json()
            except Exception:  # noqa: BLE001
                err = {"error": "http_error", "status": resp.status_code, "body": resp.text[:400]}
            logger.error("provision-api deprovision %s: %s", resp.status_code, err)
            diag = (err.get("stdout") or "").strip() or (err.get("stderr") or err.get("detail", "")).strip()
            return DeprovisionResult(
                agent_id=agent_id,
                success=False,
                error=f"{err.get('error', 'unknown')}: {diag[-400:]}",
            )

        result = resp.json()
        if not result.get("success"):
            diag = (result.get("stdout") or "").strip() or (result.get("stderr") or "").strip()
            error_msg = result.get("error", "unknown")
            if diag:
                error_msg = f"{error_msg}: {diag[-400:]}"
            return DeprovisionResult(
                agent_id=agent_id,
                success=False,
                error=error_msg,
            )

        return DeprovisionResult(
            agent_id=agent_id,
            backup_path=result.get("backup_path") or "",
        )

    def check_health(self, agent_id: str) -> bool:
        # Daemon doesn't expose a per-agent health endpoint; the app
        # can curl the VM directly via VPC if it ever needs to.
        return True


def pick_provisioner(db) -> AgentProvisioner:
    """Factory used by api/main.py lifespan hook. Returns the right
    implementation based on AGENTLEH_PROVISIONER env var."""
    kind = os.environ.get("AGENTLEH_PROVISIONER", "mock").lower()
    if kind == "vm":
        logger.info("Using VmHttpProvisioner (real VM daemon)")
        return VmHttpProvisioner(db=db)
    logger.info("Using MockProvisioner (local dev / tests)")
    return MockProvisioner(
        db=db,
        gateway_base_url=os.environ.get("APP_GATEWAY_BASE_URL", ""),
    )
