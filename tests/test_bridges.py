"""Tests for the bridges router + /api/agents/check-phone.

Covers:
  - GET /api/agents/check-phone — valid / duplicate / malformed
  - GET /api/tenants/{tid}/agents/{aid}/bridges — all three bridges
    rendered, cross-tenant 404, telegram connected vs not
  - PATCH .../bridges/whatsapp — connect (happy path), change, duplicate
    409, disconnect, validates normalization, cross-tenant 404
  - DELETE .../bridges/telegram — idempotent disconnect path, calls
    provision-api config-patch + secret-manager delete

Telegram connect (which hits Telegram API + Secret Manager) and the
WebSocket chat proxy are covered by smaller unit-focused tests at the
service layer — full integration is a hand-run step on openclaw-dev.
"""

from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

import pytest

# Same env-prime dance as test_integrations.py so imports resolve
os.environ.setdefault("APP_METER_BASE_URL", "http://meter.test")
os.environ.setdefault("APP_METER_ADMIN_TOKEN", "fake-admin-token")
os.environ.setdefault("APP_PUBLIC_URL", "https://app-dev.agentiko.io")
os.environ.setdefault(
    "APP_GOOGLE_OAUTH_CLIENT_ID", "fake-client-id"
)
os.environ.setdefault(
    "APP_GOOGLE_OAUTH_CLIENT_SECRET", "fake-client-secret"
)
os.environ.setdefault(
    "APP_GOOGLE_CONNECT_JWT_SECRET",
    "0000000000000000000000000000000000000000000000000000000000000000",
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
    require_tenant_role,
)
from api.main import app  # noqa: E402


def _build_ctx(role: str) -> TenantContext:
    return TenantContext(
        tenant={"id": 10, "name": "T", "owner_user_id": 1},
        user={"id": 42, "email": "u@example.com", "full_name": "U"},
        role=role,
    )


@pytest.fixture(autouse=True)
def reset_overrides():
    """Clear FastAPI dependency overrides between tests so role/user
    state doesn't bleed from one case to the next."""
    yield
    app.dependency_overrides.clear()


@pytest.fixture
def client():
    """Logged-in admin client with a mocked db. Individual tests reach
    into app.state.db to program the specific methods they need."""
    # Override both get_current_user (for /check-phone) and the role
    # resolver (for /bridges routes) so routes don't try to hit
    # Supabase JWKS.
    app.dependency_overrides[get_current_user] = lambda: {
        "id": 42, "email": "u@example.com", "full_name": "U"
    }
    # require_tenant_role returns a function per role — our dep
    # override needs to match ANY role, so we shim the underlying
    # get_active_tenant_member the require_tenant_role builder wraps.
    app.dependency_overrides[get_active_tenant_member] = lambda: _build_ctx("admin")

    app.state.db = MagicMock()
    return TestClient(app, raise_server_exceptions=False)


# ─── /api/agents/check-phone ────────────────────────────────────────


def test_check_phone_available(client):
    app.state.db.get_agent_for_phone = MagicMock(return_value=None)
    resp = client.get("/api/agents/check-phone?phone=%2B972546901044")
    assert resp.status_code == 200
    assert resp.json() == {"available": True}


def test_check_phone_taken(client):
    app.state.db.get_agent_for_phone = MagicMock(
        return_value={"agent_id": "someone-else", "tenant_id": 99}
    )
    resp = client.get("/api/agents/check-phone?phone=%2B972546901044")
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"available": False}
    # Response MUST NOT leak the conflicting agent / tenant ids.
    assert "agent_id" not in body
    assert "tenant_id" not in body


def test_check_phone_malformed_400(client):
    resp = client.get("/api/agents/check-phone?phone=not-a-phone")
    assert resp.status_code == 400


# ─── GET /bridges — rendering ───────────────────────────────────────


