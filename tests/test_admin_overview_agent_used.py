"""GET /admin/overview — per-agent used_micros passthrough.

Previously the admin Agents tab rendered `agent_subscriptions.used_micros`
on every row. Since `agent_subscriptions` is per-tenant (all agents in a
tenant share one pool — see meter/CLAUDE.md), sibling agents all showed
the same "used" figure. Fix added a `agent_used_micros` field summed from
`usage_events` per agent.

SQL aggregates themselves aren't unit-tested here (see test_admin_analytics.py
header — mock-asserting our own SQL is tautological). This test just pins
the route contract: whatever the db layer returns for `agent_used_micros`
must reach the client untouched.
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


SUPERADMIN = {"id": 1, "email": "me@shahar.sh", "role": "superadmin"}


@pytest.fixture(autouse=True)
def _reset_overrides():
    yield
    app.dependency_overrides.clear()


def test_overview_surfaces_distinct_agent_used_for_shared_tenant():
    """Two agents in tenant 42 share a $120 pool with $17 spent total.
    Agent A contributed $12, agent B contributed $5. The row-level
    agent_used_micros must differ between them even though used_micros
    (pool total) and base_allowance_micros (pool cap) are identical."""
    app.dependency_overrides[get_current_user] = lambda: SUPERADMIN
    app.state.db = MagicMock()
    app.state.db.list_all_users_with_agent_counts = MagicMock(return_value=[])
    app.state.db.list_billing_plans = MagicMock(return_value=[])
    app.state.db.list_all_agents_with_owner_and_plan = MagicMock(return_value=[
        {
            "agent_id": "a-one",
            "tenant_id": 42,
            "used_micros": 17_339_100,
            "agent_used_micros": 12_000_000,
            "base_allowance_micros": 120_000_000,
        },
        {
            "agent_id": "a-two",
            "tenant_id": 42,
            "used_micros": 17_339_100,
            "agent_used_micros": 5_339_100,
            "base_allowance_micros": 120_000_000,
        },
    ])

    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/admin/overview")
    assert resp.status_code == 200
    agents = resp.json()["agents"]
    assert len(agents) == 2

    a, b = agents
    assert a["used_micros"] == b["used_micros"] == 17_339_100
    assert a["base_allowance_micros"] == b["base_allowance_micros"] == 120_000_000
    assert a["agent_used_micros"] == 12_000_000
    assert b["agent_used_micros"] == 5_339_100
