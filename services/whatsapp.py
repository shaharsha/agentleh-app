"""WhatsApp welcome-message service — Protocol, mock, and bridge-backed impl.

The bridge (`bridge.py` in the agentleh-bridge repo) exposes `POST /api/send`
which accepts a `template_name` + `force_template=true` payload to send a
WhatsApp Business template message. This is the ONLY way to initiate a
conversation with a phone outside the 24-hour service window.

For agent onboarding, we use the pre-approved `hello_greeting` template
(body: "Hello! This is Agentleh. How can I help you today?"). The template
has 0 parameters, so the payload is trivial.

Implementation is picked by `pick_whatsapp()` at app startup:
  - If BRIDGE_BASE_URL + BRIDGE_API_KEY are both set → BridgeWhatsApp
  - Otherwise → MockWhatsApp (local dev / tests)
"""

from __future__ import annotations

import logging
import os
from typing import Protocol

import httpx

logger = logging.getLogger(__name__)

# The template has to exist + be APPROVED in Meta Business Manager on
# the shared WABA before the bridge will accept a send. Currently there
# is exactly one approved template: `hello_greeting`. If the Meta
# template registry gains a better welcome template later, swap this.
HELLO_TEMPLATE_NAME = "hello_greeting"
HELLO_TEMPLATE_LANGUAGE = "en_US"


class WhatsAppService(Protocol):
    def send_welcome(self, phone: str, agent_name: str) -> bool: ...


class MockWhatsApp:
    def send_welcome(self, phone: str, agent_name: str) -> bool:
        logger.info("MOCK: Would send welcome message to %s from agent '%s'", phone, agent_name)
        return True


class BridgeWhatsApp:
    """Real implementation — sends a WhatsApp template message via the
    bridge's authenticated /api/send endpoint.

    Non-fatal: if the bridge is unreachable or the send fails, we log
    and return False. Agent creation should NOT fail because a welcome
    message didn't go through — the user can still message the agent
    directly from their phone.
    """

    def __init__(self, base_url: str = "", api_key: str = ""):
        self.base_url = (base_url or os.environ.get("BRIDGE_BASE_URL", "")).rstrip("/")
        self.api_key = api_key or os.environ.get("BRIDGE_API_KEY", "")
        if not self.base_url or not self.api_key:
            logger.warning(
                "BridgeWhatsApp: BRIDGE_BASE_URL or BRIDGE_API_KEY not set — "
                "welcome messages will be no-ops"
            )

    def send_welcome(self, phone: str, agent_name: str) -> bool:
        if not self.base_url or not self.api_key:
            logger.info("BridgeWhatsApp: skipping welcome to %s (bridge not configured)", phone)
            return False

        payload = {
            "to": phone,
            "force_template": True,
            "template_name": HELLO_TEMPLATE_NAME,
            "language": HELLO_TEMPLATE_LANGUAGE,
            "template_params": [],
        }

        try:
            with httpx.Client(timeout=15.0) as client:
                resp = client.post(
                    f"{self.base_url}/api/send",
                    json=payload,
                    headers={"Authorization": f"Bearer {self.api_key}"},
                )
        except httpx.HTTPError as exc:
            logger.warning("BridgeWhatsApp: send failed for %s: %s", phone, exc)
            return False

        if resp.status_code >= 400:
            logger.warning(
                "BridgeWhatsApp: bridge rejected welcome to %s (%s): %s",
                phone,
                resp.status_code,
                resp.text[:400],
            )
            return False

        logger.info(
            "BridgeWhatsApp: sent %s template to %s (agent=%s)",
            HELLO_TEMPLATE_NAME,
            phone,
            agent_name,
        )
        return True


def pick_whatsapp() -> WhatsAppService:
    """Factory used by api/main.py lifespan hook. Returns the real
    bridge-backed implementation if BRIDGE_BASE_URL + BRIDGE_API_KEY
    are set, otherwise the mock."""
    base_url = os.environ.get("BRIDGE_BASE_URL", "").strip()
    api_key = os.environ.get("BRIDGE_API_KEY", "").strip()
    if base_url and api_key:
        logger.info("Using BridgeWhatsApp (real welcome messages via %s)", base_url)
        return BridgeWhatsApp(base_url=base_url, api_key=api_key)
    logger.info("Using MockWhatsApp (BRIDGE_BASE_URL / BRIDGE_API_KEY not set)")
    return MockWhatsApp()
