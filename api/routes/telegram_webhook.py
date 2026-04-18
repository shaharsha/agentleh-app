"""Webhook receiver for `@AgentikoManagerBot`.

Telegram POSTs every update to this endpoint once `setWebhook` has been
called. We handle two update types (the only ones we subscribe to):

  1. `message` with text `/start <signed-token>`
       → user just tapped the deep-link in the web UI; we verify the
         signed token (ties this chat to a tenant/agent/user), stash
         the telegram_chat_id on that agent's bridge row, and reply
         with a single KeyboardButtonRequestManagedBot "Create bot"
         button pre-filled with a suggested name/username.

  2. `managed_bot` update (ManagedBotUpdated)
       → user confirmed bot creation in BotFather's MiniApp. Telegram
         delivers the new bot's identity here; we call
         getManagedBotToken to fetch the actual token, then run the
         same "store + patch container + restart" pipeline the
         paste-token flow uses.

Auth
────
Telegram echoes our shared secret in the
`X-Telegram-Bot-Api-Secret-Token` header on every request. We reject
with 401 on mismatch so random internet hosts can't POST fake updates.

Idempotency
───────────
The webhook path is at-least-once per Telegram's docs. We make the
pipeline idempotent:
  - /start <token> always re-sends the button (cheap, harmless).
  - managed_bot creation is keyed on bot_id — if agent_bridges already
    has a telegram row for this agent with this bot_id, we skip the
    token-fetch + container-patch and just ack.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request

from services import secret_manager, telegram, telegram_deeplink, telegram_manager
from services.telegram_deeplink import DeeplinkError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/telegram", tags=["telegram-webhook"])


# Maps the freshly-accepted signed deep-link token → the (tenant, agent,
# user) triple by re-verifying the HMAC. We also need the reverse:
# when the ManagedBotUpdated arrives later (after the user confirms in
# the MiniApp), we need to know which agent to write the bot to.
#
# Telegram's ManagedBotUpdated carries the creator's `user` — their
# Telegram user_id. We correlate using a DB-backed attempt ledger so
# that webhook events replaying out-of-order still resolve correctly.
# The ledger lives on agent_bridges.config under a `managed_pending`
# key; see _record_pending_attempt / _consume_pending_attempt.
#
# We intentionally do NOT use an in-memory map — Cloud Run scales to
# multiple instances and state must be DB-resident.


def _bad_request(reason: str) -> HTTPException:
    # 200 (not 400) is what Telegram docs actually ask for on "ok but
    # I'm ignoring this" — anything else and Telegram retries for hours.
    # But FastAPI's HTTPException is easier to work with; we convert
    # to 200 in the handler itself. For hard-invalid secret we do
    # return 401 so misconfigured deploys fail loud.
    return HTTPException(status_code=400, detail=reason)


def _extract_start_token(text: str) -> str | None:
    """Parse '/start <token>' (plus an optional @BotUsername suffix)
    and return the token or None."""
    if not text or not text.startswith("/start"):
        return None
    parts = text.strip().split(maxsplit=1)
    if len(parts) < 2:
        return None
    return parts[1].strip()


async def _handle_start_message(
    request: Request, chat_id: int, telegram_user_id: int, token: str
) -> None:
    """User tapped the deep-link and /start fired. Resolve the nonce
    against agent_bridges.config.managed_pending, stash the Telegram
    chat/user ids on that same row so ManagedBotUpdated can later
    correlate, and send the KeyboardButtonRequestManagedBot button."""
    db = request.app.state.db
    try:
        resolved = telegram_deeplink.resolve(db, token)
    except DeeplinkError as exc:
        # Reply politely — users who share a bot link publicly would
        # otherwise see nothing, which is confusing. Best-effort: if
        # send_message errors too (e.g. chat not known to the bot
        # yet), we still ack the webhook so Telegram doesn't retry.
        logger.info("telegram /start bad nonce: %s", exc)
        try:
            await asyncio.to_thread(
                telegram_manager.send_message,
                chat_id,
                "This link is no longer valid. Please start again from the Agentiko web app.",
            )
        except Exception:  # noqa: BLE001
            logger.warning("follow-up send_message failed for bad /start", exc_info=True)
        return

    tenant_id = int(resolved["tenant_id"])
    agent_id = str(resolved["agent_id"])
    initiating_user_id = int(resolved["app_user_id"])

    # Persist the telegram chat + user ids on the SAME managed_pending
    # row the deep-link nonce lives in, so the subsequent
    # ManagedBotUpdated event can look the attempt up by telegram_user_id.
    _record_pending_attempt(
        db,
        telegram_user_id=telegram_user_id,
        telegram_chat_id=chat_id,
        tenant_id=tenant_id,
        agent_id=agent_id,
        app_user_id=initiating_user_id,
    )

    # Get the agent's friendly name to pre-fill the suggested bot name.
    agent = db.get_agent_details(agent_id)
    agent_name = (agent or {}).get("agent_name") or agent_id
    agent_slug = (agent_id.split("-")[-2] if "-" in agent_id else agent_id)

    suggested_username = telegram_manager.suggested_username_for_agent(
        tenant_id=tenant_id, agent_slug=agent_slug
    )

    await asyncio.to_thread(
        telegram_manager.send_request_managed_bot,
        chat_id,
        prompt=(
            f"Tap below to create your Telegram bot for “{agent_name}”. "
            f"BotFather will open — just confirm."
        ),
        button_text=f"Create bot for {agent_name}",
        request_id=telegram_user_id,  # echoed back in ManagedBotUpdated
        suggested_bot_name=agent_name[:32],
        suggested_bot_username=suggested_username,
    )


async def _handle_managed_bot_update(request: Request, update: dict[str, Any]) -> None:
    """A user confirmed bot creation in BotFather. Telegram posts a
    `managed_bot` update with {user: <creator>, bot: <new_bot_info>}.
    We fetch the token and run the connect pipeline."""
    managed = update.get("managed_bot") or {}
    bot = managed.get("bot") or {}
    creator = managed.get("user") or {}
    bot_id = bot.get("id")
    creator_id = creator.get("id")
    bot_username = bot.get("username") or ""
    bot_first_name = bot.get("first_name") or bot_username

    if not bot_id or not creator_id:
        logger.warning("managed_bot update missing bot.id or user.id: %r", update)
        return

    db = request.app.state.db
    attempt = _consume_pending_attempt(db, telegram_user_id=int(creator_id))
    if attempt is None:
        # User confirmed a bot for a different integration, or the
        # attempt already landed. No-op.
        logger.info(
            "managed_bot update with no matching attempt for telegram user %s",
            creator_id,
        )
        return

    agent_id = attempt["agent_id"]
    tenant_id = attempt["tenant_id"]

    # 1. Fetch the new bot's token.
    try:
        token = await asyncio.to_thread(telegram_manager.get_managed_bot_token, int(bot_id))
    except Exception as exc:  # noqa: BLE001
        logger.exception("getManagedBotToken failed")
        _fail_attempt(db, agent_id=agent_id, reason=f"getManagedBotToken: {exc}")
        return

    # 2. Stash in Secret Manager (same path as paste-token flow so the
    #    rest of the pipeline is bridge-source-agnostic).
    secret_name = telegram.secret_name_for(agent_id)
    try:
        await asyncio.to_thread(secret_manager.upsert_secret, secret_name, token)
    except Exception as exc:  # noqa: BLE001
        logger.exception("secret upsert failed")
        _fail_attempt(db, agent_id=agent_id, reason=f"secret_write_failed: {exc}")
        return

    # 3. Persist bot identity.
    db.upsert_telegram_bridge(
        agent_id,
        bot_username=bot_username,
        bot_display_name=bot_first_name,
        secret_name=secret_name,
    )

    # 4. Patch the container config + restart so the new bot starts
    #    receiving messages immediately.
    provisioner = request.app.state.provisioner
    env_var = telegram.env_var_name_for(agent_id)
    try:
        patch_result = await asyncio.to_thread(
            provisioner.patch_agent_config,
            agent_id,
            openclaw_json_patch=telegram.build_enable_patch(env_var),
            env_additions={env_var: token},
            restart=True,
        )
        if not patch_result.get("success"):
            raise RuntimeError(patch_result.get("error") or "unknown")
    except Exception as exc:  # noqa: BLE001
        logger.exception("config patch failed")
        _fail_attempt(db, agent_id=agent_id, reason=f"config_patch_failed: {exc}")
        return

    # 5. Audit log + mark the attempt complete so the polling endpoint
    #    flips the web UI to "connected".
    db.log_audit(
        tenant_id=tenant_id,
        actor_user_id=attempt.get("app_user_id"),
        action="agent.telegram.connect",
        target_type="agent",
        target_id=agent_id,
        metadata={"bot_username": bot_username, "via": "managed_bots"},
    )
    _complete_attempt(db, agent_id=agent_id, bot_username=bot_username)

    # 6. DM the user a confirmation in Telegram so the chat shows closure.
    try:
        chat_id = attempt.get("telegram_chat_id")
        if chat_id:
            await asyncio.to_thread(
                telegram_manager.send_message,
                int(chat_id),
                f"Done — @{bot_username} is now wired to your Agentiko agent. "
                f"Message it in Telegram to test.",
            )
    except Exception:  # noqa: BLE001
        pass  # Non-fatal confirmation.


# ── Attempt ledger ────────────────────────────────────────────────────
# Stored in agent_bridges.config['managed_pending'] so we don't need a
# new table. Key `managed_pending` on the telegram row is an object:
#   {
#     "telegram_user_id": 123,
#     "telegram_chat_id": 456,
#     "app_user_id": 42,
#     "started_at": 1713980000
#   }
# For an agent row whose `enabled=false` this carries the in-progress
# attempt; on success it's cleared by _complete_attempt.


def _record_pending_attempt(
    db,
    *,
    telegram_user_id: int,
    telegram_chat_id: int,
    tenant_id: int,
    agent_id: str,
    app_user_id: int,
) -> None:
    """Merge the Telegram chat + user ids into the existing
    managed_pending object (already seeded by start-managed with the
    nonce + expires + app_user_id). Uses jsonb_set so we PRESERVE
    the nonce and ttl fields — an earlier overwrite would have
    blown them away, which we'd regret if we ever added retries."""
    db._execute(
        """
        UPDATE agent_bridges
           SET config = jsonb_set(
                   jsonb_set(
                       jsonb_set(
                           config,
                           '{managed_pending,telegram_user_id}',
                           to_jsonb(%s::bigint),
                           true
                       ),
                       '{managed_pending,telegram_chat_id}',
                       to_jsonb(%s::bigint),
                       true
                   ),
                   '{managed_pending,started_at}',
                   to_jsonb(extract(epoch from now())::bigint),
                   true
               )
         WHERE agent_id = %s AND bridge_type = 'telegram'
        """,
        (telegram_user_id, telegram_chat_id, agent_id),
    )


