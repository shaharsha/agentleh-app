"""WhatsApp welcome-message service - Protocol, mock, and bridge-backed impl.

The bridge (`bridge.py` in the agentleh-bridge repo) exposes `POST /api/send`
which accepts a `template_name` + `force_template=true` payload to send a
WhatsApp Business template message. This is the ONLY way to initiate a
conversation with a phone outside the 24-hour service window.

Implementation is picked by `pick_whatsapp()` at app startup:
  - If BRIDGE_BASE_URL + BRIDGE_API_KEY are both set -> BridgeWhatsApp
  - Otherwise -> MockWhatsApp (local dev / tests)
"""

from __future__ import annotations

import logging
import os
from typing import Protocol

import httpx

logger = logging.getLogger(__name__)

# Primary welcome templates - warm, first-person, casual, mentioning the
# agent's capabilities + Gmail/Calendar connect hint. Two variants needed
# because Hebrew's role noun and present-tense verb agree with the bot's
# gender ("הסוכן מטפל" vs "הסוכנת מטפלת").
#
# Body (male):
#   היי, אני {{1}}, הסוכן שלך. אני מטפל במיילים, ביומן Google,
#   בחיפושים ברשת, בזיכרון לטווח ארוך, וגם בהודעות קוליות בעברית.
#   כדי לחבר Gmail ויומן Google - פשוט לבקש. במה אפשר להתחיל?
#
# Body (female): same shape with הסוכנת / מטפלת.
#
# These templates will likely be reclassified by Meta to MARKETING because
# of the warm+capabilities framing. That means they're subject to the
# 131049 "healthy ecosystem engagement" per-recipient throttle. For fresh
# users the message should arrive fine; for recipients who've hit the
# throttle it may be silently dropped - that's a known tradeoff for
# prioritizing a human-feeling first touch over delivery guarantees.
WELCOME_TEMPLATE_MALE = "agent_welcome_he_m"
WELCOME_TEMPLATE_FEMALE = "agent_welcome_he_f"
WELCOME_TEMPLATE_LANGUAGE = "he"

# Transactional UTILITY fallback if the gendered template isn't approved
# yet (or Meta rejects it). Guaranteed delivery, cold tone.
UTILITY_TEMPLATE_NAME = "agent_ready_he_v4"
UTILITY_TEMPLATE_LANGUAGE = "he"

# Last-resort fallback for legacy agents where agent_name is empty - the
# original English zero-parameter template.
FALLBACK_TEMPLATE_NAME = "hello_greeting"
FALLBACK_TEMPLATE_LANGUAGE = "en_US"


class WhatsAppService(Protocol):
    def send_welcome(
        self, phone: str, agent_name: str, bot_gender: str = ""
    ) -> bool: ...


class MockWhatsApp:
    def send_welcome(
        self, phone: str, agent_name: str, bot_gender: str = ""
    ) -> bool:
        logger.info(
            "MOCK: Would send welcome message to %s from agent '%s' (gender=%s)",
            phone,
            agent_name,
            bot_gender or "-",
        )
        return True


