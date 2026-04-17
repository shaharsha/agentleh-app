"""Voice picker routes — list available Gemini-TTS voices + update per-agent voice.

Agents can send Hebrew voice messages via the `google-tts-hebrew` OpenClaw skill
(see agent-config/openclaw/workspace/skills/google-tts-hebrew/). Which voice
identity each agent speaks in (Kore, Puck, Aoede, etc.) lives on the
`agents.tts_voice_name` column (added in meter migration 008) and is
exposed to the OpenClaw container as the AGENTLEH_TTS_VOICE env var.

This module exposes three surfaces to the frontend:

    GET  /api/voices/manifest
        Public (no auth). Returns the voice catalog JSON — metadata + public
        URLs to the pre-rendered OGG preview samples. The frontend renders
        voice picker cards from this and plays the samples when the user
        hovers/taps. Backend proxies the GCS bucket so the app can add
        per-env selection, caching, and rate limiting without exposing the
        bucket URL to the client (which makes vendor swaps easier later).

    GET  /api/tenants/{tenant_id}/agents/{agent_id}/voice
        Auth + tenant-member. Returns the current tts_voice_name for one
        agent. Used by the dashboard voice-edit modal to pre-select the
        current value in the picker.

    PATCH /api/tenants/{tenant_id}/agents/{agent_id}/voice
        Auth + tenant-member. Updates agents.tts_voice_name after
        validating the submitted voice name against the manifest. The
        voice change takes effect on the next container restart — the
        skill reads AGENTLEH_TTS_VOICE at synthesis time, which is
        injected by docker-compose at container start. The dashboard
        tells the user this clearly and offers a "restart agent" action.

Auth + authorization:
    Uses the existing `get_active_tenant_member` dep (from api.deps) which
    resolves the caller's role on the tenant, returns 404 on non-members
    (to avoid leaking tenant existence), and grants superadmin bypass.
    The agent is then verified to belong to the tenant via agents.tenant_id
    before any UPDATE lands.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from api.deps import TenantContext, get_active_tenant_member
from lib.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(tags=["voices"])

# Module-level cache for the manifest. It rarely changes (regenerated
# manually when we add voices or tweak the sample text), so we can cache
# for the lifetime of the Cloud Run instance — cold starts re-fetch.
# No TTL invalidation; if a voice is added, we'll redeploy anyway.
_manifest_cache: dict[str, Any] | None = None
_allowed_voices_cache: frozenset[str] | None = None


def _get_manifest_url() -> str:
    """Env-aware manifest URL. Dev hits dev bucket, prod hits prod bucket.

    Settings loaded via Dynaconf from config/settings.{env}.yml. Falls back
    to the prod URL if unset so a misconfigured dev env still loads voices
    (worse: break the onboarding flow entirely).
    """
    return getattr(
        settings,
        "voice_manifest_url",
        "https://storage.googleapis.com/agentleh-public-assets/voice-samples/manifest.json",
    )


async def _fetch_manifest() -> dict[str, Any]:
    """Fetch + cache the voice manifest from GCS."""
    global _manifest_cache, _allowed_voices_cache

    if _manifest_cache is not None:
        return _manifest_cache

    url = _get_manifest_url()
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            resp = await client.get(url)
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            logger.error("Failed to fetch voice manifest from %s: %s", url, exc)
            raise HTTPException(
                status_code=503,
                detail={"error": "voice_manifest_unavailable", "upstream": url},
            ) from exc

    manifest = resp.json()
    _manifest_cache = manifest
    _allowed_voices_cache = frozenset(v["name"] for v in manifest.get("voices", []))
    return manifest


def _reset_cache() -> None:
    """Test hook. Not used at runtime; callable from pytest fixtures."""
    global _manifest_cache, _allowed_voices_cache
    _manifest_cache = None
    _allowed_voices_cache = None


# ─── GET /api/voices/manifest ─────────────────────────────────────────
# Public endpoint — no auth. The manifest is already public on GCS; we
# proxy it just to put the backend in the middle for caching/migration
# flexibility. Attaching `/api/voices/` (not `/api/tenants/*`) because
# the manifest is tenant-independent — every user sees the same voices.


@router.get("/voices/manifest")
async def get_voice_manifest() -> dict[str, Any]:
    return await _fetch_manifest()


# ─── GET /api/tenants/{tenant_id}/agents/{agent_id}/voice ───────────
# Tenant-scoped. Returns current voice for one agent.


@router.get("/tenants/{tenant_id}/agents/{agent_id}/voice")
async def get_agent_voice(
    agent_id: str,
    request: Request,
    ctx: TenantContext = Depends(get_active_tenant_member),
) -> dict[str, Any]:
    db = request.app.state.db
    agent = db._fetch_one(
        "SELECT agent_id, tenant_id, tts_voice_name, bot_gender FROM agents "
        "WHERE agent_id = %s AND deleted_at IS NULL",
        (agent_id,),
    )
    if agent is None:
        raise HTTPException(status_code=404, detail={"error": "agent_not_found"})
    if agent.get("tenant_id") != ctx.tenant_id and ctx.role != "superadmin":
        # Non-superadmin members only see agents in their own tenant — 404
        # instead of 403 to avoid leaking cross-tenant agent existence.
        raise HTTPException(status_code=404, detail={"error": "agent_not_found"})
    return {
        "agent_id": agent["agent_id"],
        "tts_voice_name": agent["tts_voice_name"],
        "bot_gender": agent.get("bot_gender") or "male",
    }


# ─── PATCH /api/tenants/{tenant_id}/agents/{agent_id}/voice ─────────


# Mirror of agent-config/openclaw/voices.json and meter.main.VOICE_GENDER.
# Authoritative validation happens here for UI writes; the meter enforces
# the same invariants for agent-self-edit writes via /agent/profile.
# Update all three sites in the same PR when Google ships new voices.
VOICE_GENDER: dict[str, set[str]] = {
    "female": {
        "Achernar", "Aoede", "Autonoe", "Callirrhoe", "Despina", "Erinome",
        "Gacrux", "Kore", "Laomedeia", "Leda", "Pulcherrima", "Sulafat",
        "Vindemiatrix", "Zephyr",
    },
    "male": {
        "Achird", "Algenib", "Algieba", "Alnilam", "Charon", "Enceladus",
        "Fenrir", "Iapetus", "Orus", "Puck", "Rasalgethi", "Sadachbia",
        "Sadaltager", "Schedar", "Umbriel", "Zubenelgenubi",
    },
}


def _gender_for_voice(voice: str) -> str | None:
    for gender, ids in VOICE_GENDER.items():
        if voice in ids:
            return gender
    return None


class VoiceUpdate(BaseModel):
    """Partial update for an agent's voice + gender. Either field can be
    sent alone — when only voice is passed, gender is inferred from the
    catalog; when only gender is passed, voice resets to that gender's
    default (Puck/Kore). Mismatches are rejected."""

    tts_voice_name: str | None = Field(default=None, min_length=1, max_length=64)
    bot_gender: str | None = Field(default=None, pattern="^(male|female)$")


@router.patch("/tenants/{tenant_id}/agents/{agent_id}/voice")
async def update_agent_voice(
    agent_id: str,
    body: VoiceUpdate,
    request: Request,
    ctx: TenantContext = Depends(get_active_tenant_member),
) -> dict[str, Any]:
    db = request.app.state.db

    if body.tts_voice_name is None and body.bot_gender is None:
        raise HTTPException(
            status_code=400,
            detail={"error": "no_fields", "hint": "pass at least one of: tts_voice_name, bot_gender"},
        )

    # Resolve the (voice, gender) target from the partial update.
    if body.tts_voice_name is not None:
        voice_gender = _gender_for_voice(body.tts_voice_name)
        if voice_gender is None:
            raise HTTPException(
                status_code=400,
                detail={
                    "error": "unknown_voice",
                    "voice": body.tts_voice_name,
                    "hint": "GET /api/voices/manifest for the allowed set",
                },
            )
        if body.bot_gender is not None and body.bot_gender != voice_gender:
            raise HTTPException(
                status_code=400,
                detail={
                    "error": "gender_voice_mismatch",
                    "hint": f"voice '{body.tts_voice_name}' is a {voice_gender} voice, cannot pair with gender={body.bot_gender}",
                },
            )
        target_voice = body.tts_voice_name
        target_gender = voice_gender
    else:
        target_gender = body.bot_gender
        target_voice = "Puck" if target_gender == "male" else "Kore"

    # Ownership check — the agent must belong to the caller's tenant
    # (superadmin bypasses).
    agent = db._fetch_one(
        "SELECT agent_id, tenant_id FROM agents WHERE agent_id = %s AND deleted_at IS NULL",
        (agent_id,),
    )
    if agent is None:
        raise HTTPException(status_code=404, detail={"error": "agent_not_found"})
    if agent.get("tenant_id") != ctx.tenant_id and ctx.role != "superadmin":
        raise HTTPException(status_code=404, detail={"error": "agent_not_found"})

    db._execute(
        "UPDATE agents SET tts_voice_name = %s, bot_gender = %s WHERE agent_id = %s",
        (target_voice, target_gender, agent_id),
    )
    logger.info(
        "voice_updated agent=%s tenant=%s voice=%s gender=%s by_user=%s",
        agent_id,
        ctx.tenant_id,
        target_voice,
        target_gender,
        ctx.user_id,
    )
    return {
        "agent_id": agent_id,
        "tts_voice_name": target_voice,
        "bot_gender": target_gender,
        "note": (
            "The new voice takes effect on the next voice message — the plugin "
            "queries the meter's /agent/profile on each synthesis, so no "
            "container restart is needed."
        ),
    }
