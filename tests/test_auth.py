"""Auth and health endpoint tests."""

import os
from unittest.mock import MagicMock, patch

import pytest

os.environ.setdefault("APP_SUPABASE_JWT_SECRET", "test-secret")


def test_decode_invalid_token():
    from api.auth import decode_supabase_jwt

    with pytest.raises(ValueError, match="Invalid token"):
        decode_supabase_jwt("not.a.jwt")


def test_decode_missing_secret():
    from api.auth import decode_supabase_jwt

    with patch("api.auth.settings", new_callable=lambda: type("S", (), {"supabase_jwt_secret": ""})):
        with pytest.raises(ValueError, match="not configured"):
            decode_supabase_jwt("x.y.z")


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