class BridgeWhatsApp:
    """Real implementation - sends a WhatsApp template message via the
    bridge's authenticated /api/send endpoint.

    Non-fatal: if the bridge is unreachable or the send fails, we log
    and return False. Agent creation should NOT fail because a welcome
    message didn't go through - the user can still message the agent
    directly from their phone.
    """

    def __init__(self, base_url: str = "", api_key: str = ""):
        self.base_url = (base_url or os.environ.get("BRIDGE_BASE_URL", "")).rstrip("/")
        self.api_key = api_key or os.environ.get("BRIDGE_API_KEY", "")
        if not self.base_url or not self.api_key:
            logger.warning(
                "BridgeWhatsApp: BRIDGE_BASE_URL or BRIDGE_API_KEY not set - "
                "welcome messages will be no-ops"
            )

    def _build_payload(self, phone: str, agent_name: str, bot_gender: str) -> dict:
        name = (agent_name or "").strip()
        gender = (bot_gender or "").strip().lower()
        if not name:
            # No agent name -> fall back to the English zero-param template.
            return {
                "to": phone,
                "force_template": True,
                "template_name": FALLBACK_TEMPLATE_NAME,
                "language": FALLBACK_TEMPLATE_LANGUAGE,
                "template_params": [],
            }
        # Pick the gendered warm template. Default to the masculine
        # variant if gender isn't set (matches SOUL.md default).
        template = WELCOME_TEMPLATE_FEMALE if gender == "female" else WELCOME_TEMPLATE_MALE
        return {
            "to": phone,
            "force_template": True,
            "template_name": template,
            "language": WELCOME_TEMPLATE_LANGUAGE,
            "template_params": [name],
        }

    def _post_send(self, payload: dict, phone: str, agent_name: str) -> tuple[bool, dict | None, int]:
        """Return (success, bridge_body, status_code). Non-raising."""
        try:
            with httpx.Client(timeout=15.0) as client:
                resp = client.post(
                    f"{self.base_url}/api/send",
                    json=payload,
                    headers={"Authorization": f"Bearer {self.api_key}"},
                )
        except httpx.HTTPError as exc:
            logger.warning(
                "BridgeWhatsApp: HTTP error sending %s to %s: %s",
                payload.get("template_name"),
                phone,
                exc,
            )
            return False, None, 0

        body = None
        try:
            body = resp.json()
        except Exception:  # noqa: BLE001
            body = {"raw": resp.text[:400]}

        if resp.status_code >= 400:
            logger.warning(
                "BridgeWhatsApp: bridge rejected %s to %s (%s): %s",
                payload.get("template_name"),
                phone,
                resp.status_code,
                resp.text[:400],
            )
            return False, body, resp.status_code

        # Parse wamid + wa_id from Meta's response (nested under bridge's
        # "result" key). A missing wamid means Meta silently dropped the
        # send even though the HTTP status was 200.
        wamid = None
        wa_id = None
        meta_result = body.get("result") if isinstance(body, dict) else None
        if isinstance(meta_result, dict):
            msgs = meta_result.get("messages") or []
            contacts = meta_result.get("contacts") or []
            if msgs and isinstance(msgs[0], dict):
                wamid = msgs[0].get("id")
            if contacts and isinstance(contacts[0], dict):
                wa_id = contacts[0].get("wa_id")
        logger.info(
            "BridgeWhatsApp: sent %s to phone=%s agent=%s status=%s wa_id=%s wamid=%s bridge_status=%s",
            payload.get("template_name"),
            phone,
            agent_name,
            resp.status_code,
            wa_id,
            wamid,
            body.get("status") if isinstance(body, dict) else None,
        )
        return True, body, resp.status_code

    def send_welcome(
        self, phone: str, agent_name: str, bot_gender: str = ""
    ) -> bool:
        if not self.base_url or not self.api_key:
            logger.info("BridgeWhatsApp: skipping welcome to %s (bridge not configured)", phone)
            return False

        # Try the primary gendered warm template first. If the bridge
        # rejects it (usually because the template isn't approved yet
        # after a new submission), fall back to the transactional
        # UTILITY template so the user still receives SOMETHING.
        primary = self._build_payload(phone, agent_name, bot_gender)
        ok, body, status = self._post_send(primary, phone, agent_name)
        if ok:
            return True

        # Only fall back on specific rejection shapes - bridge returning
        # 400 means Meta rejected (usually "template_name does not exist
        # or not approved"). Don't fall back on 5xx or network errors
        # because those might succeed on retry.
        should_fallback = status == 400 and primary["template_name"] != UTILITY_TEMPLATE_NAME
        if not should_fallback or not (agent_name or "").strip():
            return False

        logger.info(
            "BridgeWhatsApp: primary template %s rejected, falling back to %s",
            primary["template_name"],
            UTILITY_TEMPLATE_NAME,
        )
        fallback = {
            "to": phone,
            "force_template": True,
            "template_name": UTILITY_TEMPLATE_NAME,
            "language": UTILITY_TEMPLATE_LANGUAGE,
            "template_params": [agent_name.strip()],
        }
        ok2, _, _ = self._post_send(fallback, phone, agent_name)
        return ok2


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
