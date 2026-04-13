"""Auth and health endpoint tests.

Supabase user tokens are ES256-signed via per-project JWT Signing Keys,
verified through the project's JWKS endpoint. We exercise the happy path
against a locally-generated ES256 key and a mocked JWKS fetch.
"""

from __future__ import annotations

import base64
import json as _json
import time
from unittest.mock import MagicMock, patch

import pytest
from jose import jwt


def _generate_es256_jwk(kid: str = "test-kid-1"):
    """Generate an ES256 keypair; return (private_pem, public_jwk_dict)."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.backends import default_backend
    from jose.utils import base64url_encode

    private_key = ec.generate_private_key(ec.SECP256R1(), default_backend())
    public_numbers = private_key.public_key().public_numbers()

    x = public_numbers.x.to_bytes(32, "big")
    y = public_numbers.y.to_bytes(32, "big")

    public_jwk = {
        "kty": "EC",
        "crv": "P-256",
        "alg": "ES256",
        "use": "sig",
        "kid": kid,
        "x": base64url_encode(x).decode(),
        "y": base64url_encode(y).decode(),
    }

    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    return private_pem, public_jwk


def _mint_es256(claims: dict, kid: str = "test-kid-1") -> tuple[str, dict]:
    """Mint a token and return (token, public_jwk) for the verifier."""
    private_pem, public_jwk = _generate_es256_jwk(kid)
    token = jwt.encode(claims, private_pem, algorithm="ES256", headers={"kid": kid})
    return token, public_jwk


# ─── Invalid / garbage tokens ─────────────────────────────────────────


def test_decode_invalid_jwt_header():
    from api.auth import decode_supabase_jwt

    with pytest.raises(ValueError):
        decode_supabase_jwt("not.a.jwt")


def test_decode_unsupported_alg_hs256():
    """HS256 is no longer accepted — only asymmetric Supabase signing keys."""
    from api.auth import decode_supabase_jwt

    token = jwt.encode(
        {"sub": "x", "aud": "authenticated", "exp": int(time.time()) + 60},
        "some-secret",
        algorithm="HS256",
    )
    with pytest.raises(ValueError, match="unsupported_alg"):
        decode_supabase_jwt(token)


def test_decode_unsupported_alg_none():
    from api.auth import decode_supabase_jwt

    header = base64.urlsafe_b64encode(
        _json.dumps({"alg": "none", "typ": "JWT"}).encode()
    ).decode().rstrip("=")
    payload = base64.urlsafe_b64encode(
        _json.dumps({"sub": "x", "aud": "authenticated"}).encode()
    ).decode().rstrip("=")
    token = f"{header}.{payload}."

    with pytest.raises(ValueError, match="unsupported_alg"):
        decode_supabase_jwt(token)


# ─── ES256 happy path + edge cases ────────────────────────────────────


def test_decode_es256_valid():
    from api.auth import decode_supabase_jwt

    token, public_jwk = _mint_es256(
        {
            "sub": "user-456",
            "email": "es256@example.com",
            "aud": "authenticated",
            "exp": int(time.time()) + 3600,
        }
    )
    with patch("api.auth._fetch_jwks", return_value={"keys": [public_jwk]}):
        claims = decode_supabase_jwt(token)
    assert claims["sub"] == "user-456"
    assert claims["email"] == "es256@example.com"


def test_decode_es256_expired():
    from api.auth import decode_supabase_jwt

    token, public_jwk = _mint_es256(
        {
            "sub": "u",
            "aud": "authenticated",
            "exp": int(time.time()) - 60,  # already expired
        }
    )
    with patch("api.auth._fetch_jwks", return_value={"keys": [public_jwk]}):
        with pytest.raises(ValueError):
            decode_supabase_jwt(token)


def test_decode_es256_wrong_audience():
    from api.auth import decode_supabase_jwt

    token, public_jwk = _mint_es256(
        {
            "sub": "u",
            "aud": "not-authenticated",
            "exp": int(time.time()) + 60,
        }
    )
    with patch("api.auth._fetch_jwks", return_value={"keys": [public_jwk]}):
        with pytest.raises(ValueError):
            decode_supabase_jwt(token)


def test_decode_es256_kid_miss_triggers_refetch():
    """On kid miss, _fetch_jwks(force=True) is called once to handle rotation."""
    from api.auth import decode_supabase_jwt

    token, public_jwk = _mint_es256(
        {"sub": "u", "aud": "authenticated", "exp": int(time.time()) + 3600}
    )

    call_count = {"n": 0}

    def mock_fetch(force: bool = False):
        call_count["n"] += 1
        if call_count["n"] == 1:
            return {"keys": []}  # stale cache, no keys
        return {"keys": [public_jwk]}  # real key after force refresh

    with patch("api.auth._fetch_jwks", side_effect=mock_fetch):
        claims = decode_supabase_jwt(token)
    assert claims["sub"] == "u"
    assert call_count["n"] == 2


def test_decode_es256_unknown_kid_after_retry():
    from api.auth import decode_supabase_jwt

    token, _ = _mint_es256(
        {"sub": "u", "aud": "authenticated", "exp": int(time.time()) + 3600}
    )
    _, unrelated_key = _generate_es256_jwk(kid="different-kid")

    with patch("api.auth._fetch_jwks", return_value={"keys": [unrelated_key]}):
        with pytest.raises(ValueError, match="no_jwks_key_for_kid"):
            decode_supabase_jwt(token)


def test_decode_es256_wrong_signature():
    """Token signed with key A, JWKS advertises key B — must reject."""
    from api.auth import decode_supabase_jwt

    token, _ = _mint_es256(
        {"sub": "u", "aud": "authenticated", "exp": int(time.time()) + 3600},
        kid="test-kid-1",
    )
    _, other_public = _generate_es256_jwk(kid="test-kid-1")  # same kid, different key

    with patch("api.auth._fetch_jwks", return_value={"keys": [other_public]}):
        with pytest.raises(ValueError, match="invalid_jwt_signature"):
            decode_supabase_jwt(token)


# ─── JWKS URL resolution ──────────────────────────────────────────────


def test_jwks_url_from_supabase_url_env(monkeypatch):
    monkeypatch.setenv("APP_SUPABASE_URL", "https://custom.supabase.co")
    # Re-import to rebuild cached closures — but _supabase_url reads env dynamically
    from api.auth import _jwks_url

    assert _jwks_url() == "https://custom.supabase.co/auth/v1/.well-known/jwks.json"


def test_jwks_url_dev_fallback(monkeypatch):
    monkeypatch.delenv("APP_SUPABASE_URL", raising=False)
    monkeypatch.setenv("ENV_FOR_DYNACONF", "development")
    with patch("api.auth.settings", new_callable=lambda: type("S", (), {"supabase_url": ""})):
        from api.auth import _jwks_url

        assert "mnetqtjwcdunznvvfaob" in _jwks_url()


# ─── Health + unauthenticated routes ──────────────────────────────────


def test_health_endpoint():
    from fastapi.testclient import TestClient
    from api.main import app

    app.state.db = MagicMock()
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}


def test_auth_me_requires_token():
    from fastapi.testclient import TestClient
    from api.main import app

    app.state.db = MagicMock()
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/auth/me")
    assert resp.status_code in (401, 403)
