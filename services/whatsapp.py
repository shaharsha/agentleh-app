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

# Primary template: strict-UTILITY Hebrew notification with the
# agent's name as {{1}}. Body:
#   Agentiko: הסוכן "{{1}}" הוקם בחשבונך. כדי להתחיל שיחה, יש לשלוח הודעה.
#
# This is intentionally transactional (no first-person warmth, no
# capabilities list, no persuasive language). The actual warm first
# response from the agent - identity, capabilities, Gmail/Calendar
# connect hint - comes in the agent's first conversational reply
# (driven by AGENTS.md "הודעה ראשונה" section), not this template.
#
# Why: Meta's classifier auto-converts warm/first-person templates to
# MARKETING, which is subject to the 131049 "healthy ecosystem
# engagement" throttle - causing silent delivery failures we saw on
# v1/v2. Keeping this strictly UTILITY guarantees reliable delivery;
# the agent's voice lives in the free-form conversation that follows.
HELLO_TEMPLATE_NAME = "agent_ready_he_v4"
HELLO_TEMPLATE_LANGUAGE = "he"

# Fallback for legacy agents where agent_name might be empty — the
# original English template with zero parameters.
FALLBACK_TEMPLATE_NAME = "hello_greeting"
FALLBACK_TEMPLATE_LANGUAGE = "en_US"


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

        # Use the Hebrew template with the agent's name as {{1}} when we
        # have one; fall back to the English zero-param template otherwise
        # (e.g. legacy agents where agent_name is empty).
        name = (agent_name or "").strip()
        if name:
            payload = {
                "to": phone,
                "force_template": True,
                "template_name": HELLO_TEMPLATE_NAME,
                "language": HELLO_TEMPLATE_LANGUAGE,
                "template_params": [name],
            }
        else:
            payload = {
                "to": phone,
                "force_template": True,
                "template_name": FALLBACK_TEMPLATE_NAME,
                "language": FALLBACK_TEMPLATE_LANGUAGE,
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

        # Parse the bridge response so we can log Meta's wamid + the
        # resolved wa_id. A wa_id that differs from `phone` is a strong
        # hint that the number was reformatted by Meta (rare) or that
        # the template was delivered to a different account than
        # expected. Missing wamid = Meta didn't accept the send even
        # though the HTTP status was 200 at some intermediate hop.
        try:
            bridge_body = resp.json()
        except Exception:  # noqa: BLE001
            bridge_body = {"raw": resp.text[:400]}
        meta_result = bridge_body.get("result") if isinstance(bridge_body, dict) else None
        wamid = None
        wa_id = None
        if isinstance(meta_result, dict):
            msgs = meta_result.get("messages") or []
            contacts = meta_result.get("contacts") or []
            if msgs and isinstance(msgs[0], dict):
                wamid = msgs[0].get("id")
            if contacts and isinstance(contacts[0], dict):
                wa_id = contacts[0].get("wa_id")
        logger.info(
            "BridgeWhatsApp: sent %s to phone=%s agent=%s status=%s wa_id=%s wamid=%s bridge_status=%s",
            payload["template_name"],
            phone,
            agent_name,
            resp.status_code,
            wa_id,
            wamid,
            bridge_body.get("status") if isinstance(bridge_body, dict) else None,
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