def test_get_bridges_all_disconnected(client):
    db = app.state.db
    db.get_agent_tenant_id = MagicMock(return_value=10)
    db.get_agent_bridges = MagicMock(return_value=[])
    db.get_phone_for_agent = MagicMock(return_value=None)

    resp = client.get("/api/tenants/10/agents/agent-a/bridges")
    assert resp.status_code == 200
    body = resp.json()
    assert body["agent_id"] == "agent-a"
    bridges = body["bridges"]
    assert bridges["whatsapp"]["enabled"] is False
    assert bridges["whatsapp"]["status"] == "disconnected"
    assert bridges["telegram"]["enabled"] is False
    # Web chat is always on.
    assert bridges["web"]["enabled"] is True
    assert bridges["web"]["status"] == "connected"
    # Tenant-id placeholder must be expanded.
    assert "%TENANT%" not in bridges["web"]["chat_url"]
    assert "/tenants/10/" in bridges["web"]["chat_url"]


def test_get_bridges_whatsapp_connected(client):
    db = app.state.db
    db.get_agent_tenant_id = MagicMock(return_value=10)
    db.get_agent_bridges = MagicMock(return_value=[])
    # Bridge stores phone in digits-only form, app prepends `+` for display.
    db.get_phone_for_agent = MagicMock(return_value="972546901044")

    resp = client.get("/api/tenants/10/agents/agent-a/bridges")
    assert resp.status_code == 200
    wa = resp.json()["bridges"]["whatsapp"]
    assert wa["enabled"] is True
    assert wa["status"] == "connected"
    assert wa["phone"] == "+972546901044"
    assert "edit_phone" in wa["actions"]
    assert "disconnect" in wa["actions"]


def test_get_bridges_telegram_connected(client):
    db = app.state.db
    db.get_agent_tenant_id = MagicMock(return_value=10)
    db.get_agent_bridges = MagicMock(return_value=[
        {
            "agent_id": "agent-a",
            "bridge_type": "telegram",
            "enabled": True,
            "config": {
                "bot_username": "shuli_agent_bot",
                "bot_display_name": "Shuli",
                "secret_name": "telegram-bot-token-agent-a",
            },
            "connected_at": None,
            "updated_at": None,
        }
    ])
    db.get_phone_for_agent = MagicMock(return_value=None)

    resp = client.get("/api/tenants/10/agents/agent-a/bridges")
    assert resp.status_code == 200
    tg = resp.json()["bridges"]["telegram"]
    assert tg["enabled"] is True
    assert tg["status"] == "connected"
    assert tg["bot_username"] == "shuli_agent_bot"


def test_get_bridges_cross_tenant_404(client):
    # Agent belongs to tenant 99, request is for tenant 10.
    app.state.db.get_agent_tenant_id = MagicMock(return_value=99)

    resp = client.get("/api/tenants/10/agents/agent-a/bridges")
    assert resp.status_code == 404


# ─── PATCH /bridges/whatsapp ────────────────────────────────────────


def test_patch_whatsapp_connect(client):
    db = app.state.db
    db.get_agent_tenant_id = MagicMock(return_value=10)
    db.get_phone_for_agent = MagicMock(return_value=None)  # not connected yet
    db.get_agent_for_phone = MagicMock(return_value=None)  # phone is free
    db.set_whatsapp_bridge = MagicMock()
    db.get_agent_bridges = MagicMock(return_value=[])
    db.log_audit = MagicMock()

    resp = client.patch(
        "/api/tenants/10/agents/agent-a/bridges/whatsapp",
        json={"phone": "+972546901044"},
    )
    assert resp.status_code == 200, resp.text
    db.set_whatsapp_bridge.assert_called_once_with("agent-a", "+972546901044")
    # Audit log should record the connect event with the phone.
    args, kwargs = db.log_audit.call_args
    assert kwargs["action"] == "agent.whatsapp.connect"


def test_patch_whatsapp_duplicate_409(client):
    db = app.state.db
    db.get_agent_tenant_id = MagicMock(return_value=10)
    db.get_phone_for_agent = MagicMock(return_value=None)
    # Phone already held by DIFFERENT agent.
    db.get_agent_for_phone = MagicMock(
        return_value={"agent_id": "other-agent", "tenant_id": 99}
    )
    db.set_whatsapp_bridge = MagicMock()

    resp = client.patch(
        "/api/tenants/10/agents/agent-a/bridges/whatsapp",
        json={"phone": "+972546901044"},
    )
    assert resp.status_code == 409
    assert resp.json()["detail"]["error"] == "phone_already_in_use"
    # Critical: DB mutation did NOT happen.
    db.set_whatsapp_bridge.assert_not_called()


