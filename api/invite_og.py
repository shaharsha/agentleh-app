"""Dynamic OG injection for `/invites/accept?token=...`.

Invite links are the one app URL routinely pasted cold into WhatsApp /
Slack / LinkedIn / Gmail. A share like
  "Yossi invited you to Salon Dalia on Agentiko"
lands dramatically better than the generic "Agentiko" card the SPA
would otherwise hand back.

The SPA can't do this itself — scrapers don't execute JS. So this
module does the one necessary server trick: detect social-scraper User-
Agents, look up the invite by token (same path the existing
/api/invites/preview route uses), and swap the static OG block in the
built index.html for a dynamic one. Humans always get the untouched
SPA shell.

Unknown / expired / revoked tokens fall back to the generic "you've
been invited to Agentiko" card — we deliberately don't leak token
validity through the preview, matching /api/invites/preview's
404-on-enumeration behavior.
"""

from __future__ import annotations

import html
import re
from pathlib import Path
from typing import Any

_BOT_UA_PATTERN = re.compile(
    r"facebookexternalhit|"
    r"facebot|"
    r"twitterbot|"
    r"linkedinbot|"
    r"slackbot|"
    r"telegrambot|"
    r"discordbot|"
    r"whatsapp|"
    r"redditbot|"
    r"applebot|"
    r"mastodon|"
    r"pinterest|"
    r"skypeuripreview",
    re.IGNORECASE,
)

_OG_MARKER_RE = re.compile(
    r"<!-- OG:START.*?-->.*?<!-- OG:END -->",
    re.DOTALL,
)

OG_IMAGE_URL = "https://app.agentiko.io/og-image.png"


def is_bot_ua(user_agent: str | None) -> bool:
    """True if the request came from a link-preview scraper."""
    return bool(_BOT_UA_PATTERN.search(user_agent or ""))


def pick_locale(accept_language: str | None) -> str:
    """Hebrew-first. Only flips to English when Accept-Language explicitly
    prefers it; anything else (missing header, Arabic, Russian, etc.)
    stays Hebrew to match the invite-email template."""
    if not accept_language:
        return "he"
    first = accept_language.split(",", 1)[0].split(";", 1)[0].strip().lower()
    primary = first.split("-", 1)[0]
    return "en" if primary == "en" else "he"


def render_og_block(
    *,
    url: str,
    inviter_name: str | None,
    tenant_name: str | None,
    role: str | None,
    lang: str,
) -> str:
    """Build the <meta> block that replaces the static one between the
    OG:START / OG:END sentinels in index.html.

    `inviter_name` and `tenant_name` may be None for unknown tokens;
    in that case we render the generic fallback copy.
    """
    safe_url = html.escape(url, quote=True)
    have_invite = bool(inviter_name and tenant_name)

    if have_invite:
        safe_inviter = html.escape(inviter_name or "", quote=True)
        safe_tenant = html.escape(tenant_name or "", quote=True)
        if lang == "en":
            title = f"{safe_inviter} invited you to {safe_tenant} on Agentiko"
            description = (
                f"Join {safe_tenant} as {html.escape(role or 'a member', quote=True)} on Agentiko."
            )
        else:
            title = f"{safe_inviter} הזמין/ה אותך ל-{safe_tenant} ב-Agentiko"
            description = f"הצטרף/י ל-{safe_tenant} ב-Agentiko."
    else:
        if lang == "en":
            title = "You've been invited to Agentiko"
            description = "An AI employee in WhatsApp, for the price of a coffee a day."
        else:
            title = "הוזמנת ל-Agentiko"
            description = "עובד AI בוואטסאפ, במחיר של קפה ביום."

    og_locale = "he_IL" if lang == "he" else "en_US"

    return "\n    ".join(
        [
            f'<meta name="description" content="{description}" />',
            f'<meta property="og:site_name" content="Agentiko" />',
            f'<meta property="og:type" content="website" />',
            f'<meta property="og:locale" content="{og_locale}" />',
            f'<meta property="og:title" content="{title}" />',
            f'<meta property="og:description" content="{description}" />',
            f'<meta property="og:url" content="{safe_url}" />',
            f'<meta property="og:image" content="{OG_IMAGE_URL}" />',
            f'<meta property="og:image:width" content="1200" />',
            f'<meta property="og:image:height" content="630" />',
            f'<meta property="og:image:type" content="image/png" />',
            f'<meta property="og:image:alt" content="Agentiko" />',
            f'<meta name="twitter:card" content="summary_large_image" />',
            f'<meta name="twitter:title" content="{title}" />',
            f'<meta name="twitter:description" content="{description}" />',
            f'<meta name="twitter:image" content="{OG_IMAGE_URL}" />',
        ]
    )


def inject_og(index_html: str, og_block: str) -> str:
    """Replace the OG:START..OG:END region in a built index.html.
    If the markers aren't present (e.g. the frontend build drifted)
    the original HTML is returned untouched so we never serve a broken
    page just to get a nicer preview."""
    replacement = f"<!-- OG:START -->\n    {og_block}\n    <!-- OG:END -->"
    patched, count = _OG_MARKER_RE.subn(replacement, index_html, count=1)
    return patched if count else index_html


def extract_invite_fields(invite: dict[str, Any] | None) -> tuple[str | None, str | None, str | None]:
    """Pull (inviter_name, tenant_name, role) from a row returned by
    `AppDatabase.get_invite_by_token`. Falls back to inviter_email when
    the user hasn't set a full_name."""
    if invite is None:
        return None, None, None
    inviter = invite.get("inviter_name") or invite.get("inviter_email")
    return inviter, invite.get("tenant_name"), invite.get("role")


def read_index_html(static_dir: Path) -> str | None:
    """Returns the built SPA index.html, or None if the build isn't
    present (local dev without `npm run build`)."""
    idx = static_dir / "index.html"
    if not idx.exists():
        return None
    try:
        return idx.read_text(encoding="utf-8")
    except OSError:
        return None
