"""Unscoped agent utility routes.

These endpoints aren't bound to a specific tenant — any authenticated
user can call them. The tenant-scoped agent CRUD lives in
api/routes/tenants.py under /api/tenants/{tenant_id}/agents/...

Currently only hosts the phone-availability pre-flight used by the
create-agent form and the Bridges-panel WhatsApp edit modal. The
response intentionally omits the conflicting agent's id/tenant so it
can't be used to enumerate which tenant owns which phone.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request

from api.deps import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/agents", tags=["agents"])


@router.get("/check-phone")
async def check_phone_available(
    phone: str,
    request: Request,
    user: dict = Depends(get_current_user),
) -> dict:
    """Return {available: bool} for the given phone.

    `phone` must be a parseable number (E.164 or Israeli local). The
    normalizer lives in tenants.py::_normalize_phone_e164 and raises
    400 on unparseable input — we import it here to share exactly the
    same validation the create route uses.

    Response deliberately does NOT include the conflicting agent_id or
    tenant_id even when `available=false`: leaking that would let a
    logged-in user probe which phones are attached to which tenants.
    """
    # Late import to avoid circular dep between agents.py and tenants.py
    # (tenants.py imports from api.deps; this module does too).
    from api.routes.tenants import _normalize_phone_e164

    phone_e164 = _normalize_phone_e164(phone)  # raises HTTPException(400) on bad input
    existing = request.app.state.db.get_agent_for_phone(phone_e164)
    return {"available": existing is None}
