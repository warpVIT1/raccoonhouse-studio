"""
Telegram login — lets a profile be created/activated by signing in through
the Telegram Login Widget instead of typing a name manually. See
cloudflare-signaling/src/index.ts's /telegram-login routes for the actual
widget page + HMAC signature verification (Telegram's own documented
algorithm, keyed by the studio's bot token — a Worker secret, never
exposed here or to the frontend) — this module only ever talks to the
already-verified result, never raw Telegram data.

Flow: start_login() mints a random one-time code and hands back the widget
URL; the Electron main process opens that URL in an embedded webview (see
electron/main.ts) rather than a system browser, since there's no
raccoonhouse:// URL scheme registered with the installer for Telegram to
redirect back into. Once the person authorizes in Telegram, the widget page
itself POSTs straight to the Worker (never through this backend) and this
app polls poll_login(code) until the Worker reports it done — the same
shape as a device-code OAuth flow.
"""
import secrets

import requests

from . import discovery_service


class TelegramLoginError(Exception):
    pass


def _base() -> str:
    base = discovery_service.get_https_base()
    if not base:
        raise TelegramLoginError("Онлайн-синхронізація вимкнена або недоступна")
    return base


def start_login() -> dict:
    code = secrets.token_urlsafe(24)
    return {"code": code, "url": f"{_base()}/telegram-login?code={code}"}


def poll_login(code: str) -> "dict | None":
    """Returns the verified Telegram profile dict once the widget flow on
    the Worker has completed, or None while still waiting. Raises
    TelegramLoginError if the code expired (see the Worker's own 10-minute
    window) — the caller should let the person start over rather than poll
    forever."""
    resp = requests.get(f"{_base()}/telegram-login/poll", params={"code": code}, timeout=15)
    if resp.status_code == 202:
        return None
    if resp.status_code == 410:
        raise TelegramLoginError("Час на вхід через Telegram вичерпано — спробуйте ще раз")
    resp.raise_for_status()
    return resp.json()
