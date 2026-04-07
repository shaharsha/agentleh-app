"""Dynaconf settings loader."""

from __future__ import annotations

import os
from pathlib import Path

_CONFIG_DIR = Path(__file__).resolve().parent.parent / "config"


def _load_settings():
    from dynaconf import Dynaconf

    return Dynaconf(
        envvar_prefix="APP",
        settings_files=[
            str(_CONFIG_DIR / "settings.yml"),
            str(_CONFIG_DIR / f"settings.{os.getenv('ENV_FOR_DYNACONF', 'development')}.yml"),
        ],
        environments=False,
        load_dotenv=True,
    )


settings = _load_settings()


def get_database_url() -> str:
    return os.environ.get("DATABASE_URL") or str(getattr(settings, "database_url", ""))
