"""WhatsApp welcome message service — Protocol + mock implementation."""

from __future__ import annotations

import logging
from typing import Protocol

logger = logging.getLogger(__name__)


class WhatsAppService(Protocol):
    def send_welcome(self, phone: str, agent_name: str) -> bool: ...


class MockWhatsApp:
    def send_welcome(self, phone: str, agent_name: str) -> bool:
        logger.info("MOCK: Would send welcome message to %s from agent '%s'", phone, agent_name)
        return True