def test_patch_whatsapp_same_phone_not_duplicate(client):
    """Re-submitting the SAME phone for the SAME agent must succeed —
    get_agent_for_phone returns a row but for the same agent_id."""
    db = app.state.db
    db.get_agent_tenant_id = MagicMock(return_value=10)
    db.get_phone_for_agent = MagicMock(return_value="972546901044")
    db.get_agent_for_phone = MagicMock(
        return_value={"agent_id": "agent-a", "tenant_id": 10}
    )
    db.set_whatsapp_bridge = MagicMock()
    db.get_agent_bridges = MagicMock(return_value=[])
    db.log_audit = MagicMock()

    resp = client.patch(
        "/api/tenants/10/agents/agent-a/bridges/whatsapp",
        json={"phone": "+972546901044"},
    )
    assert resp.status_code == 200
    # update, not connect, since a phone was already bound.
    db.set_whatsapp_bridge.assert_called_once()


def test_patch_whatsapp_disconnect(client):
    db = app.state.db
    db.get_agent_tenant_id = MagicMock(return_value=10)
    db.get_phone_for_agent = MagicMock(return_value="972546901044")
    db.set_whatsapp_bridge = MagicMock()
    db.get_agent_bridges = MagicMock(return_value=[])
    db.log_audit = MagicMock()

    resp = client.patch(
        "/api/tenants/10/agents/agent-a/bridges/whatsapp",
        json={"phone": None},
    )
    assert resp.status_code == 200
    db.set_whatsapp_bridge.assert_called_once_with("agent-a", None)
    assert db.log_audit.call_args.kwargs["action"] == "agent.whatsapp.disconnect"


def test_patch_whatsapp_cross_tenant_404(client):
    app.state.db.get_agent_tenant_id = MagicMock(return_value=99)
    resp = client.patch(
        "/api/tenants/10/agents/agent-a/bridges/whatsapp",
        json={"phone": "+972546901044"},
    )
    assert resp.status_code == 404


# ─── DELETE /bridges/telegram — idempotent ──────────────────────────


def test_disconnect_telegram_idempotent(client):
    db = app.state.db
    db.get_agent_tenant_id = MagicMock(return_value=10)
    db.disconnect_telegram_bridge = MagicMock(return_value=None)  # nothing there
    db.get_agent_bridges = MagicMock(return_value=[])
    db.get_phone_for_agent = MagicMock(return_value=None)

    resp = client.delete("/api/tenants/10/agents/agent-a/bridges/telegram")
    # Should return 200 + the rendered bridge state, not 404.
    assert resp.status_code == 200


def test_disconnect_telegram_happy_path(client):
    db = app.state.db
    db.get_agent_tenant_id = MagicMock(return_value=10)
    db.disconnect_telegram_bridge = MagicMock(
        return_value={
            "config": {
                "bot_username": "shuli_bot",
                "secret_name": "telegram-bot-token-agent-a",
            }
        }
    )
    db.get_agent_bridges = MagicMock(return_value=[])
    db.get_phone_for_agent = MagicMock(return_value=None)
    db.log_audit = MagicMock()

    # Stub the provisioner's patch_agent_config + secret_manager.delete
    app.state.provisioner = MagicMock()
    app.state.provisioner.patch_agent_config = MagicMock(
        return_value={"success": True, "revision": "abc", "restarted": True}
    )

    with patch("services.secret_manager.delete_secret") as del_secret:
        resp = client.delete("/api/tenants/10/agents/agent-a/bridges/telegram")

    assert resp.status_code == 200
    # Config patch must have disabled the channel.
    app.state.provisioner.patch_agent_config.assert_called_once()
    patch_kwargs = app.state.provisioner.patch_agent_config.call_args.kwargs
    assert patch_kwargs["openclaw_json_patch"]["channels"]["telegram"]["enabled"] is False
    # Secret must have been deleted.
    del_secret.assert_called_once_with("telegram-bot-token-agent-a")
    # Audit logged.
    assert db.log_audit.call_args.kwargs["action"] == "agent.telegram.disconnect"
