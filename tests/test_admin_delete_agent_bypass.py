"""Superadmins must be able to delete any agent via the existing
tenant-scoped DELETE /api/tenants/{tid}/agents/{aid}, even when the
superadmin is not a member of the tenant.

We don't add a separate /admin/agents/{id}/delete endpoint because
get_active_tenant_member already returns role='superadmin' for
superadmin users (deps.py:128-129), which satisfies
require_tenant_role('admin') via the role hierarchy (deps.py:20).
These tests lock that behavior so a future deps refactor that
tightens membership can't silently break the admin-panel Delete
button without a failing test.
"""

from __future__ import annotations

import os
from unittest.mock import MagicMock

import pytest

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


NON_MEMBER_SUPERADMIN = {"id": 99, "email": "me@shahar.sh", "role": "superadmin"}
NON_MEMBER_REGULAR_USER = {"id": 2, "email": "u@example.com", "role": "user"}


@pytest.fixture(autouse=True)
def _reset_overrides():
    yield
    app.dependency_overrides.clear()


def _build_db_with_tenant_but_no_membership(user_id: int, tenant_id: int = 10, agent_id: str = "agent-victim"):
    """Build a mock db where:
      - The tenant exists
      - The agent exists and belongs to the tenant
      - The user has NO membership row in the tenant (simulating a
        superadmin from a different tenant OR an outsider)
    """
    db = MagicMock()
    db.get_tenant_by_id = MagicMock(
        return_value={"id": tenant_id, "name": "Victim Co", "owner_user_id": 42}
    )
    # get_tenant_membership returns None → non-member. get_active_tenant_member
    # (deps.py:126-130) falls through to the superadmin-role bypass for
    # superadmins and raises 404 for regular users.
    db.get_tenant_membership = MagicMock(return_value=None)
    db.get_agent_tenant_id = MagicMock(return_value=tenant_id)
    db.soft_delete_agent = MagicMock()
    db.log_audit = MagicMock()
    return db


def _provisioner_success():
    """Mock provisioner whose deprovision returns a realistic success result."""
    from services.provisioning import DeprovisionResult

    prov = MagicMock()
    prov.deprovision = MagicMock(
        return_value=DeprovisionResult(
            agent_id="agent-victim",
            success=True,
            backup_path="gs://agentleh-backups/agent-victim-2026-04-20.tar.gz",
        )
    )
    return prov


# ─── The guarantee ─────────────────────────────────────────────────────


class TestSuperadminDeleteBypass:
    def test_superadmin_can_delete_agent_in_any_tenant(self):
        """Core guarantee: a superadmin who is not a tenant member can
        still DELETE that tenant's agents. Backing the admin-panel Delete
        button."""
        app.dependency_overrides[get_current_user] = lambda: NON_MEMBER_SUPERADMIN
        app.state.db = _build_db_with_tenant_but_no_membership(user_id=99)
        app.state.provisioner = _provisioner_success()

        client = TestClient(app, raise_server_exceptions=False)
        resp = client.delete("/api/tenants/10/agents/agent-victim")

        assert resp.status_code == 204, (
            f"superadmin bypass broke — got {resp.status_code} {resp.text}"
        )
        # VM deprovision ran
        app.state.provisioner.deprovision.assert_called_once_with("agent-victim")
        # DB soft-delete ran
        app.state.db.soft_delete_agent.assert_called_once_with("agent-victim")
        # Audit log captures the superadmin's user_id as actor + tenant_id
        # of the affected tenant
        call = app.state.db.log_audit.call_args
        assert call.kwargs["tenant_id"] == 10
        assert call.kwargs["actor_user_id"] == 99
        assert call.kwargs["action"] == "agent.delete"
        assert call.kwargs["target_id"] == "agent-victim"

    def test_non_superadmin_non_member_still_gets_404(self):
        """Mirror test: a regular user who is not a member of the tenant
        must still be rejected with 404. This is the invariant that
        non-members can't probe for tenant existence, and it's the
        anti-case we explicitly do NOT want to regress while making the
        superadmin bypass work."""
        app.dependency_overrides[get_current_user] = lambda: NON_MEMBER_REGULAR_USER
        app.state.db = _build_db_with_tenant_but_no_membership(user_id=2)
        app.state.provisioner = _provisioner_success()

        client = TestClient(app, raise_server_exceptions=False)
        resp = client.delete("/api/tenants/10/agents/agent-victim")

        assert resp.status_code == 404
        # Critical: we never called the provisioner for a non-member
        # non-superadmin — would have been a disastrous cross-tenant leak.
        app.state.provisioner.deprovision.assert_not_called()
        app.state.db.soft_delete_agent.assert_not_called()

    def test_superadmin_vm_failure_returns_502_and_skips_db(self):
        """Same VM-first / DB-second ordering the tenant-scoped delete
        uses. Superadmin doesn't get to skip this — if the VM deprovision
        fails we must NOT soft-delete the agent row (that would orphan
        VM resources)."""
        from services.provisioning import DeprovisionResult

        app.dependency_overrides[get_current_user] = lambda: NON_MEMBER_SUPERADMIN
        app.state.db = _build_db_with_tenant_but_no_membership(user_id=99)
        app.state.provisioner = MagicMock()
        app.state.provisioner.deprovision = MagicMock(
            return_value=DeprovisionResult(
                agent_id="agent-victim",
                success=False,
                backup_path="",
                error="GCS backup failed: insufficient quota",
            )
        )

        client = TestClient(app, raise_server_exceptions=False)
        resp = client.delete("/api/tenants/10/agents/agent-victim")

        assert resp.status_code == 502
        detail = resp.json()["detail"]
        assert detail["error"] == "deprovision_failed"
        app.state.db.soft_delete_agent.assert_not_called()

    def test_wrong_tenant_id_still_404s_for_superadmin(self):
        """Even a superadmin gets 404 when the agent doesn't belong to the
        tenant in the URL. This is the cross-reference check, not
        membership — it prevents typos from silently deleting the wrong
        agent."""
        app.dependency_overrides[get_current_user] = lambda: NON_MEMBER_SUPERADMIN
        db = _build_db_with_tenant_but_no_membership(user_id=99)
        # Agent belongs to a DIFFERENT tenant than the one in the URL
        db.get_agent_tenant_id = MagicMock(return_value=999)
        app.state.db = db
        app.state.provisioner = _provisioner_success()

        client = TestClient(app, raise_server_exceptions=False)
        resp = client.delete("/api/tenants/10/agents/agent-victim")

        assert resp.status_code == 404
        app.state.provisioner.deprovision.assert_not_called()
