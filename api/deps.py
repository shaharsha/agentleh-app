"""FastAPI dependencies."""

from __future__ import annotations

from typing import Any

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from api.auth import decode_supabase_jwt

_bearer = HTTPBearer()


def get_db(request: Request):
    return request.app.state.db


async def get_current_user(
    request: Request,
    creds: HTTPAuthorizationCredentials = Depends(_bearer),
) -> dict[str, Any]:
    """Decode Supabase JWT → upsert user in DB → return user dict."""
    try:
        payload = decode_supabase_jwt(creds.credentials)
    except ValueError as e:
        raise HTTPException(status_code=401, detail=str(e))

    uid = payload.get("sub")
    email = payload.get("email", "")
    name = payload.get("user_metadata", {}).get("full_name", "")

    if not uid:
        raise HTTPException(status_code=401, detail="Missing sub in token")

    db = request.app.state.db
    user = db.upsert_user(supabase_uid=uid, email=email, full_name=name)
    return user