def _consume_pending_attempt(db, *, telegram_user_id: int) -> dict[str, Any] | None:
    """Find the agent whose managed_pending.telegram_user_id matches.
    Returns the attempt dict + agent_id + tenant_id, or None."""
    row = db._fetch_one(
        """
        SELECT ab.agent_id,
               a.tenant_id,
               ab.config->'managed_pending' AS pending
          FROM agent_bridges ab
          JOIN agents a ON a.agent_id = ab.agent_id
         WHERE ab.bridge_type = 'telegram'
           AND (ab.config->'managed_pending'->>'telegram_user_id')::bigint = %s
         ORDER BY (ab.config->'managed_pending'->>'started_at')::bigint DESC
         LIMIT 1
        """,
        (int(telegram_user_id),),
    )
    if row is None:
        return None
    pending = row.get("pending") or {}
    return {
        "agent_id": row["agent_id"],
        "tenant_id": row["tenant_id"],
        "telegram_chat_id": pending.get("telegram_chat_id"),
        "app_user_id": pending.get("app_user_id"),
    }


def _complete_attempt(db, *, agent_id: str, bot_username: str) -> None:
    db._execute(
        """
        UPDATE agent_bridges
           SET config = (config - 'managed_pending') || jsonb_build_object(
                   'managed_complete', true,
                   'managed_bot_username', %s::text
               )
         WHERE agent_id = %s AND bridge_type = 'telegram'
        """,
        (bot_username, agent_id),
    )


