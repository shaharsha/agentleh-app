"""Supabase JWT verification."""

from __future__ import annotations

import logging
from typing import Any

from jose import JWTError, jwt

from lib.config import settings

logger = logging.getLogger(__name__)


def decode_supabase_jwt(token: str) -> dict[str, Any]:
    """Decode and verify a Supabase JWT using the project's JWT secret (HS256)."""
    secret = str(getattr(settings, "supabase_jwt_secret", ""))
    if not secret:
        raise ValueError("SUPABASE_JWT_SECRET not configured")

    try:
        payload = jwt.decode(
            token,
            secret,
            algorithms=["HS256"],
            audience="authenticated",
        )
    except JWTError as e:
        raise ValueError(f"Invalid token: {e}") from e

    return payload
