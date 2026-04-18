"""Tests for dynamic OG injection on GET /invites/accept.

Covers the four-case matrix from the plan:

  1. Bot UA + valid token   -> dynamic "{inviter} invited you to {tenant}"
  2. Bot UA + invalid token -> generic "invited to agentiko" fallback
                               (must NOT leak inviter/tenant from cache)
  3. Human UA                -> untouched SPA index.html
  4. Missing token on bot UA -> same generic fallback

Plus unit tests for the pure helpers in api.invite_og.
"""

from __future__ import annotations

import os
from unittest.mock import MagicMock

import pytest

os.environ.setdefault("APP_METER_BASE_URL", "http://meter.test")
os.environ.setdefault("APP_METER_ADMIN_TOKEN", "fake-admin-token")
os.environ.setdefault("APP_PUBLIC_URL", "https://app-dev.agentiko.io")

from fastapi.testclient import TestClient  # noqa: E402

from api import main as api_main  # noqa: E402
from api.invite_og import (  # noqa: E402
    inject_og,
    is_bot_ua,
    pick_locale,
    render_og_block,
)


INDEX_TEMPLATE = """<!doctype html>
<html lang="he" dir="rtl">
<head>
  <title>agentiko</title>
  <!-- OG:START -->
  <meta property="og:title" content="agentiko" />
  <meta property="og:description" content="An AI employee in WhatsApp, for the price of a coffee a day." />
  <meta property="og:image" content="https://app.agentiko.io/og-image.png" />
  <!-- OG:END -->
</head>
<body><div id="root"></div></body>
</html>"""


@pytest.fixture
def client(tmp_path, monkeypatch):
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text(INDEX_TEMPLATE, encoding="utf-8")
    monkeypatch.setattr(api_main, "STATIC_DIR", dist)

    db = MagicMock()
    db.get_invite_by_token = MagicMock(
        return_value={
            "inviter_name": "Yossi",
            "inviter_email": "yossi@example.com",
            "tenant_name": "Salon Dalia",
            "role": "admin",
        }
    )
    api_main.app.state.db = db
    return TestClient(api_main.app, raise_server_exceptions=False)


def test_bot_with_valid_token_gets_dynamic_og(client):
    resp = client.get(
        "/invites/accept?token=tkn",
        headers={"User-Agent": "facebookexternalhit/1.1"},
    )
    assert resp.status_code == 200
    body = resp.text
    assert "Yossi" in body
    assert "Salon Dalia" in body
    # sentinels preserved so the handler is idempotent across re-patches
    assert "<!-- OG:START -->" in body
    assert "<!-- OG:END -->" in body
    # Cache header encourages cheap scraper retries
    assert "max-age=300" in resp.headers.get("cache-control", "")


def test_bot_with_unknown_token_gets_generic_og(client):
    client.app.state.db.get_invite_by_token = MagicMock(return_value=None)
    resp = client.get(
        "/invites/accept?token=bogus",
        headers={"User-Agent": "WhatsApp/2.0"},
    )
    assert resp.status_code == 200
    body = resp.text
    # Silent fallback — must not leak that the token is unknown vs valid
    assert "Yossi" not in body
    assert "Salon Dalia" not in body
    # Hebrew fallback (default locale)
    assert "הוזמנת" in body


def test_human_ua_gets_untouched_spa(client):
    resp = client.get(
        "/invites/accept?token=tkn",
        headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)"},
    )
    assert resp.status_code == 200
    # Invite lookup was never run for a human request
    client.app.state.db.get_invite_by_token.assert_not_called()
    # Original static OG block untouched
    assert "Yossi" not in resp.text
    assert 'content="agentiko"' in resp.text


def test_bot_without_token_gets_generic_og(client):
    resp = client.get(
        "/invites/accept",
        headers={"User-Agent": "LinkedInBot/1.0 (compatible)"},
    )
    assert resp.status_code == 200
    assert "Yossi" not in resp.text


def test_english_accept_language_renders_english(client):
    resp = client.get(
        "/invites/accept?token=tkn",
        headers={
            "User-Agent": "facebookexternalhit/1.1",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    assert "invited you to Salon Dalia on agentiko" in resp.text


# ── Pure-function unit tests ─────────────────────────────────────────────


def test_is_bot_ua_matches_known_scrapers():
    for ua in [
        "facebookexternalhit/1.1",
        "Twitterbot/1.0",
        "LinkedInBot/1.0",
        "WhatsApp/2.21",
        "TelegramBot (like TwitterBot)",
        "Slackbot-LinkExpanding 1.0",
        "Discordbot/2.0",
    ]:
        assert is_bot_ua(ua), f"Expected bot match for {ua!r}"


def test_is_bot_ua_rejects_humans_and_empty():
    for ua in [
        "Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/120",
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5)",
        "",
        None,
    ]:
        assert not is_bot_ua(ua)


def test_pick_locale_defaults_hebrew():
    # Missing or non-English Accept-Language → Hebrew, matching the
    # invite-email template's Hebrew-first design.
    assert pick_locale(None) == "he"
    assert pick_locale("") == "he"
    assert pick_locale("he-IL,he;q=0.9") == "he"
    assert pick_locale("ar-IL,ar;q=0.8") == "he"
    assert pick_locale("ru-RU") == "he"


def test_pick_locale_prefers_english_when_asked():
    assert pick_locale("en-US,en;q=0.9,he;q=0.8") == "en"
    assert pick_locale("en") == "en"


def test_render_og_block_dynamic_hebrew():
    block = render_og_block(
        url="https://app.agentiko.io/invites/accept?token=x",
        inviter_name="Yossi",
        tenant_name="Salon Dalia",
        role="admin",
        lang="he",
    )
    assert "Yossi" in block
    assert "Salon Dalia" in block
    assert 'content="he_IL"' in block
    assert "og-image.png" in block


def test_render_og_block_generic_when_no_invite():
    block = render_og_block(
        url="https://app.agentiko.io/invites/accept",
        inviter_name=None,
        tenant_name=None,
        role=None,
        lang="en",
    )
    assert "invited to agentiko" in block


def test_render_og_block_escapes_hostile_input():
    block = render_og_block(
        url="https://app.agentiko.io/invites/accept?token=x",
        inviter_name="<script>alert(1)</script>",
        tenant_name='" onerror="x',
        role="member",
        lang="en",
    )
    # Raw HTML tags and attribute-break sequences never reach output
    assert "<script>" not in block
    assert '"onerror="x' not in block
    assert "&lt;script&gt;" in block


def test_inject_og_replaces_marker_region():
    html = (
        "<head>\n"
        "    <!-- OG:START -->\n"
        '    <meta property="og:title" content="agentiko" />\n'
        "    <!-- OG:END -->\n"
        "</head>"
    )
    replacement = '<meta property="og:title" content="Custom" />'
    out = inject_og(html, replacement)
    assert "Custom" in out
    assert 'content="agentiko"' not in out
    assert "<!-- OG:START -->" in out
    assert "<!-- OG:END -->" in out


def test_inject_og_passthrough_when_markers_missing():
    html = "<head><title>agentiko</title></head>"
    out = inject_og(html, '<meta property="og:title" content="Custom" />')
    # Missing markers => return untouched so we never serve broken HTML
    assert out == html
