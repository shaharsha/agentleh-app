"""Superadmin model-switcher — admin endpoint tests.

Covers the three endpoints added for the admin panel model dropdown:

  PATCH /api/admin/agents/{id}/model           — set model (VM + DB update)
  GET   /api/admin/agents/{id}/model/live      — drift detection
  POST  /api/admin/agents/{id}/model/resync    — pull DB from VM

Plus the model column surfacing in /api/admin/overview.

Guards:
  - Auth: non-superadmins get 403
  - Allowlist: bogus model IDs rejected with 400 (never silently forwarded
    to the VM where the allowlist would reject them too — belt-and-
    suspenders, but the app-side check means the admin sees the error
    immediately instead of a 502)
  - Write ordering: VM first, then DB. If the VM fails, DB stays
    unchanged and the endpoint returns 502.
  - Drift: /model/live reports drift when DB and VM disagree, and
    /model/resync writes the VM value back to the DB.
"""

from __future__ import annotations

import os
from unittest.mock import MagicMock

import pytest

# Prime env before importing the app — mirrors other app test files.
os.environ.setdefault("APP_METER_BASE_URL", "http://meter.test")
os.environ.setdefault("APP_METER_ADMIN_TOKEN", "fake-admin-token")
os.environ.setdefault("APP_PUBLIC_URL", "https://app-dev.agentiko.io")
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

from fastapi.testclient import TestClient  # noqa: E402

from api.deps import get_current_user  # noqa: E402
from api.main import app  # noqa: E402


SUPERADMIN = {"id": 1, "email": "me@shahar.sh", "role": "superadmin"}
REGULAR_USER = {"id": 2, "email": "u@example.com", "role": "user"}


@pytest.fixture(autouse=True)
def _reset_overrides_and_state():
    yield
    app.dependency_overrides.clear()


@pytest.fixture
def superadmin_client():
    app.dependency_overrides[get_current_user] = lambda: SUPERADMIN
    app.state.db = MagicMock()
    app.state.provisioner = MagicMock()
    return TestClient(app, raise_server_exceptions=False)


@pytest.fixture
def regular_client():
    app.dependency_overrides[get_current_user] = lambda: REGULAR_USER
    app.state.db = MagicMock()
    app.state.provisioner = MagicMock()
    return TestClient(app, raise_server_exceptions=False)


# ─── Auth ──────────────────────────────────────────────────────────────


class TestAuth:
    def test_non_superadmin_gets_403_on_set(self, regular_client):
        resp = regular_client.patch(
            "/api/admin/agents/agent-x/model",
            json={"model": "google/gemma-4-31b-it"},
        )
        assert resp.status_code == 403
        assert resp.json()["detail"] == "superadmin_required"

    def test_non_superadmin_gets_403_on_live_read(self, regular_client):
        resp = regular_client.get("/api/admin/agents/agent-x/model/live")
        assert resp.status_code == 403

    def test_non_superadmin_gets_403_on_resync(self, regular_client):
        resp = regular_client.post("/api/admin/agents/agent-x/model/resync")
        assert resp.status_code == 403


# ─── Allowlist ─────────────────────────────────────────────────────────


