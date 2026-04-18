"""Auth-layer error-shape tests.

Three interlocking guarantees this suite pins down:

1. ``get_user_for_auth`` raises the right typed AuthError subclass on
   each DB outcome (fresh insert, uid match, soft-deleted uid match,
   email collision live, email collision soft-deleted).

2. ``get_current_user`` translates those typed errors into
   ``HTTPException(detail={error, message, message_he})`` — the dict
   shape the frontend's error dictionary expects. A raw string detail
   here is what originally cascaded to "שגיאה: coupon_error" in the UI.

3. The global FastAPI ``psycopg.Error`` handler catches any unhandled
   DB exception and returns the same ``{error, message, message_he}``
   shape with ``error: "internal_error"``.

All tests use in-memory fakes — no live Postgres — so they run in CI.
"""

from __future__ import annotations

import time
from unittest.mock import MagicMock, patch

import psycopg
import pytest
from fastapi.testclient import TestClient


# ─── Fake cursor/connection that drives get_user_for_auth ─────────────


class FakeCursor:
    """Minimal psycopg cursor stand-in for get_user_for_auth."""

    def __init__(self, behaviours):
        self._behaviours = list(behaviours)
        self._step = 0
        self._last_row = None

    def execute(self, sql, params=()):
        behaviour = self._behaviours[self._step]
        self._step += 1
        if isinstance(behaviour, Exception):
            raise behaviour
        self._last_row = behaviour

    def fetchone(self):
        return self._last_row

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FakeConn:
    def __init__(self, cursor):
        self._cursor = cursor
        self.committed = False
        self.rolled_back = False

    def cursor(self):
        return self._cursor

    def commit(self):
        self.committed = True

    def rollback(self):
        self.rolled_back = True

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _make_db(cursor_behaviours, second_cursor_behaviours=None):
    """Build an AppDatabase whose connect() returns a FakeConn driven by
    the given behaviour script. If the logic needs a second connect()
    (the ``_fetch_one`` used to look up the colliding email row), pass
    ``second_cursor_behaviours``."""
    from lib.db import AppDatabase

    db = AppDatabase("postgresql://fake/fake")
    conns = [FakeConn(FakeCursor(cursor_behaviours))]
    if second_cursor_behaviours is not None:
        conns.append(FakeConn(FakeCursor(second_cursor_behaviours)))
    it = iter(conns)
    db.connect = lambda: next(it)
    return db


def _unique_violation():
    # psycopg errors take a bare message; Diagnostic is populated on the
    # real DB but not needed for our branching.
    return psycopg.errors.UniqueViolation("duplicate key value violates unique constraint")


# ─── Unit tests: get_user_for_auth raises typed errors ─────────────────


def test_existing_active_row_returns_dict():
    db = _make_db(
        [
            {
                "id": 7,
                "supabase_uid": "uid-7",
                "email": "a@b.com",
                "deleted_at": None,
            },
        ]
    )
    out = db.get_user_for_auth(supabase_uid="uid-7", email="a@b.com")
    assert out["id"] == 7
    assert out["email"] == "a@b.com"


def test_existing_soft_deleted_row_raises_account_revoked():
    from lib.db import AuthAccountRevoked

    db = _make_db(
        [
            {
                "id": 7,
                "supabase_uid": "uid-7",
                "email": "a@b.com",
                "deleted_at": "2026-04-17T16:04:08Z",
            },
        ]
    )
    with pytest.raises(AuthAccountRevoked):
        db.get_user_for_auth(supabase_uid="uid-7", email="a@b.com")


def test_fresh_insert_returns_new_row():
    db = _make_db(
        [
            None,  # SELECT by uid misses
            {
                "id": 9,
                "supabase_uid": "new-uid",
                "email": "new@b.com",
                "deleted_at": None,
            },  # INSERT returns row
        ]
    )
    out = db.get_user_for_auth(
        supabase_uid="new-uid", email="new@b.com", full_name="New User"
    )
    assert out["id"] == 9
    assert out["supabase_uid"] == "new-uid"


def test_email_collision_soft_deleted_raises_account_revoked():
    from lib.db import AuthAccountRevoked

    # First connect(): SELECT miss, then INSERT → UniqueViolation
    # Second connect() (via _fetch_one): SELECT by email → soft-deleted row
    db = _make_db(
        cursor_behaviours=[
            None,
            _unique_violation(),
        ],
        second_cursor_behaviours=[
            {
                "id": 7,
                "supabase_uid": "different-uid",
                "email": "conflict@b.com",
                "deleted_at": "2026-04-17T16:04:08Z",
            },
        ],
    )
    with pytest.raises(AuthAccountRevoked):
        db.get_user_for_auth(supabase_uid="new-uid", email="conflict@b.com")


def test_email_collision_live_raises_already_registered():
    from lib.db import AuthEmailAlreadyRegistered

    db = _make_db(
        cursor_behaviours=[
            None,
            _unique_violation(),
        ],
        second_cursor_behaviours=[
            {
                "id": 99,
                "supabase_uid": "different-uid",
                "deleted_at": None,
                "email": "conflict@b.com",
            },
        ],
    )
    with pytest.raises(AuthEmailAlreadyRegistered):
        db.get_user_for_auth(supabase_uid="new-uid", email="conflict@b.com")


