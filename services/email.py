"""Transactional email via Resend.

Used by the tenant invite flow to send `noreply@agentiko.io` invite
emails to prospective members. Single entry point: `send_invite_email`.

Design:
  - One HTTP POST to https://api.resend.com/emails using the sending API
    key from Secret Manager (RESEND_API_KEY env var, injected by Cloud
    Run via --set-secrets).
  - Hebrew-first, RTL-safe HTML + plaintext bodies.
  - 5-second timeout — if Resend is slow or down, the caller in
    routes/tenants.py catches the exception and falls back to copy-link
    UX so invite creation always succeeds.
  - No external template engine — the template is a f-string so the
    whole file is ~100 lines and easy to audit.

We deliberately do NOT support multiple providers here (SendGrid,
Mailjet, etc.) — the plan doc calls out that swapping providers is a
single-file change and not worth an abstraction layer now.
"""

from __future__ import annotations

import logging
import os
from html import escape

import httpx

logger = logging.getLogger(__name__)

RESEND_API_URL = "https://api.resend.com/emails"
FROM_ADDRESS = "Agentleh <noreply@agentiko.io>"


def _api_key() -> str:
    """Read the Resend sending key from the env. Cloud Run injects it
    from Secret Manager `resend-api-key` / `-dev`."""
    key = os.environ.get("RESEND_API_KEY", "").strip()
    if not key:
        raise RuntimeError("RESEND_API_KEY is not set")
    return key


def _role_he(role: str) -> str:
    """Hebrew label for the role badge in the email body."""
    return {"admin": "מנהל/ת", "member": "חבר/ה"}.get(role, role)


def _invite_html(
    *,
    tenant_name: str,
    inviter_name: str,
    role: str,
    accept_url: str,
) -> str:
    """Hebrew-first RTL invite email body. Uses inline styles because
    most email clients ignore <style> blocks in <head>. The button is a
    table cell for Outlook compatibility (Outlook doesn't render padding
    on <a>)."""
    tenant = escape(tenant_name)
    inviter = escape(inviter_name)
    role_label = escape(_role_he(role))
    url = escape(accept_url)

    return f"""<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>הזמנה ל-{tenant} ב-Agentleh</title>
</head>
<body style="margin:0;padding:0;background:#f7f7f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;direction:rtl;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f7f7f8;padding:40px 0;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="background:#ffffff;border-radius:16px;box-shadow:0 1px 3px rgba(0,0,0,0.08);overflow:hidden;">
          <tr>
            <td style="padding:40px 40px 24px 40px;text-align:right;">
              <div style="font-size:28px;font-weight:700;color:#111;letter-spacing:-0.5px;">Agentleh</div>
              <div style="font-size:14px;color:#888;margin-top:4px;">עוזר ה-AI שלך בוואטסאפ</div>
            </td>
          </tr>
          <tr>
            <td style="padding:0 40px 24px 40px;text-align:right;">
              <h1 style="font-size:22px;font-weight:600;color:#111;margin:0 0 12px 0;line-height:1.35;">
                {inviter} הזמין/ה אותך להצטרף ל־<span style="color:#4338ca;">{tenant}</span>
              </h1>
              <p style="font-size:16px;color:#555;margin:0 0 8px 0;line-height:1.6;">
                קיבלת הזמנה להצטרף לסביבת עבודה ב-Agentleh בתור <strong style="color:#111;">{role_label}</strong>.
              </p>
              <p style="font-size:16px;color:#555;margin:0 0 24px 0;line-height:1.6;">
                בתוך הסביבה תוכל/י לראות ולנהל את סוכני ה-WhatsApp, לראות שימוש וחיובים, ולהזמין אנשים נוספים.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 40px 40px 40px;text-align:center;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
                <tr>
                  <td align="center" style="border-radius:12px;background:#4338ca;">
                    <a href="{url}"
                       style="display:inline-block;padding:14px 32px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:12px;">
                      קבל/י את ההזמנה
                    </a>
                  </td>
                </tr>
              </table>
              <p style="font-size:13px;color:#999;margin:16px 0 0 0;text-align:center;">
                ההזמנה תוקפה 7 ימים. אם הכפתור לא עובד, העתק/י את הקישור:<br>
                <a href="{url}" style="color:#4338ca;word-break:break-all;">{url}</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 40px;border-top:1px solid #eee;background:#fafafa;text-align:center;">
              <p style="font-size:12px;color:#999;margin:0;line-height:1.5;">
                אם לא ציפית להזמנה הזו, ניתן להתעלם בבטחה.<br>
                Agentleh · agentiko.io
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>"""


def _invite_text(
    *,
    tenant_name: str,
    inviter_name: str,
    role: str,
    accept_url: str,
) -> str:
    """Plain-text fallback for clients that don't render HTML."""
    role_label = _role_he(role)
    return (
        f"{inviter_name} הזמין/ה אותך להצטרף ל-{tenant_name} ב-Agentleh.\n\n"
        f"תפקיד: {role_label}\n\n"
        f"לקבלת ההזמנה לחץ/י כאן:\n{accept_url}\n\n"
        f"ההזמנה תוקפה 7 ימים.\n\n"
        f"אם לא ציפית להזמנה הזו, ניתן להתעלם.\n"
        f"Agentleh · agentiko.io\n"
    )


async def send_invite_email(
    *,
    to: str,
    tenant_name: str,
    inviter_name: str,
    role: str,
    accept_url: str,
) -> dict[str, object]:
    """Send the invite. Raises on network / auth / non-2xx so the caller
    can fall back to copy-link UX.

    Returns the Resend response dict (includes an `id` field for the
    message, useful for debugging if delivery issues are reported).
    """
    subject = f"הזמנה ל-{tenant_name} ב-Agentleh"
    body_html = _invite_html(
        tenant_name=tenant_name,
        inviter_name=inviter_name,
        role=role,
        accept_url=accept_url,
    )
    body_text = _invite_text(
        tenant_name=tenant_name,
        inviter_name=inviter_name,
        role=role,
        accept_url=accept_url,
    )

    payload = {
        "from": FROM_ADDRESS,
        "to": [to],
        "subject": subject,
        "html": body_html,
        "text": body_text,
    }

    async with httpx.AsyncClient(timeout=5.0) as client:
        resp = await client.post(
            RESEND_API_URL,
            json=payload,
            headers={
                "Authorization": f"Bearer {_api_key()}",
                "Content-Type": "application/json",
            },
        )

    if resp.status_code >= 400:
        logger.warning("resend %s: %s", resp.status_code, resp.text[:300])
        raise RuntimeError(f"resend returned {resp.status_code}: {resp.text[:200]}")

    result = resp.json()
    logger.info("invite email sent to=%s resend_id=%s", to, result.get("id"))
    return result
