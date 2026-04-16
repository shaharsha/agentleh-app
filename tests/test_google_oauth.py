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
os.environ.setdefault("APP_NYLAS_CLIENT_ID", "fake-nylas-client-id")
os.environ.setdefault("APP_NYLAS_API_KEY", "fake-nylas-api-key")

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
    assert url.startswith("https://api.us.nylas.com/v3/connect/auth?")
    assert "client_id=fake-nylas-client-id" in url
    assert "response_type=code" in url
    assert "provider=google" in url
    assert "state=statexyz" in url
    # Scopes are space-joined then URL-encoded → spaces become + or %20
    assert "calendar" in url
    assert "gmail.modify" in url
    # openid (from the scope list) and userinfo.email
    assert "openid" in url
    assert "userinfo.email" in url


def test_scope_constants_include_gmail_modify():
    # With Nylas, we USE gmail.modify (restricted) because Nylas holds the
    # CASA certification, not us. Verify it IS in the scope set now.
    assert "https://www.googleapis.com/auth/gmail.modify" in google_oauth.GOOGLE_SCOPES
    assert "https://www.googleapis.com/auth/calendar" in google_oauth.GOOGLE_SCOPES
    # These are still not requested (compose/metadata/readonly are subsets of modify)
    forbidden = {
        "https://www.googleapis.com/auth/gmail.compose",
        "https://www.googleapis.com/auth/gmail.metadata",
        "https://www.googleapis.com/auth/gmail.readonly",
    }
    assert not (set(google_oauth.GOOGLE_SCOPES) & forbidden)


def test_router_imports():
    from api.routes.google_oauth import router

    paths = {route.path for route in router.routes}
    assert any(p.endswith("/oauth/google/start") for p in paths)
    assert any(p.endswith("/oauth/google/callback") for p in paths)
    # Phase 2: POST /disconnect was deleted — disconnect now lives on the
    # path-based DELETE route in api/routes/integrations.py.
    assert not any(p.endswith("/oauth/google/disconnect") for p in paths)


# ─────────────────────────────────────────────────────────────────────────
# Phase 2: redirect_to + login_hint
# ─────────────────────────────────────────────────────────────────────────


def test_mint_with_redirect_to_and_login_hint():
    token = google_oauth.mint_connect_jwt(
        "agent-abc",
        redirect_to="https://app-dev.agentiko.io/dashboard",
        login_hint="user@example.com",
    )
    claims = google_oauth.verify_connect_jwt(token)
    assert claims.agent_id == "agent-abc"
    assert claims.redirect_to == "https://app-dev.agentiko.io/dashboard"
    assert claims.login_hint == "user@example.com"


def test_mint_rejects_unallowlisted_redirect_to():
    with pytest.raises(google_oauth.InvalidRedirectError):
        google_oauth.mint_connect_jwt(
            "agent-abc",
            redirect_to="https://evil.com/steal",
        )


def test_mint_rejects_http_for_prod_host():
    # Non-localhost hosts must be https — prevents a downgrade footgun
    # if an attacker somehow got hold of a state URL.
    with pytest.raises(google_oauth.InvalidRedirectError):
        google_oauth.mint_connect_jwt(
            "agent-abc",
            redirect_to="http://app.agentiko.io/dashboard",
        )


def test_mint_allows_localhost_http_for_dev():
    token = google_oauth.mint_connect_jwt(
        "agent-abc",
        redirect_to="http://localhost:5173/dashboard",
    )
    claims = google_oauth.verify_connect_jwt(token)
    assert claims.redirect_to == "http://localhost:5173/dashboard"


def test_verify_rejects_forged_redirect_to(monkeypatch):
    """A JWT signed with the real secret but carrying a non-allowlisted
    redirect_to must still be rejected at verify time (belt + braces)."""
    from jose import jwt

    payload = {
        "iss": "attacker",
        "aud": google_oauth._JWT_AUDIENCE,
        "sub": "agent-x",
        "iat": 0,
        "exp": 9999999999,
        "nonce": "n",
        "redirect_to": "https://evil.com/steal",
    }
    token = jwt.encode(
        payload,
        os.environ["APP_GOOGLE_CONNECT_JWT_SECRET"],
        algorithm="HS256",
    )
    with pytest.raises(google_oauth.InvalidRedirectError):
        google_oauth.verify_connect_jwt(token)


