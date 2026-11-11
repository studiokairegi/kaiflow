"""Supabase access for the worker. It signs in as the AGENT USER (never the service-role key) and may call only
the intel_agent_* RPCs, which are the only things that identity is granted."""
from __future__ import annotations

import time

import requests

from .errors import RpcError, TransientError


class SupabaseAgent:
    def __init__(self, cfg, session: requests.Session | None = None, clock=time.time):
        self.cfg, self.s, self.clock = cfg, session or requests.Session(), clock
        self._token, self._exp = "", 0.0

    def _login(self) -> None:
        try:
            r = self.s.post(f"{self.cfg.supabase_url}/auth/v1/token?grant_type=password",
                            json={"email": self.cfg.agent_email, "password": self.cfg.agent_password},
                            headers={"apikey": self.cfg.supabase_anon_key}, timeout=20)
        except requests.RequestException as exc:
            raise TransientError(f"auth network error: {exc}") from exc
        if r.status_code >= 500 or r.status_code == 429:
            raise TransientError(f"auth {r.status_code}")
        if r.status_code != 200:
            raise RpcError(f"agent sign-in was refused: {r.text[:500]}", "auth", r.status_code)
        d = r.json()
        self._token, self._exp = d["access_token"], self.clock() + float(d.get("expires_in", 3600)) - 60

    def token(self) -> str:
        if not self._token or self.clock() >= self._exp:
            self._login()
        return self._token

    def rpc(self, name: str, params: dict | None = None):
        if not name.startswith("intel_agent_"):
            raise RpcError(f"worker may only call intel_agent_* functions, not {name}", "forbidden", 0)
        for attempt in (0, 1):
            try:
                r = self.s.post(f"{self.cfg.supabase_url}/rest/v1/rpc/{name}", json=params or {}, timeout=30,
                                headers={"apikey": self.cfg.supabase_anon_key, "Authorization": f"Bearer {self.token()}",
                                         "Content-Type": "application/json"})
            except requests.RequestException as exc:
                raise TransientError(f"network error calling {name}: {exc}") from exc
            if r.status_code == 401 and attempt == 0:
                self._token = ""
                continue
            if r.status_code in (429,) or r.status_code >= 500:
                raise TransientError(f"{name} -> {r.status_code}")
            if r.status_code >= 400:
                try:
                    d = r.json()
                except ValueError:
                    d = {}
                raise RpcError(d.get("message", f"{name} failed"), str(d.get("code", "")), r.status_code)
            return r.json() if r.content else None
        raise RpcError("unauthorized", "auth", 401)
