"""Post-provision creator attribution — ensures `db.set_agent_creator`
is called with the authenticated user's id after a successful provision
on both entry points:

  - POST /api/tenants/{tid}/agents   (standalone create, tenants.py)
  - POST /api/onboarding/submit       (first-agent create, onboarding.py)

Background: the `agents` table has no creator column writable by
create-agent.sh on the VM (the shell script doesn't see the HTTP
caller). Meter migration 025 adds `agents.created_by_user_id` as
nullable; the app plumbs it via a post-provision UPDATE. The test
locks in that the UPDATE is called with the right (agent_id, user_id)
even when the user provisioning is NOT the tenant owner — the original
bug that motivated this migration.
"""

from __future__ import annotations

import os
from unittest.mock import AsyncMock, MagicMock

import pytest

os.environ.setdefault("APP_METER_BASE_URL", "http://meter.test")
os.environ.setdefault("APP_METER_ADMIN_TOKEN", "fake-admin-token")
os.environ.setdefault("APP_PUBLIC_URL", "https://app-dev.agentiko.io")
os.environ.setdefault("APP_GOOGLE_OAUTH_CLIENT_ID", "fake-client-id")
os.environ.setdefault("APP_GOOGLE_OAUTH_CLIENT_SECRET", "fake-client-secret")
os.environ.setdefault(
    "APP_GOOGLE_CONNECT_JWT_SECRET",
    "0" * 64,
)
os.environ.setdefault(
    "APP_GOOGLE_OAUTH_REDIRECT_URI",
    "http://localhost:8000/api/oauth/google/callback",
)

from fastapi.testclient import TestClient  # noqa: E402

from api.deps import (  # noqa: E402
    TenantContext,
    get_active_tenant_member,
    get_current_user,
)
from api.main import app  # noqa: E402


YUVAL_ID = 415
SHAHAR_ID = 2
TENANT_ID = 2


def _ctx(user_id: int, role: str) -> TenantContext:
    return TenantContext(
        tenant={"id": TENANT_ID, "name": "Shahar's workspace", "owner_user_id": SHAHAR_ID},
        user={"id": user_id, "email": f"u{user_id}@example.com", "full_name": f"user{user_id}"},
        role=role,
    )


async def _fake_stream_success():
    """Mimic the NDJSON shape MockProvisioner / VmHttpProvisioner emit."""
    yield {"type": "progress", "step": 1, "total": 4, "label": "Preparing workspace"}
    yield {
        "type": "result",
        "success": True,
        "agent_id": "t2-miko-0f1d",
        "gateway_url": "ws://127.0.0.1:18800",
        "gateway_token": "tok",
        "port": 18800,
    }


@pytest.fixture(autouse=True)
def reset_overrides():
    yield
    app.dependency_overrides.clear()


@pytest.fixture
def client():
    """Authenticated as Yuval (admin on tenant 2, NOT the owner)."""
    yuval = {"id": YUVAL_ID, "email": "y@uxwritinghub.com", "full_name": "Yuval"}
    app.dependency_overrides[get_current_user] = lambda: yuval
    app.dependency_overrides[get_active_tenant_member] = lambda: _ctx(YUVAL_ID, "admin")

    db = MagicMock()
    db.get_active_subscription = MagicMock(
        return_value={"id": 1, "plan_id": "business", "status": "active"}
    )
    db.get_agent_for_phone = MagicMock(return_value=None)
    db.set_agent_creator = MagicMock()
    db.log_audit = MagicMock()
    app.state.db = db

    provisioner = MagicMock()
    provisioner.provision_stream = MagicMock(side_effect=lambda **_: _fake_stream_success())
    app.state.provisioner = provisioner

    return TestClient(app, raise_server_exceptions=False)


def test_tenant_agents_stream_records_creator_as_authenticated_user(client):
    resp = client.post(
        f"/api/tenants/{TENANT_ID}/agents",
        json={
            "agent_name": "Miko",
            "agent_gender": "male",
            "user_name": "Yuval",
            "user_gender": "male",
            "phone": "",
        },
    )

    assert resp.status_code == 200, resp.text
    # Stream drained fully — the last event is the success result.
    assert b"\"success\": true" in resp.content

    # Creator attribution was written with the AUTHENTICATED user's id,
    # NOT the tenant owner's id. This is the bug fix under test.
    app.state.db.set_agent_creator.assert_called_once_with(
        "t2-miko-0f1d", YUVAL_ID
    )
    assert app.state.db.set_agent_creator.call_args.args[1] != SHAHAR_ID


def test_tenant_agents_stream_creator_update_failure_is_non_fatal(client):
    """A DB glitch on the post-provision UPDATE must not 500 the stream —
    the agent is already live on the VM; losing attribution is recoverable."""
    app.state.db.set_agent_creator.side_effect = RuntimeError("DB flaky")

    resp = client.post(
        f"/api/tenants/{TENANT_ID}/agents",
        json={
            "agent_name": "Miko",
            "agent_gender": "male",
            "user_name": "Yuval",
            "user_gender": "male",
            "phone": "",
        },
    )

    assert resp.status_code == 200
    assert b"\"success\": true" in resp.content
    # log_audit still fires — proving the route kept going past the
    # set_agent_creator failure.
    app.state.db.log_audit.assert_called_once()


def test_onboarding_submit_records_caller_as_creator():
    """Onboarding path: the caller is always the tenant owner today,
    but we still write the column explicitly so "Created by" is never
    NULL for post-migration-025 agents."""
    user = {
        "id": SHAHAR_ID,
        "email": "me@shahar.sh",
        "full_name": "Shahar",
        "onboarding_status": "plan_active",
        "phone": "",
    }
    app.dependency_overrides[get_current_user] = lambda: user

    db = MagicMock()
    db.update_user = MagicMock()
    db.ensure_default_tenant = MagicMock(
        return_value={"id": TENANT_ID, "name": "Shahar's workspace"}
    )
    db.get_user_by_id = MagicMock(return_value=user)
    db.set_agent_creator = MagicMock()
    app.state.db = db

    provisioner = MagicMock()

    async def _stream():
        yield {"type": "progress", "step": 1, "total": 4, "label": "x"}
        yield {
            "type": "result",
            "success": True,
            "agent_id": f"agent-{SHAHAR_ID}-miko",
            "gateway_url": "ws://127.0.0.1:18800",
            "port": 18800,
        }

    provisioner.provision_stream = MagicMock(side_effect=lambda **_: _stream())
    app.state.provisioner = provisioner

    whatsapp = MagicMock()
    whatsapp.send_welcome = MagicMock()
    app.state.whatsapp = whatsapp

    client = TestClient(app, raise_server_exceptions=False)
    resp = client.post(
        "/api/onboarding/submit",
        json={
            "full_name": "Shahar",
            "gender": "male",
            "agent_name": "Miko",
            "agent_gender": "male",
            "phone": "",
        },
    )

    assert resp.status_code == 200, resp.text
    assert b"\"success\": true" in resp.content
    db.set_agent_creator.assert_called_once_with(
        f"agent-{SHAHAR_ID}-miko", SHAHAR_ID
    )