def test_scopes_to_capabilities_nylas_set():
    """With Nylas, gmail.modify covers read + send + labels."""
    caps = google_oauth.scopes_to_capabilities(
        [
            "https://www.googleapis.com/auth/calendar",
            "https://www.googleapis.com/auth/gmail.modify",
        ]
    )
    assert "manage_calendar" in caps["can"]
    assert "read_email" in caps["can"]
    assert "send_email" in caps["can"]
    assert "manage_labels" in caps["can"]
    # With gmail.modify, there's nothing in "cannot" for email
    assert "read_email" not in caps["cannot"]


def test_authorization_url_includes_login_hint():
    url = google_oauth.build_authorization_url(
        state="s", login_hint="alice@example.com"
    )
    assert "login_hint=alice%40example.com" in url or "login_hint=alice@example.com" in url


def test_authorization_url_without_login_hint():
    url = google_oauth.build_authorization_url(state="s")
    assert "login_hint" not in url


# ─────────────────────────────────────────────────────────────────────────
# Capability selection (Phase 2 extension)
# ─────────────────────────────────────────────────────────────────────────


def test_capabilities_to_scope_list_all_by_default():
    scopes = google_oauth.capabilities_to_scope_list(None)
    # Identity scopes always included
    assert "openid" in scopes
    assert "https://www.googleapis.com/auth/userinfo.email" in scopes
    # All feature scopes present (Nylas uses gmail.modify instead of gmail.send)
    assert "https://www.googleapis.com/auth/calendar" in scopes
    assert "https://www.googleapis.com/auth/gmail.modify" in scopes


def test_capabilities_to_scope_list_calendar_only():
    scopes = google_oauth.capabilities_to_scope_list(["calendar"])
    assert "https://www.googleapis.com/auth/calendar" in scopes
    assert "https://www.googleapis.com/auth/gmail.modify" not in scopes
    # Identity always included
    assert "openid" in scopes


def test_capabilities_to_scope_list_email_only():
    scopes = google_oauth.capabilities_to_scope_list(["email"])
    assert "https://www.googleapis.com/auth/gmail.modify" in scopes
    assert "https://www.googleapis.com/auth/calendar" not in scopes


def test_capabilities_to_scope_list_rejects_unknown():
    with pytest.raises(ValueError, match="unknown_capability"):
        google_oauth.capabilities_to_scope_list(["ninjas"])


def test_mint_jwt_with_capabilities():
    token = google_oauth.mint_connect_jwt("agent-abc", capabilities=["calendar"])
    claims = google_oauth.verify_connect_jwt(token)
    assert claims.capabilities == ["calendar"]


def test_mint_jwt_rejects_unknown_capability():
    with pytest.raises(ValueError, match="unknown_capability"):
        google_oauth.mint_connect_jwt("agent-abc", capabilities=["bogus"])


def test_verify_jwt_rejects_forged_unknown_capability():
    """Belt + braces: even a JWT signed with the real secret can't sneak
    an unknown capability past verify_connect_jwt."""
    from jose import jwt

    payload = {
        "iss": "attacker",
        "aud": google_oauth._JWT_AUDIENCE,
        "sub": "agent-x",
        "iat": 0,
        "exp": 9999999999,
        "nonce": "n",
        "caps": ["drive_full"],  # not in our allowlist
    }
    token = jwt.encode(
        payload,
        os.environ["APP_GOOGLE_CONNECT_JWT_SECRET"],
        algorithm="HS256",
    )
    with pytest.raises(ValueError, match="invalid_state_token"):
        google_oauth.verify_connect_jwt(token)


def test_build_authorization_url_respects_scope_list():
    url = google_oauth.build_authorization_url(
        state="s",
        scopes=["openid", "https://www.googleapis.com/auth/gmail.send"],
    )
    # Only the passed scopes should appear
    assert "gmail.send" in url
    assert "calendar" not in url


def test_backwards_compat_google_scopes_constant():
    """Existing call sites that use GOOGLE_SCOPES should still get the
    full scope set (now includes gmail.modify via Nylas)."""
    assert "openid" in google_oauth.GOOGLE_SCOPES
    assert "https://www.googleapis.com/auth/calendar" in google_oauth.GOOGLE_SCOPES
    assert "https://www.googleapis.com/auth/gmail.modify" in google_oauth.GOOGLE_SCOPES


# ─────────────────────────────────────────────────────────────────────────
# Shortlink service
# ─────────────────────────────────────────────────────────────────────────


def test_shortlink_generate_code_length_and_charset():
    from services import shortlink

    code = shortlink.generate_code()
    assert len(code) == 10
    # base62: no punctuation, no dashes
    assert code.isalnum()


def test_shortlink_codes_are_unique_over_many_calls():
    from services import shortlink

    codes = {shortlink.generate_code() for _ in range(500)}
    # 500 random picks from 62^10 ≈ 8e17 should be trivially unique
    assert len(codes) == 500
