"""Tests for the per-agent integrations router.

Covers:

- List integrations (member+): happy path + unknown agent + cross-tenant 404
- Start Google connect (admin+): happy path + member gets 403 + validates
  login_hint is in the JWT + returns URL pointing at /api/oauth/google/start
- Disconnect Google (admin+): happy path proxies to meter, member 403,
  meter error surfaces as 502

FastAPI dependency overrides are used to bypass Supabase JWT verification
and tenant resolution so each test can focus on the route logic.

Env is primed BEFORE importing services because pydantic/env helpers
read at module load.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

# Prime env BEFORE importing services (same as test_google_oauth.py)
os.environ.setdefault("APP_GOOGLE_OAUTH_CLIENT_ID", "fake-client-id")
os.environ.setdefault("APP_GOOGLE_OAUTH_CLIENT_SECRET", "fake-client-secret")
os.environ.setdefault(
    "APP_GOOGLE_CONNECT_JWT_SECRET",
    "0000000000000000000000000000000000000000000000000000000000000000",
)
os.environ.setdefault(
    "APP_GOOGLE_OAUTH_REDIRECT_URI",
    "http://localhost:8000/api/oauth/google/callback",
)
os.environ.setdefault("APP_METER_BASE_URL", "http://meter.test")
os.environ.setdefault("APP_METER_ADMIN_TOKEN", "fake-admin-token")
os.environ.setdefault("APP_PUBLIC_URL", "https://app-dev.agentiko.io")

from fastapi.testclient import TestClient  # noqa: E402

from api.deps import TenantContext, get_active_tenant_member  # noqa: E402
from api.main import app  # noqa: E402
from services import meter_client  # noqa: E402


# ─────────────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────────────


def _build_ctx(role: str) -> TenantContext:
    return TenantContext(
        tenant={"id": 10, "name": "T", "owner_user_id": 1},
        user={"id": 42, "email": "u@example.com", "full_name": "U"},
        role=role,
    )


def _agent_row(*, agent_id: str = "agent-a", tenant_id: int = 10) -> dict:
    return {
        "agent_id": agent_id,
        "gateway_url": "ws://10.10.0.2:18789",
        "tenant_id": tenant_id,
        "agent_name": "Shuli",
        "agent_gender": "female",
        "status": "active",
    }


def _google_row() -> dict:
    return {
        "google_email": "user@gmail.com",
        "scopes": [
            "https://www.googleapis.com/auth/calendar",
            "https://www.googleapis.com/auth/gmail.modify",
        ],
        "capabilities": ["calendar", "email"],
        "granted_at": datetime(2026, 4, 14, 12, 0, tzinfo=timezone.utc),
    }


@pytest.fixture
def client_with_role():
    """Build a TestClient that overrides the tenant-auth dependency with a
    caller of the given role. Returns (factory, reset) so tests control
    the role per-call and can verify 403s.
    """
    overrides: dict = {}

    def set_role(role: str) -> None:
        overrides["role"] = role
        app.dependency_overrides[get_active_tenant_member] = lambda: _build_ctx(role)

    def reset() -> None:
        app.dependency_overrides.pop(get_active_tenant_member, None)

    yield set_role, reset
    reset()


@pytest.fixture
def client(client_with_role):
    set_role, _ = client_with_role
    set_role("admin")  # default

    app.state.db = MagicMock()
    app.state.db.get_agent_details = MagicMock(return_value=_agent_row())

    return TestClient(app, raise_server_exceptions=False)


# ─────────────────────────────────────────────────────────────────────────
# GET /tenants/{tid}/agents/{aid}/integrations
# ─────────────────────────────────────────────────────────────────────────


def test_list_integrations_not_connected(client, client_with_role, monkeypatch):
    set_role, _ = client_with_role
    set_role("member")  # members can view

    monkeypatch.setattr(
        "api.routes.integrations.google_oauth.fetch_credentials",
        lambda db, *, agent_id: None,
    )

    resp = client.get(
        "/api/tenants/10/agents/agent-a/integrations",
        headers={"Authorization": "Bearer fake"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["agent_id"] == "agent-a"
    assert body["tenant_id"] == 10
    assert body["integrations"]["google"]["connected"] is False
    assert body["integrations"]["google"]["name"] == "Google Calendar + Gmail"


def test_list_integrations_connected(client, client_with_role, monkeypatch):
    set_role, _ = client_with_role
    set_role("member")

    monkeypatch.setattr(
        "api.routes.integrations.google_oauth.fetch_credentials",
        lambda db, *, agent_id: _google_row(),
    )

    resp = client.get(
        "/api/tenants/10/agents/agent-a/integrations",
        headers={"Authorization": "Bearer fake"},
    )
    assert resp.status_code == 200
    google = resp.json()["integrations"]["google"]
    assert google["connected"] is True
    assert google["email"] == "user@gmail.com"
    assert "manage_calendar" in google["capabilities"]["can"]
    assert "send_email" in google["capabilities"]["can"]
    assert "read_email" in google["capabilities"]["can"]
    # With gmail.modify via Nylas, email read is no longer in "cannot"
    assert "read_email" not in google["capabilities"]["cannot"]
    assert google["granted_at"].startswith("2026-04-14")


def test_list_integrations_unknown_agent_404(client, client_with_role):
    set_role, _ = client_with_role
    set_role("member")
    app.state.db.get_agent_details = MagicMock(return_value=None)

    resp = client.get(
        "/api/tenants/10/agents/ghost/integrations",
        headers={"Authorization": "Bearer fake"},
    )
    assert resp.status_code == 404
    assert resp.json()["detail"]["error"] == "agent_not_in_tenant"


def test_list_integrations_agent_in_different_tenant_404(client, client_with_role):
    set_role, _ = client_with_role
    set_role("member")
    app.state.db.get_agent_details = MagicMock(
        return_value=_agent_row(tenant_id=99)
    )

    resp = client.get(
        "/api/tenants/10/agents/agent-a/integrations",
        headers={"Authorization": "Bearer fake"},
    )
    assert resp.status_code == 404
    assert resp.json()["detail"]["error"] == "agent_not_in_tenant"


# ─────────────────────────────────────────────────────────────────────────
# POST /tenants/{tid}/agents/{aid}/integrations/google/connect
# ─────────────────────────────────────────────────────────────────────────


def test_connect_requires_admin_role(client, client_with_role):
    set_role, _ = client_with_role
    set_role("member")

    resp = client.post(
        "/api/tenants/10/agents/agent-a/integrations/google/connect",
        headers={"Authorization": "Bearer fake"},
        json={},
    )
    assert resp.status_code == 403
    assert resp.json()["detail"]["error"] == "insufficient_role"


def test_connect_happy_path_returns_url(client):
    resp = client.post(
        "/api/tenants/10/agents/agent-a/integrations/google/connect",
        headers={"Authorization": "Bearer fake"},
        json={},
    )
    assert resp.status_code == 200
    body = resp.json()
    # URL goes to the /api/oauth/google/start entry point with the JWT as ?t=
    assert body["connect_url"].startswith(
        "https://app-dev.agentiko.io/api/oauth/google/start?t="
    )
    assert body["expires_in_seconds"] == 15 * 60

    # Sanity: the embedded JWT carries the agent_id + redirect_to back to
    # the tenant's workspace page (where the integrations panel lives)
    from services import google_oauth

    token = body["connect_url"].split("?t=", 1)[1]
    claims = google_oauth.verify_connect_jwt(token)
    assert claims.agent_id == "agent-a"
    assert claims.redirect_to == "https://app-dev.agentiko.io/tenants/10"
    assert claims.login_hint is None


def test_connect_propagates_login_hint(client):
    resp = client.post(
        "/api/tenants/10/agents/agent-a/integrations/google/connect",
        headers={"Authorization": "Bearer fake"},
        json={"login_hint": "alice@example.com"},
    )
    assert resp.status_code == 200

    from services import google_oauth

    token = resp.json()["connect_url"].split("?t=", 1)[1]
    claims = google_oauth.verify_connect_jwt(token)
    assert claims.login_hint == "alice@example.com"


def test_connect_propagates_capabilities(client):
    resp = client.post(
        "/api/tenants/10/agents/agent-a/integrations/google/connect",
        headers={"Authorization": "Bearer fake"},
        json={"capabilities": ["calendar"]},
    )
    assert resp.status_code == 200

    from services import google_oauth

    token = resp.json()["connect_url"].split("?t=", 1)[1]
    claims = google_oauth.verify_connect_jwt(token)
    assert claims.capabilities == ["calendar"]


def test_connect_rejects_unknown_capability(client):
    resp = client.post(
        "/api/tenants/10/agents/agent-a/integrations/google/connect",
        headers={"Authorization": "Bearer fake"},
        json={"capabilities": ["ninjas"]},
    )
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "invalid_capability"


def test_connect_agent_not_in_tenant_404(client):
    app.state.db.get_agent_details = MagicMock(return_value=_agent_row(tenant_id=99))
    resp = client.post(
        "/api/tenants/10/agents/agent-a/integrations/google/connect",
        headers={"Authorization": "Bearer fake"},
        json={},
    )
    assert resp.status_code == 404


# ─────────────────────────────────────────────────────────────────────────
# DELETE /tenants/{tid}/agents/{aid}/integrations/google
# ─────────────────────────────────────────────────────────────────────────


def test_disconnect_requires_admin_role(client, client_with_role):
    set_role, _ = client_with_role
    set_role("member")

    resp = client.delete(
        "/api/tenants/10/agents/agent-a/integrations/google",
        headers={"Authorization": "Bearer fake"},
    )
    assert resp.status_code == 403


def test_disconnect_happy_path(client, monkeypatch):
    mock_revoke = AsyncMock(
        return_value={"agent_id": "agent-a", "revoked": True, "email": "u@gmail.com"}
    )
    monkeypatch.setattr(
        "api.routes.integrations.revoke_nylas_credentials", mock_revoke
    )

    resp = client.delete(
        "/api/tenants/10/agents/agent-a/integrations/google",
        headers={"Authorization": "Bearer fake"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"revoked": True, "email": "u@gmail.com"}
    mock_revoke.assert_awaited_once_with(agent_id="agent-a")


def test_disconnect_idempotent(client, monkeypatch):
    """Disconnect when nothing is connected is a no-op that still returns 200."""
    mock_revoke = AsyncMock(
        return_value={"agent_id": "agent-a", "revoked": False, "email": None}
    )
    monkeypatch.setattr(
        "api.routes.integrations.revoke_nylas_credentials", mock_revoke
    )

    resp = client.delete(
        "/api/tenants/10/agents/agent-a/integrations/google",
        headers={"Authorization": "Bearer fake"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["revoked"] is False
    assert body["email"] is None


def test_disconnect_meter_error_surfaces_as_502(client, monkeypatch):
    async def _boom(**_kwargs):
        raise meter_client.MeterClientError("meter down", status_code=502)

    monkeypatch.setattr(
        "api.routes.integrations.revoke_nylas_credentials", _boom
    )

    resp = client.delete(
        "/api/tenants/10/agents/agent-a/integrations/google",
        headers={"Authorization": "Bearer fake"},
    )
    assert resp.status_code == 502
    assert resp.json()["detail"]["error"] == "meter_unreachable"
