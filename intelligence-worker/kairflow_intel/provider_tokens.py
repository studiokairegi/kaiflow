"""Short-lived access-token client for account-scoped provider credentials."""
from __future__ import annotations

import time

import requests

from .errors import PermanentError, TransientError


class ProviderAccountTokenProvider:
    def __init__(self, cfg, supa, account_id: str, *, provider: str, session=None, clock=time.time):
        if not account_id:
            raise ValueError("provider account id is required")
        self.cfg, self.supa, self.account_id, self.provider = cfg, supa, str(account_id), provider
        self.s, self.clock, self._tok = session or requests.Session(), clock, None

    def get(self, force: bool = False) -> dict:
        if self._tok and not force and self.clock() < self._tok["exp"]:
            return self._tok
        try:
            r = self.s.post(
                f"{self.cfg.supabase_url}/functions/v1/intel-provider-token",
                json={"account_id": self.account_id}, timeout=20,
                headers={"apikey": self.cfg.supabase_anon_key,
                         "Authorization": f"Bearer {self.supa.token()}"},
            )
        except requests.RequestException as exc:
            raise TransientError(f"provider token function unreachable: {exc}") from exc
        if r.status_code == 429 or r.status_code >= 500:
            raise TransientError(f"provider token function {r.status_code}")
        if r.status_code != 200:
            raise PermanentError(f"{self.provider} account is unavailable or not authorized ({r.status_code})")
        data = r.json()
        if data.get("provider") != self.provider:
            raise PermanentError("provider token response did not match the requested adapter")
        if self.provider == "smtp":
            required = ("host", "port", "username", "password", "tls_mode", "mailbox")
            if any(not data.get(k) for k in required):
                raise PermanentError("SMTP credential response is incomplete")
            self._tok = {k: data[k] for k in required}
            self._tok["exp"] = self.clock() + 240
        else:
            self._tok = {
                "access_token": data["access_token"],
                "base": data["api_base"].rstrip("/"),
                "account_id": str(data.get("external_account_id") or "me"),
                "mailbox": str(data.get("mailbox") or ""),
                "exp": self.clock() + int(data.get("expires_in", 3000)) - 120,
            }
        return self._tok
