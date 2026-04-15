"""Tests for the WhatsApp connect-URL shortener.

Covers:
- POST /api/oauth/google/shortlink — JWT in, short URL out
- POST rejects a bad JWT with 400
- GET /c/{code} redirects 302 to the stored long URL
- GET /c/{code} returns 404 for unknown codes
- GET /c/{code} returns 404 for expired codes (simulated via db mock)
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

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

from api.main import app  # noqa: E402
from services import google_oauth  # noqa: E402


@pytest.fixture
def db_mock():
    return MagicMock()


@pytest.fixture
def client(db_mock):
    app.state.db = db_mock
    return TestClient(app, raise_server_exceptions=False)


# ─────────────────────────────────────────────────────────────────────────
# POST /api/oauth/google/shortlink
# ─────────────────────────────────────────────────────────────────────────


def test_shortlink_post_creates_code_and_returns_url(client, db_mock):
    db_mock.create_oauth_shortlink = MagicMock()
    jwt_token = google_oauth.mint_connect_jwt("agent-a")

    resp = client.post(
        "/api/oauth/google/shortlink",
        json={"t": jwt_token},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["short_url"].startswith("https://app-dev.agentiko.io/c/")
    assert len(body["code"]) == 10
    assert "expires_at" in body

    # Verify the DB insert got the full /start URL (not some truncated form)
    db_mock.create_oauth_shortlink.assert_called_once()
    kwargs = db_mock.create_oauth_shortlink.call_args.kwargs
    assert kwargs["long_url"] == (
        f"https://app-dev.agentiko.io/api/oauth/google/start?t={jwt_token}"
    )


def test_shortlink_post_rejects_bad_jwt(client):
    # Long enough to pass the min_length=10 pydantic guard, but not a
    # real JWT so verify_connect_jwt raises.
    resp = client.post(
        "/api/oauth/google/shortlink",
        json={"t": "aaaaaaaaaa.bbbbbbbbbb.cccccccccc"},
    )
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "invalid_state_token"


def test_shortlink_post_requires_t_field(client):
    resp = client.post(
        "/api/oauth/google/shortlink",
        json={},
    )
    # Pydantic field validation → 422
    assert resp.status_code == 422


# ─────────────────────────────────────────────────────────────────────────
# GET /c/{code}
# ─────────────────────────────────────────────────────────────────────────


def test_shortlink_get_redirects_to_long_url(client, db_mock):
    db_mock.get_oauth_shortlink = MagicMock(
        return_value={
            "code": "abcDEF1234",
            "long_url": "https://app-dev.agentiko.io/api/oauth/google/start?t=abc",
            "created_at": datetime.now(timezone.utc),
            "expires_at": datetime.now(timezone.utc) + timedelta(minutes=10),
            "used_at": None,
        }
    )

    resp = client.get("/c/abcDEF1234", follow_redirects=False)
    assert resp.status_code == 302
    assert (
        resp.headers["location"]
        == "https://app-dev.agentiko.io/api/oauth/google/start?t=abc"
    )


def test_shortlink_get_404_for_unknown_code(client, db_mock):
    db_mock.get_oauth_shortlink = MagicMock(return_value=None)
    resp = client.get("/c/notreally1", follow_redirects=False)
    assert resp.status_code == 404
    # Serves the Hebrew error HTML
    assert "הקישור פג תוקף או שאינו תקין" in resp.text


def test_shortlink_get_400_for_bogus_code_shape(client, db_mock):
    # Anything non-alphanumeric short-circuits before hitting the DB.
    resp = client.get("/c/has-dash", follow_redirects=False)
    assert resp.status_code == 400


def test_shortlink_get_uses_lookup_which_checks_expiry(client, db_mock):
    """``get_oauth_shortlink`` is the one that enforces expiry by
    returning None for expired rows. We trust it here and just verify
    the route treats None as a 404."""
    db_mock.get_oauth_shortlink = MagicMock(return_value=None)
    resp = client.get("/c/expiredcod", follow_redirects=False)
    assert resp.status_code == 404
