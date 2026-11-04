"""Resend transport adapter. The API key stays in Supabase Edge Function secrets.

The worker authenticates as its limited Intelligence agent and asks the dedicated
Edge Function to send a message already reserved/marked-sending in the database.
"""
from __future__ import annotations

import requests

from .errors import MailRejected, TransientError


class ResendClient:
    disabled = False
    provider = "resend"

    def __init__(self, cfg, supa, session: requests.Session | None = None):
        self.cfg, self.supa, self.s = cfg, supa, session or requests.Session()

    def _call(self, message_id: str):
        try:
            r = self.s.post(
                f"{self.cfg.supabase_url}/functions/v1/intel-resend-send",
                json={"message_id": message_id}, timeout=30,
                headers={"apikey": self.cfg.supabase_anon_key,
                         "Authorization": f"Bearer {self.supa.token()}",
                         "Content-Type": "application/json"},
            )
        except requests.RequestException as exc:
            raise TransientError(f"Resend proxy network outcome unknown: {type(exc).__name__}") from exc
        try:
            data = r.json()
        except ValueError:
            data = {}
        status = data.get("status")
        if r.status_code in (200, 201) and data.get("ok") and data.get("id"):
            return {"zoho_message_id": str(data["id"]), "thread_id": "", "rfc_message_id": str(data.get("rfc_message_id") or "")}
        if status == "rejected" or (400 <= r.status_code < 500 and r.status_code != 429 and status != "unknown"):
            raise MailRejected(f"Resend rejected request ({r.status_code}): {str(data.get('error') or 'request rejected')[:160]}")
        raise TransientError(f"Resend outcome unknown ({r.status_code or 'network'})")

    def send(self, from_addr, to_addr, subject, body, *, reply_to_zoho_id=None, in_reply_to=None, references=None, message_id=None):
        if not message_id:
            raise MailRejected("Resend requires a reserved Intelligence message id")
        return self._call(message_id)

    def verify_sent(self, provider_message_id: str, message_id: str | None = None) -> dict | None:
        """Verify an already-known Resend id through the server-side proxy."""
        if not provider_message_id or not message_id:
            return None
        try:
            r = self.s.post(
                f"{self.cfg.supabase_url}/functions/v1/intel-resend-send",
                json={"action": "verify", "message_id": message_id, "provider_message_id": provider_message_id}, timeout=20,
                headers={"apikey": self.cfg.supabase_anon_key, "Authorization": f"Bearer {self.supa.token()}", "Content-Type": "application/json"},
            )
        except requests.RequestException as exc:
            raise TransientError(f"Resend verification unavailable: {type(exc).__name__}") from exc
        try:
            data = r.json()
        except ValueError:
            data = {}
        if r.status_code == 200 and data.get("verified") is True:
            return {"zoho_message_id": provider_message_id, "rfc_message_id": "", "thread_id": "", "time_ms": 0}
        if r.status_code == 404:
            return None
        raise TransientError(f"Resend verification unavailable ({r.status_code})")

    def find_sent(self, token: str, to_email: str, since_ms: int):
        # Resend has no mailbox Sent folder. Absence cannot be inferred from a search.
        return None

    def check(self):
        return True, "Resend selected locally; this read-only check does not verify the deployed Edge Function or live Resend service"
