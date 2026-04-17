"""Invite preview + accept routes.

Unscoped (not under /tenants/{id}) because they're driven by the raw
invite token in the URL — the invitee may not yet be logged in or be a
member of the tenant.

  GET  /api/invites/preview?token=...   unauthenticated — shows the
                                        tenant name + inviter name so
                                        the user knows what they're
                                        about to accept.
  POST /api/invites/accept              authenticated — {token} body.
                                        Looks up the invite by
                                        sha256(token), validates
                                        expiry/accepted/revoked, and
                                        atomically creates the membership.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from api.deps import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/invites", tags=["invites"])


class InviteAccept(BaseModel):
    token: str


def _invite_status(invite: dict[str, Any]) -> str:
    if invite.get("revoked_at") is not None:
        return "revoked"
    if invite.get("accepted_at") is not None:
        return "accepted"
    if invite["expires_at"] < datetime.now(timezone.utc):
        return "expired"
    return "pending"


@router.get("/preview")
async def preview_invite(token: str, request: Request) -> dict[str, Any]:
    """Public — returns just enough info for the invitee to decide.
    Always 404s if the token is unknown or invalid so random probes
    get no useful signal."""
    db = request.app.state.db
    invite = db.get_invite_by_token(token)
    if invite is None:
        raise HTTPException(status_code=404, detail={"error": "invite_not_found"})

    status = _invite_status(invite)
    return {
        "tenant_name": invite["tenant_name"],
        "tenant_slug": invite["tenant_slug"],
        "inviter_name": invite["inviter_name"] or invite["inviter_email"],
        "inviter_email": invite["inviter_email"],
        "email": invite["email"],
        "role": invite["role"],
        "status": status,
        "expires_at": invite["expires_at"].isoformat() if invite.get("expires_at") else None,
    }


@router.post("/accept")
async def accept_invite(
    body: InviteAccept,
    request: Request,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Authenticated — creates the membership in one transaction.

    Invites are bound to the invitee's identity: the signed-in user's
    email must match the invite email (case-insensitive). Mismatch
    returns 403 so the UI can prompt the user to switch accounts.
    This closes the hole where anyone holding a valid token (including
    the inviter themselves) could accept an invite as whoever happened
    to be logged in.
    """
    db = request.app.state.db
    invite = db.get_invite_by_token(body.token)
    if invite is None:
        raise HTTPException(status_code=404, detail={"error": "invite_not_found"})

    status = _invite_status(invite)
    if status != "pending":
        raise HTTPException(
            status_code=400, detail={"error": f"invite_{status}"}
        )

    signed_in_email = (user.get("email") or "").lower()
    if invite["email"].lower() != signed_in_email:
        logger.warning(
            "invite email mismatch: invite=%s accepted_by=%s",
            invite["email"],
            user.get("email"),
        )
        raise HTTPException(
            status_code=403,
            detail={
                "error": "invite_email_mismatch",
                "invite_email": invite["email"],
                "signed_in_as": user.get("email"),
            },
        )

    try:
        membership = db.accept_invite(invite["id"], user["id"])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"error": str(exc)})

    return {
        "tenant_id": membership["tenant_id"],
        "role": membership["role"],
        "tenant_name": invite["tenant_name"],
        "tenant_slug": invite["tenant_slug"],
    }
