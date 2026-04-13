"""Supabase JWT verification.

Supabase rotated to per-project JWT Signing Keys (ES256 via JWKS) in late 2025.
Tokens issued to end-users after OAuth are signed with ES256 and carry a `kid`
header that maps to a public key in the project's JWKS:

    https://<ref>.supabase.co/auth/v1/.well-known/jwks.json

The legacy HS256 JWT secret is not used anywhere in this project's user-auth
path. Service-role keys (still HS256-shaped) are a separate concern and don't
flow through this verifier.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any

import httpx
from jose import JWTError, jwt

from lib.config import settings

logger = logging.getLogger(__name__)

_JWKS_TTL_SECONDS = 600  # 10 min cache
_jwks_lock = threading.Lock()
_jwks_cache: dict[str, tuple[float, dict[str, Any]]] = {}

_SUPPORTED_ALGS = {"ES256", "ES384", "ES512", "RS256", "RS384", "RS512"}


def _supabase_url() -> str:
    """Return the Supabase project URL for the current env.

    Prefers APP_SUPABASE_URL env var, falls back to config, then to the
    known prod/dev project URLs by ENV_FOR_DYNACONF.
    """
    url = os.environ.get("APP_SUPABASE_URL") or str(
        getattr(settings, "supabase_url", "")
    )
    if url:
        return url.rstrip("/")
    env = os.environ.get("ENV_FOR_DYNACONF", "production")
    if env == "production":
        return "https://hizznfloknpqtznywwsj.supabase.co"
    return "https://mnetqtjwcdunznvvfaob.supabase.co"


def _jwks_url() -> str:
    return f"{_supabase_url()}/auth/v1/.well-known/jwks.json"


def _fetch_jwks(force: bool = False) -> dict[str, Any]:
    """Fetch the Supabase project JWKS. Cached for `_JWKS_TTL_SECONDS`.

    Thread-safe via a module-level lock. On force=True (after a kid miss —
    key rotation), bypass the cache and refetch. On network failure, return
    the stale cache if present to avoid breaking all auth on a transient
    DNS hiccup.
    """
    key = _jwks_url()
    now = time.monotonic()
    with _jwks_lock:
        cached = _jwks_cache.get(key)
        if cached and not force and (now - cached[0]) < _JWKS_TTL_SECONDS:
            return cached[1]
    try:
        resp = httpx.get(key, timeout=5.0)
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:  # noqa: BLE001
        logger.warning("jwks: failed to fetch %s: %s", key, exc)
        if cached:
            return cached[1]
        raise
    with _jwks_lock:
        _jwks_cache[key] = (now, data)
    return data


def _find_key(jwks: dict[str, Any], kid: str | None) -> dict[str, Any] | None:
    keys = jwks.get("keys") or []
    if not keys:
        return None
    if kid is None:
        # Single-key projects: use the only key
        return keys[0]
    for key in keys:
        if key.get("kid") == kid:
            return key
    return None


def decode_supabase_jwt(token: str) -> dict[str, Any]:
    """Decode and verify a Supabase user JWT via the project's JWKS.

    Accepts ES256/ES384/ES512/RS256/RS384/RS512 — anything in the asymmetric
    family Supabase may issue. Returns the decoded claims dict.
    """
    try:
        header = jwt.get_unverified_header(token)
    except JWTError as e:
        raise ValueError(f"invalid_jwt_header: {e}") from e

    alg = header.get("alg")
    if alg not in _SUPPORTED_ALGS:
        raise ValueError(f"unsupported_alg: {alg}")

    kid = header.get("kid")

    jwks = _fetch_jwks()
    key = _find_key(jwks, kid)
    if key is None:
        # Kid not in cached JWKS — key may have just rotated. Refetch once.
        jwks = _fetch_jwks(force=True)
        key = _find_key(jwks, kid)
    if key is None:
        raise ValueError(f"no_jwks_key_for_kid: {kid}")

    try:
        return jwt.decode(
            token,
            key,  # python-jose accepts JWK dicts directly for ES/RS
            algorithms=[alg],
            audience="authenticated",
        )
    except JWTError as e:
        raise ValueError(f"invalid_jwt_signature: {e}") from e
