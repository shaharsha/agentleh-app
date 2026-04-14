"""Smoke tests for the Google OAuth service module.

We don't exercise the full /connect flow in tests because it requires
KMS, Google's token endpoint, and the DB. This covers:

- JWT mint/verify round trip
- JWT rejects invalid tokens
- JWT verifies agent_id
- Authorization URL includes the right scopes + state
"""

from __future__ import annotations

import os

import pytest

# Prime env BEFORE importing services
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

from services import google_oauth  # noqa: E402


def test_mint_verify_round_trip():
    token = google_oauth.mint_connect_jwt("agent-abc")
    claims = google_oauth.verify_connect_jwt(token)
    assert claims.agent_id == "agent-abc"
    assert len(claims.nonce) > 0


def test_verify_rejects_garbage():
    with pytest.raises(ValueError, match="invalid_state_token"):
        google_oauth.verify_connect_jwt("not-a-jwt")


def test_verify_rejects_wrong_audience(monkeypatch):
    """A token signed with the right secret but different audience shouldn't verify."""
    from jose import jwt

    payload = {
        "iss": "someone-else",
        "aud": "wrong-audience",
        "sub": "agent-x",
        "iat": 0,
        "exp": 9999999999,
    }
    token = jwt.encode(payload, os.environ["APP_GOOGLE_CONNECT_JWT_SECRET"], algorithm="HS256")
    with pytest.raises(ValueError):
        google_oauth.verify_connect_jwt(token)


def test_authorization_url_contains_scopes():
    url = google_oauth.build_authorization_url(state="statexyz")
    assert url.startswith("https://accounts.google.com/o/oauth2/v2/auth?")
    assert "client_id=fake-client-id" in url
    assert "response_type=code" in url
    assert "access_type=offline" in url
    assert "prompt=consent" in url
    assert "state=statexyz" in url
    # Scopes are space-joined then URL-encoded → spaces become + or %20
    assert "calendar" in url
    assert "gmail.send" in url
    # openid (from the scope list) and userinfo.email
    assert "openid" in url
    assert "userinfo.email" in url


def test_scope_constants_no_restricted():
    # Hard guardrail: gmail.compose / gmail.metadata / gmail.readonly / gmail.modify
    # are RESTRICTED scopes that would trigger CASA. Never add them here.
    forbidden = {
        "https://www.googleapis.com/auth/gmail.compose",
        "https://www.googleapis.com/auth/gmail.metadata",
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.modify",
    }
    assert not (set(google_oauth.GOOGLE_SCOPES) & forbidden)


def test_router_imports():
    from api.routes.google_oauth import router

    paths = {route.path for route in router.routes}
    assert any(p.endswith("/oauth/google/start") for p in paths)
    assert any(p.endswith("/oauth/google/callback") for p in paths)
    assert any(p.endswith("/oauth/google/disconnect") for p in paths)
