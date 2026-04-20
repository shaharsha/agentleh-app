"""GET /admin/analytics/llm — aggregate queries backing the Stats tab's
LLM analytics cards.

We test the route's wiring (auth + parameter validation + response shape)
with a mocked db. The SQL itself is exercised against real data during the
dev deploy smoke test — unit-testing Postgres aggregates with mocks would
just assert our mock matches the SQL we wrote, which isn't useful."""

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
REGULAR_USER = {"id": 2, "email": "u@example.com", "role": "user"}


@pytest.fixture(autouse=True)
def _reset_overrides():
    yield
    app.dependency_overrides.clear()


@pytest.fixture
def client():
    """Superadmin client with a db mocked to return canned rows for each
    aggregate query. Each _fetch_all call gets a different side_effect so
    the endpoint sees distinct payloads — matching the SQL order in the
    route handler."""
    app.dependency_overrides[get_current_user] = lambda: SUPERADMIN
    app.state.db = MagicMock()
    # Side effects in the exact order the route runs them:
    #   1. cost_per_model, 2. thinking_burn, 3. truncation_rate,
    #   4. tool_frequency, 5. error_rate
    app.state.db._fetch_all = MagicMock(
        side_effect=[
            [{"upstream": "openrouter", "model": "google/gemma-4-31b-it",
              "events": 5, "cost_micros": 19607, "input_tokens": 135000,
              "output_tokens": 120, "cached_tokens": 0, "avg_latency_ms": 1200}],
            [{"model": "google/gemma-4-31b-it", "events": 3,
              "avg_thoughts": 40.0, "avg_output": 25.0, "thoughts_share_pct": 61.5}],
            [{"model": "google/gemma-4-31b-it", "total": 20,
              "truncated": 1, "pct": 5.0}],
            [{"tool_name": "nylas_send_email", "calls": 12,
              "distinct_agents": 3, "distinct_models": 2}],
            [{"upstream": "openrouter", "model": "google/gemma-4-31b-it",
              "total": 20, "errors": 1, "pct": 5.0}],
        ]
    )
    app.state.db._fetch_one = MagicMock(return_value={
        "turns_measured": 100,
        "p50_messages": 8,
        "p95_messages": 45,
        "p99_messages": 62,
        "max_messages": 80,
    })
    return TestClient(app, raise_server_exceptions=False)


# ─── Auth ──────────────────────────────────────────────────────────────


class TestAuth:
    def test_non_superadmin_gets_403(self):
        app.dependency_overrides[get_current_user] = lambda: REGULAR_USER
        app.state.db = MagicMock()
        c = TestClient(app, raise_server_exceptions=False)
        resp = c.get("/api/admin/analytics/llm")
        assert resp.status_code == 403


# ─── Parameter validation ──────────────────────────────────────────────


class TestWindowParam:
    def test_default_window_is_7_days(self, client):
        resp = client.get("/api/admin/analytics/llm")
        assert resp.status_code == 200
        assert resp.json()["window_days"] == 7

    def test_custom_window(self, client):
        resp = client.get("/api/admin/analytics/llm?window_days=30")
        assert resp.status_code == 200
        assert resp.json()["window_days"] == 30

    def test_window_zero_rejected(self):
        app.dependency_overrides[get_current_user] = lambda: SUPERADMIN
        app.state.db = MagicMock()
        c = TestClient(app, raise_server_exceptions=False)
        resp = c.get("/api/admin/analytics/llm?window_days=0")
        assert resp.status_code == 400
        assert resp.json()["detail"]["error"] == "invalid_window"

    def test_window_over_90_rejected(self):
        """Cap at 90 days — partial indexes on usage_events only cover
        recent data efficiently; 90 days of all-agents aggregates is fine,
        but an unbounded window would be a foot-gun."""
        app.dependency_overrides[get_current_user] = lambda: SUPERADMIN
        app.state.db = MagicMock()
        c = TestClient(app, raise_server_exceptions=False)
        resp = c.get("/api/admin/analytics/llm?window_days=365")
        assert resp.status_code == 400


# ─── Response shape ────────────────────────────────────────────────────


class TestResponseShape:
    def test_contains_all_expected_cards(self, client):
        resp = client.get("/api/admin/analytics/llm")
        assert resp.status_code == 200
        body = resp.json()
        for key in (
            "window_days", "cost_per_model", "thinking_burn",
            "truncation_rate", "tool_frequency", "error_rate",
            "conversation_shape",
        ):
            assert key in body, f"missing key: {key}"

    def test_cost_per_model_shape(self, client):
        body = client.get("/api/admin/analytics/llm").json()
        row = body["cost_per_model"][0]
        for k in ("upstream", "model", "events", "cost_micros",
                  "input_tokens", "output_tokens", "cached_tokens",
                  "avg_latency_ms"):
            assert k in row

    def test_thinking_burn_shape(self, client):
        body = client.get("/api/admin/analytics/llm").json()
        row = body["thinking_burn"][0]
        for k in ("model", "events", "avg_thoughts", "avg_output",
                  "thoughts_share_pct"):
            assert k in row

    def test_conversation_shape_handles_no_data(self):
        """Empty usage_events → p50/p95/p99 must return the zero-state dict,
        not a half-populated one."""
        app.dependency_overrides[get_current_user] = lambda: SUPERADMIN
        app.state.db = MagicMock()
        app.state.db._fetch_all = MagicMock(return_value=[])
        # _fetch_one returns None when the aggregate has zero rows
        app.state.db._fetch_one = MagicMock(return_value=None)

        c = TestClient(app, raise_server_exceptions=False)
        resp = c.get("/api/admin/analytics/llm")
        assert resp.status_code == 200
        shape = resp.json()["conversation_shape"]
        assert shape["turns_measured"] == 0
        assert shape["p50_messages"] is None