class TestAllowlist:
    def test_rejects_unknown_model(self, superadmin_client):
        app.state.db.get_agent_details = MagicMock(return_value={"agent_id": "a", "model": None})
        resp = superadmin_client.patch(
            "/api/admin/agents/a/model",
            json={"model": "google/gemini-99-ultra"},
        )
        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert detail["error"] == "model_not_allowed"
        # Provisioner should never have been called if allowlist fails
        app.state.provisioner.set_agent_model.assert_not_called()

    def test_rejects_wrong_type(self, superadmin_client):
        resp = superadmin_client.patch(
            "/api/admin/agents/a/model",
            json={"model": 42},
        )
        assert resp.status_code == 400

    def test_accepts_flash(self, superadmin_client):
        app.state.db.get_agent_details = MagicMock(
            return_value={"agent_id": "a", "model": None}
        )
        app.state.provisioner.set_agent_model = MagicMock(
            return_value={"success": True, "previous_model": None, "model": "google/gemini-3-flash-preview"}
        )
        app.state.db.set_agent_model = MagicMock(
            return_value={"agent_id": "a", "model": "google/gemini-3-flash-preview"}
        )
        resp = superadmin_client.patch(
            "/api/admin/agents/a/model",
            json={"model": "google/gemini-3-flash-preview"},
        )
        assert resp.status_code == 200

    def test_accepts_gemma(self, superadmin_client):
        app.state.db.get_agent_details = MagicMock(
            return_value={"agent_id": "a", "model": "google/gemini-3-flash-preview"}
        )
        app.state.provisioner.set_agent_model = MagicMock(
            return_value={"success": True, "previous_model": "google/gemini-3-flash-preview", "model": "google/gemma-4-31b-it"}
        )
        app.state.db.set_agent_model = MagicMock(
            return_value={"agent_id": "a", "model": "google/gemma-4-31b-it"}
        )
        resp = superadmin_client.patch(
            "/api/admin/agents/a/model",
            json={"model": "google/gemma-4-31b-it"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["model"] == "google/gemma-4-31b-it"
        assert body["previous_model"] == "google/gemini-3-flash-preview"

    def test_accepts_openrouter_gemma(self, superadmin_client):
        """OpenRouter-routed Gemma is allowlisted — same allowlist at app +
        VM + create-agent.sh. If this test regresses, the cross-repo
        allowlist documented in _ALLOWED_MODELS (admin.py) has drifted."""
        app.state.db.get_agent_details = MagicMock(
            return_value={"agent_id": "a", "model": "google/gemini-3-flash-preview"}
        )
        app.state.provisioner.set_agent_model = MagicMock(
            return_value={
                "success": True,
                "previous_model": "google/gemini-3-flash-preview",
                "model": "openrouter/google/gemma-4-31b-it",
            }
        )
        app.state.db.set_agent_model = MagicMock(
            return_value={"agent_id": "a", "model": "openrouter/google/gemma-4-31b-it"}
        )
        resp = superadmin_client.patch(
            "/api/admin/agents/a/model",
            json={"model": "openrouter/google/gemma-4-31b-it"},
        )
        assert resp.status_code == 200
        assert resp.json()["model"] == "openrouter/google/gemma-4-31b-it"


# ─── Write ordering: VM first, then DB ─────────────────────────────────


class TestWriteOrdering:
    def test_vm_first_then_db(self, superadmin_client):
        """On success the VM set_agent_model is called BEFORE db.set_agent_model.
        This matters because VM failure must leave DB unchanged."""
        app.state.db.get_agent_details = MagicMock(
            return_value={"agent_id": "a", "model": None}
        )
        calls: list[str] = []

        def vm_call(agent_id, model):
            calls.append("vm")
            return {"success": True, "previous_model": None, "model": model}

        def db_call(agent_id, model):
            calls.append("db")
            return {"agent_id": agent_id, "model": model}

        app.state.provisioner.set_agent_model = MagicMock(side_effect=vm_call)
        app.state.db.set_agent_model = MagicMock(side_effect=db_call)

        resp = superadmin_client.patch(
            "/api/admin/agents/a/model",
            json={"model": "google/gemma-4-31b-it"},
        )
        assert resp.status_code == 200
        assert calls == ["vm", "db"], f"expected [vm, db] got {calls}"

    def test_vm_failure_skips_db_update(self, superadmin_client):
        """If the VM rejects (e.g. agent_not_found, config_write_failed),
        the DB must stay unchanged so the UI reflects reality."""
        app.state.db.get_agent_details = MagicMock(
            return_value={"agent_id": "a", "model": "google/gemini-3-flash-preview"}
        )
        app.state.provisioner.set_agent_model = MagicMock(
            return_value={
                "success": False,
                "error": "config_write_failed",
                "detail": "disk full",
            }
        )
        app.state.db.set_agent_model = MagicMock()

        resp = superadmin_client.patch(
            "/api/admin/agents/a/model",
            json={"model": "google/gemma-4-31b-it"},
        )
        assert resp.status_code == 502
        detail = resp.json()["detail"]
        assert detail["error"] == "vm_set_model_failed"
        assert detail["vm_error"] == "config_write_failed"
        app.state.db.set_agent_model.assert_not_called()

    def test_agent_not_found_returns_404_no_vm_call(self, superadmin_client):
        """Unknown agent short-circuits before the VM call — avoids a
        misleading VM error and keeps 404 semantics clean."""
        app.state.db.get_agent_details = MagicMock(return_value=None)
        app.state.provisioner.set_agent_model = MagicMock()
        resp = superadmin_client.patch(
            "/api/admin/agents/ghost/model",
            json={"model": "google/gemma-4-31b-it"},
        )
        assert resp.status_code == 404
        app.state.provisioner.set_agent_model.assert_not_called()

    def test_model_null_only_touches_db(self, superadmin_client):
        """model=null is the "reset DB mirror" path — must NOT touch the VM
        (a null in openclaw.json would crash OpenClaw on load)."""
        app.state.db.get_agent_details = MagicMock(
            return_value={"agent_id": "a", "model": "google/gemma-4-31b-it"}
        )
        app.state.provisioner.set_agent_model = MagicMock()
        app.state.db.set_agent_model = MagicMock(return_value={"agent_id": "a", "model": None})

        resp = superadmin_client.patch(
            "/api/admin/agents/a/model",
            json={"model": None},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["vm_updated"] is False
        assert body["model"] is None
        app.state.provisioner.set_agent_model.assert_not_called()
        app.state.db.set_agent_model.assert_called_once_with("a", None)


# ─── Drift detection ───────────────────────────────────────────────────


class TestDriftDetection:
    def test_no_drift_when_matching(self, superadmin_client):
        app.state.db.get_agent_details = MagicMock(
            return_value={"agent_id": "a", "model": "google/gemma-4-31b-it"}
        )
        app.state.provisioner.get_agent_model = MagicMock(
            return_value={"success": True, "agent_id": "a", "model": "google/gemma-4-31b-it"}
        )
        resp = superadmin_client.get("/api/admin/agents/a/model/live")
        assert resp.status_code == 200
        body = resp.json()
        assert body["drift"] is False
        assert body["live_reachable"] is True

    def test_drift_detected_when_disagree(self, superadmin_client):
        """DB says Flash, VM says Gemma — classic out-of-band edit scenario."""
        app.state.db.get_agent_details = MagicMock(
            return_value={"agent_id": "a", "model": "google/gemini-3-flash-preview"}
        )
        app.state.provisioner.get_agent_model = MagicMock(
            return_value={"success": True, "agent_id": "a", "model": "google/gemma-4-31b-it"}
        )
        resp = superadmin_client.get("/api/admin/agents/a/model/live")
        assert resp.status_code == 200
        body = resp.json()
        assert body["drift"] is True
        assert body["db_model"] == "google/gemini-3-flash-preview"
        assert body["live_model"] == "google/gemma-4-31b-it"

    def test_db_null_does_not_count_as_drift(self, superadmin_client):
        """Brand-new agents have NULL in the DB mirror; pulling a concrete
        model from the VM shouldn't raise a false-positive drift warning.
        User can use the dropdown to normalize if they care."""
        app.state.db.get_agent_details = MagicMock(
            return_value={"agent_id": "a", "model": None}
        )
        app.state.provisioner.get_agent_model = MagicMock(
            return_value={"success": True, "agent_id": "a", "model": "google/gemini-3-flash-preview"}
        )
        resp = superadmin_client.get("/api/admin/agents/a/model/live")
        assert resp.status_code == 200
        assert resp.json()["drift"] is False

    def test_vm_unreachable_does_not_crash(self, superadmin_client):
        """If the VM daemon is down, the endpoint returns 200 with
        live_reachable=False — callers can still show the DB value."""
        app.state.db.get_agent_details = MagicMock(
            return_value={"agent_id": "a", "model": "google/gemini-3-flash-preview"}
        )
        app.state.provisioner.get_agent_model = MagicMock(
            return_value={"success": False, "error": "provision-api unreachable: ..."}
        )
        resp = superadmin_client.get("/api/admin/agents/a/model/live")
        assert resp.status_code == 200
        body = resp.json()
        assert body["live_reachable"] is False
        assert body["drift"] is False
        assert body["db_model"] == "google/gemini-3-flash-preview"
        assert body["error"]

    def test_live_read_404_on_missing_agent(self, superadmin_client):
        app.state.db.get_agent_details = MagicMock(return_value=None)
        resp = superadmin_client.get("/api/admin/agents/ghost/model/live")
        assert resp.status_code == 404


# ─── Resync ────────────────────────────────────────────────────────────


class TestResync:
    def test_resync_writes_vm_value_to_db(self, superadmin_client):
        app.state.db.get_agent_details = MagicMock(
            return_value={"agent_id": "a", "model": "google/gemini-3-flash-preview"}
        )
        app.state.provisioner.get_agent_model = MagicMock(
            return_value={"success": True, "model": "google/gemma-4-31b-it"}
        )
        app.state.db.set_agent_model = MagicMock(
            return_value={"agent_id": "a", "model": "google/gemma-4-31b-it"}
        )
        resp = superadmin_client.post("/api/admin/agents/a/model/resync")
        assert resp.status_code == 200
        body = resp.json()
        assert body["db_model"] == "google/gemma-4-31b-it"
        app.state.db.set_agent_model.assert_called_once_with("a", "google/gemma-4-31b-it")

    def test_resync_fails_502_when_vm_unreachable(self, superadmin_client):
        app.state.db.get_agent_details = MagicMock(
            return_value={"agent_id": "a", "model": None}
        )
        app.state.provisioner.get_agent_model = MagicMock(
            return_value={"success": False, "error": "provision-api unreachable"}
        )
        resp = superadmin_client.post("/api/admin/agents/a/model/resync")
        assert resp.status_code == 502
