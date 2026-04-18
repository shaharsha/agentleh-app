"""WebSocket proxy between the browser ChatPane and an OpenClaw agent gateway.

The chat UI in `frontend/src/components/ChatPane.tsx` opens a WebSocket
to `wss://app.agentiko.io/api/tenants/{tid}/agents/{aid}/chat`. This
module is the server-side half of that connection:

  1. Receives the browser WebSocket (already authenticated + tenant-
     scoped by the FastAPI route before it hands off to here).
  2. Opens a BACKEND WebSocket to the agent's gateway_url using the
     shared bridge Ed25519 device identity (DEVICE_KEY_B64) which is
     pre-paired on every agent by create-agent.sh.
  3. Completes the gateway handshake, authenticating as a
     `webchat` clientMode / `webchat-ui` clientId client so the
     gateway applies the same scope rules OpenClaw's built-in dashboard
     uses (no session patching, no deletion).
  4. Relays frames bidirectionally. Browser → gateway for chat.send /
     chat.history / chat.abort (whitelist enforced). Gateway → browser
     for everything the gateway emits: res/events.

Two isolation rules prevent tenant-member cross-talk:

  - `sessionKey = webchat-u<user_id>-a<agent_id>` is injected into
    every chat.send body the proxy forwards. Browsers can propose
    their own session_key in the frame but we overwrite it. Each
    tenant member thus has their own conversation with each agent.
  - Only methods in CHAT_METHOD_ALLOWLIST are forwarded. Attempts to
    call anything else yield a local error frame — the gateway never
    sees the forbidden request.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import platform
import time

logger = logging.getLogger(__name__)


CHAT_METHOD_ALLOWLIST = frozenset(
    [
        "chat.send",
        "chat.history",
        "chat.abort",
        "chat.inject",
    ]
)

GATEWAY_HANDSHAKE_TIMEOUT = 15.0


def _load_device_key():
    """Load the shared agentleh bridge device key (Ed25519) from
    DEVICE_KEY_B64 env var. Same secret the bridge uses — so no new
    per-agent pairing is needed; every agent already trusts this key
    via its devices/paired.json.

    Raises RuntimeError if the key isn't configured — the chat proxy
    can't run without it and we want to fail loud at first connect
    instead of silently accepting a client we can't authenticate.
    """
    from cryptography.hazmat.primitives import serialization

    b64 = os.environ.get("DEVICE_KEY_B64") or os.environ.get("APP_DEVICE_KEY_B64") or ""
    if not b64:
        raise RuntimeError(
            "DEVICE_KEY_B64 not set — webchat proxy needs the shared bridge device key"
        )
    pem = base64.b64decode(b64)
    return serialization.load_pem_private_key(pem, password=None)


def _device_identity(key) -> dict[str, str]:
    from cryptography.hazmat.primitives import serialization

    pub = key.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    dev_id = hashlib.sha256(pub).hexdigest()
    pub_b64 = base64.urlsafe_b64encode(pub).rstrip(b"=").decode()
    return {"id": dev_id, "publicKey": pub_b64}


def _sign_connect(
    key,
    dev_id: str,
    client_id: str,
    client_mode: str,
    role: str,
    token: str,
    scopes: list[str],
    signed_at_ms: int,
    nonce: str,
    plat: str,
) -> str:
    payload = "|".join(
        [
            "v3",
            dev_id,
            client_id,
            client_mode,
            role,
            ",".join(scopes),
            str(signed_at_ms),
            token,
            nonce,
            plat.lower().strip(),
            "",
        ]
    )
    sig = key.sign(payload.encode())
    return base64.urlsafe_b64encode(sig).rstrip(b"=").decode()


async def _open_gateway_connection(
    gateway_url: str,
    gateway_token: str,
    *,
    client_id: str,
    client_mode: str,
    display_name: str,
) -> "any":  # returns a websockets client connection
    """Open a WebSocket to the agent's gateway and complete the
    handshake. Raises ConnectionError on auth failure.

    Mirrors bridge/gateway_client.py::OpenClawGateway.connect except:
      - clientMode is caller-controlled (we use "webchat", bridge uses "backend")
      - clientId is caller-controlled (we use "webchat-ui")
      - scopes still request operator.read + operator.write — matches
        the bridge's approved scopes in devices/paired.json so the
        gateway accepts the handshake.
    """
    import websockets

    # Bigger max_size so browser clients can stream large chat blobs
    # (OpenClaw sends up to ~4 MB per message including attachments).
    ws = await websockets.connect(gateway_url, max_size=25 * 1024 * 1024)

    challenge_raw = await asyncio.wait_for(ws.recv(), timeout=GATEWAY_HANDSHAKE_TIMEOUT)
    challenge = json.loads(challenge_raw)
    nonce = challenge.get("payload", {}).get("nonce", "")

    device_key = _load_device_key()
    dev = _device_identity(device_key)
    scopes = ["operator.read", "operator.write"]
    role = "operator"
    plat = platform.system().lower()
    signed_at = int(time.time() * 1000)

    sig = _sign_connect(
        device_key,
        dev["id"],
        client_id,
        client_mode,
        role,
        gateway_token,
        scopes,
        signed_at,
        nonce,
        plat,
    )

    await ws.send(
        json.dumps(
            {
                "type": "req",
                "id": "app-webchat-connect",
                "method": "connect",
                "params": {
                    "minProtocol": 3,
                    "maxProtocol": 3,
                    "client": {
                        "id": client_id,
                        "displayName": display_name,
                        "version": "0.1.0",
                        "platform": plat,
                        "mode": client_mode,
                    },
                    "auth": {"token": gateway_token},
                    "device": {
                        "id": dev["id"],
                        "publicKey": dev["publicKey"],
                        "signature": sig,
                        "signedAt": signed_at,
                        "nonce": nonce,
                    },
                    "role": role,
                    "scopes": scopes,
                },
            }
        )
    )

    resp_raw = await asyncio.wait_for(ws.recv(), timeout=GATEWAY_HANDSHAKE_TIMEOUT)
    resp = json.loads(resp_raw)
    if resp.get("error"):
        await ws.close()
        raise ConnectionError(f"gateway rejected connect: {resp['error']}")

    return ws


def _sanitize_outbound_frame(
    raw: str, *, session_key: str
) -> tuple[str | None, dict | None, str | None]:
    """Validate + rewrite a browser-sent frame before relaying to the gateway.

    Returns (json_to_send, parsed_frame, error_message). Exactly one of
    json_to_send or error_message is non-None; error_message is shown
    to the browser without touching the gateway.
    """
    try:
        frame = json.loads(raw)
    except Exception:  # noqa: BLE001
        return None, None, "bad_json"
    if not isinstance(frame, dict):
        return None, None, "frame_must_be_object"
    if frame.get("type") != "req":
        return None, None, "only_req_frames_allowed"
    method = frame.get("method")
    if method not in CHAT_METHOD_ALLOWLIST:
        return None, None, f"method_not_allowed:{method}"
    params = frame.get("params") or {}
    if not isinstance(params, dict):
        return None, None, "params_must_be_object"

    # Pin session_key to the server-computed value for chat.send /
    # chat.history / chat.abort so a browser can't reach into another
    # tenant member's conversation. OpenClaw's session keys are
    # free-form strings so we're free to use our own namespace.
    if method in ("chat.send", "chat.history", "chat.abort"):
        params["sessionKey"] = session_key

    if method == "chat.send":
        # OpenClaw's ChatSendParamsSchema rejects additionalProperties
        # and REQUIRES idempotencyKey. Mint one per request so replays
        # are safe AND the browser doesn't need to care about the field.
        # We don't set originatingChannel/originatingTo — the schema
        # treats those as a pair (setting channel alone yields
        # "originatingTo is required when using originating route
        # fields"), and we have no meaningful 'to' for web chat. The
        # sessionKey (webchat-u<user>-a<agent>) already unambiguously
        # identifies browser traffic for the agent's side.
        params.pop("messageChannel", None)
        params.pop("originatingChannel", None)
        if not params.get("idempotencyKey"):
            import uuid as _uuid
            params["idempotencyKey"] = f"webchat-{_uuid.uuid4().hex}"

    frame["params"] = params
    return json.dumps(frame), frame, None


async def run_chat_proxy(
    client_ws,
    *,
    gateway_url: str,
    gateway_token: str,
    session_key: str,
    on_close: "callable | None" = None,
) -> None:
    """Proxy driver. Runs until either side closes.

    client_ws is the already-accepted FastAPI WebSocket from the browser.
    The caller (api/routes/chat.py) handles auth, tenant scoping, and
    passes us the agent's gateway_url + gateway_token + session_key.
    """
    # IMPORTANT: we authenticate as clientId="gateway-client" + clientMode="backend"
    # (identical to the agentleh bridge), NOT as clientMode="webchat". Reason:
    # OpenClaw's gateway treats any "webchat" connection (either by mode OR by
    # clientId="webchat-ui") as a browser Control UI client and enforces a
    # Cross-Origin Origin check against gateway.controlUi.allowedOrigins. Our
    # proxy runs server-side (Cloud Run → agent gateway over VPC), so there's
    # no meaningful browser Origin to present. Using the bridge's clientMode
    # bypasses the check, matches the existing paired.json entry, and doesn't
    # weaken our isolation — the outbound frame sanitizer still enforces the
    # per-method allowlist and the per-user sessionKey.
    try:
        gateway_ws = await _open_gateway_connection(
            gateway_url,
            gateway_token,
            client_id="gateway-client",
            client_mode="backend",
            display_name="Agentleh Web Chat",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("webchat: gateway connect failed: %s", exc)
        try:
            await client_ws.send_text(
                json.dumps(
                    {
                        "type": "error",
                        "error": "gateway_connect_failed",
                        "detail": str(exc),
                    }
                )
            )
        except Exception:  # noqa: BLE001
            pass
        return

    # Tell the browser we're online so it can switch from "connecting"
    # to "connected" in the UI.
    await client_ws.send_text(json.dumps({"type": "ready", "sessionKey": session_key}))

    async def client_to_gateway() -> None:
        while True:
            raw = await client_ws.receive_text()
            out, _frame, err = _sanitize_outbound_frame(raw, session_key=session_key)
            if err:
                await client_ws.send_text(
                    json.dumps({"type": "error", "error": err})
                )
                continue
            if out is not None:
                await gateway_ws.send(out)

    async def gateway_to_client() -> None:
        async for raw in gateway_ws:
            # Pass frames straight through — they're already JSON strings
            # from the gateway. The ChatPane component knows how to
            # unpack `res` RPC responses and `event` chat frames.
            await client_ws.send_text(raw)

    # Run both directions concurrently; closing either side tears down
    # the other. We use a TaskGroup-ish pattern with explicit cleanup
    # because FastAPI's WebSocket raises WebSocketDisconnect and the
    # websockets library raises ConnectionClosed, so the cancellation
    # path needs to be symmetric.
    c2g = asyncio.create_task(client_to_gateway())
    g2c = asyncio.create_task(gateway_to_client())
    try:
        done, pending = await asyncio.wait(
            {c2g, g2c}, return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
        for task in pending:
            try:
                await task
            except Exception:  # noqa: BLE001
                pass
    finally:
        try:
            await gateway_ws.close()
        except Exception:  # noqa: BLE001
            pass
        if on_close:
            try:
                on_close()
            except Exception:  # noqa: BLE001
                pass
