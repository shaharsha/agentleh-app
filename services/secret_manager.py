"""Thin wrapper around Google Cloud Secret Manager for runtime CRUD.

Most of the app's secrets (DATABASE_URL, JWT keys, etc.) are mounted by
Cloud Run via `--set-secrets` at deploy time — the app never touches
Secret Manager for those. This module exists for the secrets the app
creates / updates / destroys at RUNTIME:

  - Per-agent Telegram bot tokens: `telegram-bot-token-<agent_id>`

The runtime SA (`cloud-run-runtime@agentleh.iam.gserviceaccount.com`)
needs `roles/secretmanager.admin` scoped via IAM condition to
`resource.name.startsWith("projects/agentleh/secrets/telegram-bot-token-")`.
That condition is intentionally narrow — the SA has zero ability to
create or destroy anything outside the Telegram bridge namespace even
if the app is compromised.

The google-cloud-secret-manager client is imported lazily so local
dev + tests without GCP credentials still import cleanly.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any

logger = logging.getLogger(__name__)

_PROJECT_ENV = "APP_GCP_PROJECT"
_DEFAULT_PROJECT = "agentleh"


def _project_id() -> str:
    return os.environ.get(_PROJECT_ENV) or _DEFAULT_PROJECT


def _client() -> Any:
    """Lazy import + singleton pattern matching meter/config.py."""
    from google.cloud import secretmanager  # type: ignore

    return secretmanager.SecretManagerServiceClient()


# Allowed characters in our runtime secret names. Keeps us safely inside
# Secret Manager's name rules AND inside the IAM condition prefix so a
# bad agent_id can't be used to create a secret outside the telegram
# namespace. Called by every public method below.
_SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def _validate_secret_name(name: str) -> None:
    if not name or not _SAFE_NAME_RE.fullmatch(name):
        raise ValueError(f"invalid secret name: {name!r}")


def upsert_secret(name: str, value: str) -> str:
    """Create the secret if needed, then add a new version carrying `value`.

    Returns the resource name of the new version. Idempotent — calling
    again with the same `name` just adds another version (old versions
    are disabled automatically below to keep only the latest readable).
    """
    _validate_secret_name(name)
    project = _project_id()
    client = _client()
    parent = f"projects/{project}"
    secret_path = f"{parent}/secrets/{name}"

    # 1. Create the secret (idempotent — catch AlreadyExists).
    try:
        client.create_secret(
            request={
                "parent": parent,
                "secret_id": name,
                "secret": {
                    "replication": {"automatic": {}},
                    "labels": {"created_by": "agentleh-app"},
                },
            }
        )
    except Exception as exc:  # noqa: BLE001
        # google-cloud-secret-manager raises AlreadyExists with a
        # provider-specific exception class; string-check is sturdy
        # enough and avoids depending on the class hierarchy.
        if "AlreadyExists" not in type(exc).__name__ and "already exists" not in str(exc).lower():
            raise

    # 2. Add the new version with the token bytes.
    version = client.add_secret_version(
        request={
            "parent": secret_path,
            "payload": {"data": value.encode("utf-8")},
        }
    )

    # 3. Disable older versions — only the newest should be usable. This
    #    is best-effort (a transient failure here isn't fatal; the app
    #    always reads /versions/latest so the new one wins).
    try:
        latest_name = version.name
        for v in client.list_secret_versions(request={"parent": secret_path}):
            if v.name == latest_name:
                continue
            if getattr(v.state, "name", "") == "ENABLED":
                try:
                    client.disable_secret_version(request={"name": v.name})
                except Exception:  # noqa: BLE001
                    logger.warning("failed to disable old secret version %s", v.name, exc_info=True)
    except Exception:  # noqa: BLE001
        logger.warning("version cleanup errored for secret %s", name, exc_info=True)

    return version.name


def get_secret(name: str) -> str:
    """Read the latest version. Returns the UTF-8 decoded string."""
    _validate_secret_name(name)
    project = _project_id()
    client = _client()
    resource = f"projects/{project}/secrets/{name}/versions/latest"
    resp = client.access_secret_version(request={"name": resource})
    return resp.payload.data.decode("utf-8")


def delete_secret(name: str) -> None:
    """Delete the entire secret (all versions). Idempotent — a missing
    secret is a no-op. Used by the Telegram disconnect path so a leaked
    DB backup can't be used to revive a bot we've disconnected."""
    _validate_secret_name(name)
    project = _project_id()
    client = _client()
    resource = f"projects/{project}/secrets/{name}"
    try:
        client.delete_secret(request={"name": resource})
    except Exception as exc:  # noqa: BLE001
        if "NotFound" in type(exc).__name__ or "not found" in str(exc).lower():
            return
        raise
