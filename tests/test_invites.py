"""Tests for POST /api/invites/accept.

Focus: the onboarding_status advance added after accept_invite. A user
who signs up via an invite to an already-populated tenant shouldn't be
stranded on the coupon-redemption page (the "Activate a plan" screen)
- the backend advances their status so the frontend routes them
straight to the tenant dashboard.

Four cases for the advance logic:

1. pending + joined tenant has agents               -> complete
2. pending + joined tenant has active sub, no agents -> plan_active
3. pending + joined tenant has neither               -> stays pending
4. already plan_active / complete                    -> status untouched
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest

os.environ.setdefault("APP_METER_BASE_URL", "http://meter.test")
os.environ.setdefault("APP_METER_ADMIN_TOKEN", "fake-admin-token")
os.environ.setdefault("APP_PUBLIC_URL", "https://app-dev.agentiko.io")

from fastapi.testclient import TestClient  # noqa: E402

from api.deps import get_current_user  # noqa: E402
from api.main import app  # noqa: E402


TENANT_ID = 77
USER_ID = 42
INVITE_EMAIL = "invitee@example.com"


def _pending_invite(email: str = INVITE_EMAIL) -> dict:
    return {
        "id": 1,
        "tenant_id": TENANT_ID,
        "tenant_name": "Joined Workspace",
        "tenant_slug": "joined",
        "email": email,
        "role": "admin",
        "token_hash": b"\x00" * 32,
        "inviter_name": "Owner",
        "inviter_email": "owner@example.com",
        "invited_by": 1,
        "expires_at": datetime.now(timezone.utc) + timedelta(days=7),
        "accepted_at": None,
        "accepted_by": None,
        "revoked_at": None,
    }


def _accepted_membership() -> dict:
    return {"tenant_id": TENANT_ID, "user_id": USER_ID, "role": "admin"}


def _user(status: str, *, email: str = INVITE_EMAIL) -> dict:
    return {
        "id": USER_ID,
        "email": email,
        "full_name": "Invitee",
        "phone": "",
        "gender": "",
        "onboarding_status": status,
        "role": "user",
    }


@pytest.fixture
def client_factory():
    """Build a TestClient with a caller identity + fully-mocked db.

    Yields (configure, make_client) where configure takes the user dict
    and the desired db.list_tenant_agents / db.get_active_subscription
    return values. Reset on teardown to avoid leaking overrides.
    """

    overrides: dict = {}

    def make(
        *,
        user: dict,
        agents: list | None = None,
        active_sub: dict | None = None,
        invite: dict | None = None,
    ) -> TestClient:
        app.dependency_overrides[get_current_user] = lambda: user

        db = MagicMock()
        db.get_invite_by_token = MagicMock(return_value=invite or _pending_invite())
        db.accept_invite = MagicMock(return_value=_accepted_membership())
        db.list_tenant_agents = MagicMock(return_value=agents or [])
        db.get_active_subscription = MagicMock(return_value=active_sub)
        db.update_user = MagicMock()
        db.log_audit = MagicMock()

        app.state.db = db
        overrides["db"] = db
        return TestClient(app, raise_server_exceptions=False)

    yield make

    app.dependency_overrides.pop(get_current_user, None)


def test_pending_user_joining_tenant_with_agents_becomes_complete(client_factory):
    db_user = _user("pending")
    client = client_factory(
        user=db_user,
        agents=[{"agent_id": "yuval"}],
    )

    response = client.post("/api/invites/accept", json={"token": "tkn"})

    assert response.status_code == 200
    assert response.json()["tenant_id"] == TENANT_ID
    client.app.state.db.update_user.assert_called_once_with(
        USER_ID, onboarding_status="complete"
    )


def test_pending_user_joining_tenant_with_sub_no_agents_becomes_plan_active(
    client_factory,
):
    client = client_factory(
        user=_user("pending"),
        agents=[],
        active_sub={"id": 1, "plan_id": "business", "status": "active"},
    )

    response = client.post("/api/invites/accept", json={"token": "tkn"})

    assert response.status_code == 200
    client.app.state.db.update_user.assert_called_once_with(
        USER_ID, onboarding_status="plan_active"
    )


def test_pending_user_joining_empty_tenant_stays_pending(client_factory):
    client = client_factory(user=_user("pending"), agents=[], active_sub=None)

    response = client.post("/api/invites/accept", json={"token": "tkn"})

    assert response.status_code == 200
    client.app.state.db.update_user.assert_not_called()


def test_plan_active_user_is_never_regressed(client_factory):
    client = client_factory(
        user=_user("plan_active"),
        agents=[{"agent_id": "x"}],
    )

    response = client.post("/api/invites/accept", json={"token": "tkn"})

    assert response.status_code == 200
    client.app.state.db.update_user.assert_not_called()


def test_complete_user_is_never_regressed(client_factory):
    client = client_factory(
        user=_user("complete"),
        agents=[{"agent_id": "x"}],
        active_sub={"id": 1, "plan_id": "business", "status": "active"},
    )

    response = client.post("/api/invites/accept", json={"token": "tkn"})

    assert response.status_code == 200
    client.app.state.db.update_user.assert_not_called()


def test_email_mismatch_does_not_touch_onboarding(client_factory):
    client = client_factory(
        user=_user("pending", email="someone-else@example.com"),
        agents=[{"agent_id": "x"}],
    )

    response = client.post("/api/invites/accept", json={"token": "tkn"})

    assert response.status_code == 403
    client.app.state.db.accept_invite.assert_not_called()
    client.app.state.db.update_user.assert_not_called()