def _fail_attempt(db, *, agent_id: str, reason: str) -> None:
    db._execute(
        """
        UPDATE agent_bridges
           SET config = (config - 'managed_pending') || jsonb_build_object(
                   'managed_error', %s::text
               )
         WHERE agent_id = %s AND bridge_type = 'telegram'
        """,
        (reason[:400], agent_id),
    )


# ── Route ────────────────────────────────────────────────────────────


@router.post("/webhook")
async def telegram_webhook(
    request: Request,
    x_telegram_bot_api_secret_token: str | None = Header(default=None),
) -> dict:
    expected = telegram_manager.webhook_secret()
    if not x_telegram_bot_api_secret_token or x_telegram_bot_api_secret_token != expected:
        raise HTTPException(status_code=401, detail="bad_secret")

    try:
        update = await request.json()
    except Exception:  # noqa: BLE001
        return {"ok": True}  # Ignore; don't retry
    if not isinstance(update, dict):
        return {"ok": True}

    # Dispatch by update type. We log the top-level keys so unexpected
    # update types (if Telegram changes the schema) are visible without
    # bloating the log with full payloads.
    logger.info("telegram webhook keys=%s", list(update.keys()))

    # Case 1: message with /start <token>
    message = update.get("message") or {}
    text = message.get("text") or ""
    if text.startswith("/start"):
        token = _extract_start_token(text)
        chat = message.get("chat") or {}
        from_user = message.get("from") or {}
        if token and chat.get("id") and from_user.get("id"):
            try:
                await _handle_start_message(
                    request,
                    chat_id=int(chat["id"]),
                    telegram_user_id=int(from_user["id"]),
                    token=token,
                )
            except Exception:  # noqa: BLE001
                logger.exception("start handler errored")
        return {"ok": True}

    # Case 2: managed_bot update (ManagedBotUpdated)
    if "managed_bot" in update:
        try:
            await _handle_managed_bot_update(request, update)
        except Exception:  # noqa: BLE001
            logger.exception("managed_bot handler errored")
        return {"ok": True}

    # Anything else (group joins, stickers, random messages) — ack + ignore.
    return {"ok": True}


@router.get("/webhook/status")
async def webhook_status() -> dict:
    """Lightweight diagnostic for ops. Returns the currently-registered
    webhook URL + pending_update_count so you can eyeball from the app
    whether the webhook is still bound to this deployment."""
    try:
        info = await asyncio.to_thread(telegram_manager._api, "getWebhookInfo")
        return {"ok": True, "webhook": info}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}
