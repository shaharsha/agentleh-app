"""Short random-nonce deep-link tokens for the Telegram Quick-Connect flow.

The Telegram `/start` parameter has HARD limits per Bot API docs:
  - 1-64 characters
  - `[A-Za-z0-9_-]` only (no dots, slashes, base64 padding, etc.)

My first pass used an HMAC-signed compact base64url(payload).base64url(sig)
token — about 100 chars with a literal `.` separator. Telegram either
truncates on the dot or drops the whole parameter, which surfaced on
the webhook side as `DeeplinkError: malformed_token` even for
legitimate /start clicks.

Replacement: a short random nonce (20 urlsafe bytes = 27 chars) that
indexes a DB row carrying the real (tenant, agent, user, expires)
mapping. 160 bits of entropy = not guessable, no HMAC needed, and
well under the 64-char ceiling.

We store the pending mapping directly on `agent_bridges.config` for
that agent's telegram bridge — no new table. The row's `enabled=false`
flag + `managed_pending` object indicate an in-progress connect
attempt; the webhook completes it by resolving nonce → row.
"""

from __future__ import annotations

import json
import secrets
import time
from typing import Any


TTL_SECONDS = 15 * 60


class DeeplinkError(Exception):
    """Raised when a /start nonce can't be resolved — unknown, expired,
    or already consumed. The webhook turns this into a polite reply
    without leaking which case it was."""


def _generate_nonce() -> str:
    # 20 urlsafe bytes = 27 base64url chars, all inside [A-Za-z0-9_-].
    # Leaves plenty of headroom under Telegram's 64-char /start ceiling.
    return secrets.token_urlsafe(20)


def issue(
    db,
    *,
    tenant_id: int,
    agent_id: str,
    user_id: int,
    ttl_seconds: int = TTL_SECONDS,
) -> str:
    """Mint a nonce for the Quick-Connect deep-link and persist the
    mapping on the agent's telegram bridge row. Returns the nonce
    (use as the /start parameter)."""
    nonce = _generate_nonce()
    expires = int(time.time()) + ttl_seconds
    payload: dict[str, Any] = {
        "nonce": nonce,
        "app_user_id": int(user_id),
        "expires_at": expires,
    }
    # UPSERT: create the row if the telegram bridge doesn't exist yet,
    # or overwrite a stale managed_pending from a prior abandoned
    # attempt. Leaves enabled=false; the webhook flips it true on
    # successful completion.
    db._execute(
        """
        INSERT INTO agent_bridges
            (agent_id, bridge_type, enabled, config, connected_at)
        VALUES (%s, 'telegram', FALSE,
                jsonb_build_object('managed_pending', %s::jsonb),
                NULL)
        ON CONFLICT (agent_id, bridge_type) DO UPDATE SET
            config = agent_bridges.config || jsonb_build_object(
                'managed_pending', %s::jsonb,
                'managed_error', NULL
            )
        """,
        (agent_id, json.dumps(payload), json.dumps(payload)),
    )
    return nonce


def resolve(db, nonce: str) -> dict[str, Any]:
    """Look up a /start nonce. Returns {agent_id, tenant_id,
    app_user_id, expires_at}. Raises DeeplinkError on any failure
    — unknown, expired, malformed."""
    if not nonce:
        raise DeeplinkError("empty_nonce")
    # Telegram may percent-encode unusual inputs; we accept only the
    # urlsafe alphabet we mint. Defensive check so SQL jsonpath can't
    # see anything surprising even if a user pastes a weird /start.
    if any(c not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_" for c in nonce):
        raise DeeplinkError("malformed_nonce")
    row = db._fetch_one(
        """
        SELECT ab.agent_id,
               a.tenant_id,
               (ab.config->'managed_pending'->>'app_user_id')::int AS app_user_id,
               (ab.config->'managed_pending'->>'expires_at')::bigint AS expires_at
          FROM agent_bridges ab
          JOIN agents a ON a.agent_id = ab.agent_id
         WHERE ab.bridge_type = 'telegram'
           AND ab.config->'managed_pending'->>'nonce' = %s
         LIMIT 1
        """,
        (nonce,),
    )
    if row is None:
        raise DeeplinkError("unknown_nonce")
    expires = int(row.get("expires_at") or 0)
    if expires and expires < int(time.time()):
        raise DeeplinkError("expired")
    return {
        "agent_id": row["agent_id"],
        "tenant_id": row["tenant_id"],
        "app_user_id": row["app_user_id"],
        "expires_at": expires,
    }
