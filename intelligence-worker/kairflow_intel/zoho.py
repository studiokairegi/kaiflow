"""Zoho Mail REST client. Endpoint paths follow Zoho's public REST API documentation as I understand it; they have NOT been
exercised against a live account. Run `python -m kairflow_intel selftest zoho` (read-only: lists folders, never sends)
after connecting, and fix any response-shape difference in THIS file only. Everything else talks to this small surface."""
from __future__ import annotations

import re
import time

import requests

from .errors import PermanentError, TransientError
from .safety import html_to_text


class ZohoRejected(Exception):
    """Zoho definitively refused the request (4xx). The message was NOT sent."""


class EdgeTokenProvider:
    """Short-lived Zoho access tokens come from the intel-zoho-token Edge Function, which holds the refresh token.
    The worker authenticates to it with the agent's own JWT; Zoho secrets never reach this machine."""

    def __init__(self, cfg, supa, session: requests.Session | None = None, clock=time.time):
        self.cfg, self.supa, self.s, self.clock = cfg, supa, session or requests.Session(), clock
        self._tok = None

    def get(self, force: bool = False) -> dict:
        if self._tok and not force and self.clock() < self._tok["exp"]:
            return self._tok
        try:
            r = self.s.post(f"{self.cfg.supabase_url}/functions/v1/intel-zoho-token", json={}, timeout=20,
                            headers={"apikey": self.cfg.supabase_anon_key, "Authorization": f"Bearer {self.supa.token()}"})
        except requests.RequestException as exc:
            raise TransientError(f"token function unreachable: {exc}") from exc
        if r.status_code >= 500 or r.status_code == 429:
            raise TransientError(f"token function {r.status_code}")
        if r.status_code != 200:
            raise PermanentError(f"Zoho is not connected or the agent is not allowed to use it ({r.status_code})")
        d = r.json()
        self._tok = {"access_token": d["access_token"], "base": d["api_base"].rstrip("/"), "account_id": str(d["account_id"]), "exp": self.clock() + int(d.get("expires_in", 3000)) - 120}
        return self._tok


class ZohoClient:
    def __init__(self, tokens, session: requests.Session | None = None):
        self.tokens, self.s = tokens, session or requests.Session()
        self._folders: dict[str, str] | None = None

    def _call(self, method: str, path: str, *, params=None, json=None):
        for attempt in (0, 1):
            t = self.tokens.get(force=attempt == 1)
            try:
                r = self.s.request(method, f"{t['base']}/accounts/{t['account_id']}{path}", params=params, json=json, timeout=30,
                                   headers={"Authorization": f"Zoho-oauthtoken {t['access_token']}", "Accept": "application/json"})
            except requests.RequestException as exc:
                raise TransientError(f"zoho network error: {exc}") from exc     # outcome of a send is UNKNOWN here
            if r.status_code == 401 and attempt == 0:
                continue
            if r.status_code == 429 or r.status_code >= 500:
                raise TransientError(f"zoho {r.status_code}")                    # for a send: outcome unknown
            if r.status_code >= 400:
                raise ZohoRejected(f"zoho {r.status_code}: {r.text[:200]}")
            try:
                return r.json()
            except ValueError as exc:
                raise TransientError("zoho returned a non-JSON response") from exc
        raise TransientError("zoho authorization failed")

    def folder_id(self, kind: str) -> str:
        if self._folders is None:
            data = self._call("GET", "/folders").get("data") or []
            self._folders = {str(f.get("folderType", "")).lower(): str(f["folderId"]) for f in data if f.get("folderId")}
        if kind.lower() not in self._folders:
            raise PermanentError(f"Zoho folder {kind!r} not found")
        return self._folders[kind.lower()]

    def send(self, from_addr: str, to_addr: str, subject: str, body: str, *, in_reply_to_zoho_id: str | None = None) -> dict:
        payload = {"fromAddress": from_addr, "toAddress": to_addr, "subject": subject, "content": body, "mailFormat": "plaintext", "askReceipt": "no"}
        d = self._call("POST", "/messages", json=payload).get("data") or {}
        return {"zoho_message_id": str(d.get("messageId", "")), "thread_id": str(d.get("threadId", "") or "")}

    def list_messages(self, folder: str, limit: int = 50, start: int = 1) -> list[dict]:
        rows = self._call("GET", "/messages/view", params={"folderId": self.folder_id(folder), "limit": limit, "start": start, "sortBy": "date", "sortorder": "false"}).get("data") or []
        return [{"id": str(r.get("messageId")), "folder_id": str(r.get("folderId") or self.folder_id(folder)), "subject": r.get("subject", ""),
                 "from": (r.get("fromAddress") or r.get("sender") or "").strip(), "to": (r.get("toAddress") or "").strip(),
                 "time_ms": int(r.get("receivedTime") or r.get("sentDateInGMT") or 0), "thread_id": str(r.get("threadId", "") or "")} for r in rows if r.get("messageId")]

    def content_text(self, folder_id: str, message_id: str) -> str:
        d = self._call("GET", f"/folders/{folder_id}/messages/{message_id}/content").get("data") or {}
        return html_to_text(d.get("content", "") or "", limit=20000)

    def rfc_headers(self, folder_id: str, message_id: str) -> dict:
        """Message-ID, In-Reply-To, References, Auto-Submitted. Best effort: failure returns {} and matching falls back to the token."""
        try:
            d = self._call("GET", f"/folders/{folder_id}/messages/{message_id}/header").get("data") or {}
        except (PermanentError, ZohoRejected, TransientError):
            return {}
        raw = d.get("headerContent") or d.get("content") or ""
        if isinstance(raw, dict):
            return {k: v if isinstance(v, str) else " ".join(v) for k, v in raw.items()}
        out = {}
        for m in re.finditer(r"^([A-Za-z\-]+):[ \t]*(.*(?:\r?\n[ \t].*)*)", str(raw), re.M):
            out[m.group(1)] = re.sub(r"\s+", " ", m.group(2)).strip()
        return out

    def find_sent(self, token: str, to_email: str, since_ms: int) -> dict | None:
        """Look in the Sent folder for the message carrying our token: proves whether a send happened."""
        for m in self.list_messages("sent", limit=50):
            if m["time_ms"] and m["time_ms"] < since_ms:
                continue
            if to_email.lower() not in (m["to"] or "").lower():
                continue
            if token in (m["subject"] or "") or token in self.content_text(m["folder_id"], m["id"]):
                h = self.rfc_headers(m["folder_id"], m["id"])
                return {"zoho_message_id": m["id"], "rfc_message_id": h.get("Message-ID", "").strip(), "thread_id": m["thread_id"], "time_ms": m["time_ms"]}
        return None
