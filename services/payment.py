"""Payment service — Protocol + mock implementation."""

from __future__ import annotations

import logging
from typing import Any, Protocol

logger = logging.getLogger(__name__)


class PaymentService(Protocol):
    def create_checkout(self, user_id: int, plan: str) -> dict[str, Any]: ...
    def confirm(self, user_id: int, session_id: str) -> dict[str, Any]: ...


class MockPayment:
    def create_checkout(self, user_id: int, plan: str) -> dict[str, Any]:
        logger.info("MOCK: Creating checkout for user %d, plan %s", user_id, plan)
        return {
            "checkout_url": "https://mock-payment.example.com/checkout",
            "session_id": f"mock_session_{user_id}",
            "plan": plan,
        }

    def confirm(self, user_id: int, session_id: str) -> dict[str, Any]:
        logger.info("MOCK: Confirming payment for user %d, session %s", user_id, session_id)
        return {
            "success": True,
            "plan": "starter",
            "status": "mock_active",
        }