def test_email_collision_same_uid_returns_winning_row():
    """Concurrent first-sign-in inserts from the same Supabase session.

    If two parallel auth'd requests arrive for a brand-new user, both
    hit SELECT miss + INSERT. One wins; the loser's INSERT can still
    trip the email UNIQUE depending on which constraint Postgres checks
    first (ON CONFLICT (supabase_uid) DO NOTHING only handles the
    supabase_uid conflict). When the existing row has the *same*
    supabase_uid as the caller, we return it — it's us.
    """
    db = _make_db(
        cursor_behaviours=[
            None,
            _unique_violation(),
        ],
        second_cursor_behaviours=[
            {
                "id": 42,
                "supabase_uid": "new-uid",  # SAME uid — race partner
                "email": "same@b.com",
                "deleted_at": None,
                "full_name": "",
                "phone": None,
                "gender": None,
                "onboarding_status": "pending",
                "role": "user",
                "created_at": None,
            },
        ],
    )
    out = db.get_user_for_auth(supabase_uid="new-uid", email="same@b.com")
    assert out["id"] == 42
    assert out["supabase_uid"] == "new-uid"


# ─── HTTP-level tests: get_current_user translates to shaped detail ───


def _es256_token_and_jwk():
    """Build a valid ES256 JWT + the JWK used to verify it. Mirrors the
    helper in test_auth.py so this file stays self-contained."""
    from cryptography.hazmat.backends import default_backend
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from jose import jwt as jose_jwt
    from jose.utils import base64url_encode

    private_key = ec.generate_private_key(ec.SECP256R1(), default_backend())
    public_numbers = private_key.public_key().public_numbers()
    public_jwk = {
        "kty": "EC",
        "crv": "P-256",
        "alg": "ES256",
        "use": "sig",
        "kid": "test-kid-auth-errors",
        "x": base64url_encode(public_numbers.x.to_bytes(32, "big")).decode(),
        "y": base64url_encode(public_numbers.y.to_bytes(32, "big")).decode(),
    }
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    token = jose_jwt.encode(
        {
            "sub": "new-supabase-uid",
            "email": "collision@example.com",
            "aud": "authenticated",
            "exp": int(time.time()) + 3600,
        },
        private_pem,
        algorithm="ES256",
        headers={"kid": "test-kid-auth-errors"},
    )
    return token, public_jwk


def _client_with_db(db_mock):
    """Build a TestClient whose /api/auth/me dependency resolves against
    db_mock. Patch _fetch_jwks so JWT verification passes without hitting
    Supabase."""
    from api.main import app

    app.state.db = db_mock
    # raise_server_exceptions=False so the global 500 handler runs on
    # unhandled exceptions instead of TestClient re-raising Python-side.
    return TestClient(app, raise_server_exceptions=False)


def test_auth_me_returns_403_account_revoked_with_shaped_detail():
    from lib.db import AuthAccountRevoked

    token, jwk = _es256_token_and_jwk()
    db = MagicMock()
    db.get_user_for_auth.side_effect = AuthAccountRevoked()

    with patch("api.auth._fetch_jwks", return_value={"keys": [jwk]}):
        client = _client_with_db(db)
        resp = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})

    assert resp.status_code == 403
    body = resp.json()
    assert isinstance(body["detail"], dict), "detail must be dict-shaped for frontend"
    assert body["detail"]["error"] == "account_revoked"
    assert body["detail"]["message"]
    assert body["detail"]["message_he"]


def test_auth_me_returns_409_email_conflict_with_shaped_detail():
    from lib.db import AuthEmailAlreadyRegistered

    token, jwk = _es256_token_and_jwk()
    db = MagicMock()
    db.get_user_for_auth.side_effect = AuthEmailAlreadyRegistered()

    with patch("api.auth._fetch_jwks", return_value={"keys": [jwk]}):
        client = _client_with_db(db)
        resp = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})

    assert resp.status_code == 409
    body = resp.json()
    assert isinstance(body["detail"], dict)
    assert body["detail"]["error"] == "email_already_registered"
    assert "message_he" in body["detail"]


def test_unhandled_db_error_returns_shaped_internal_error():
    """A raw psycopg.Error escaping from any dependency (ex: DB down)
    should surface as `internal_error` with the canonical detail shape —
    not as FastAPI's default string-shaped "Internal Server Error"."""
    token, jwk = _es256_token_and_jwk()
    db = MagicMock()
    db.get_user_for_auth.side_effect = psycopg.OperationalError("connection refused")

    with patch("api.auth._fetch_jwks", return_value={"keys": [jwk]}):
        client = _client_with_db(db)
        resp = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})

    assert resp.status_code == 500
    body = resp.json()
    assert isinstance(body["detail"], dict)
    assert body["detail"]["error"] == "internal_error"
    assert body["detail"]["message_he"]
