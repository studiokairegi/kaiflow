"""Zoho Mail REST client. Endpoint paths follow Zoho's public REST API documentation as I understand it; they have NOT been
exercised against a live account. Run `python -m kairflow_intel selftest zoho` (read-only: lists folders, never sends)
after connecting, and fix any response-shape difference in THIS file only. Everything else talks to this small surface."""
from __future__ import annotations

import re
import time

import requests

from .errors import MailRejected, PermanentError, ThreadingRejected, TransientError
from .safety import html_to_text


class ZohoRejected(MailRejected):
    """Zoho definitively refused the request (4xx). The message was NOT sent."""


class EdgeTokenProvider:
    """Short-lived Zoho access tokens come from the intel-zoho-token Edge Function, which holds the refresh token.
    The worker authenticates to it with the agent's own JWT; Zoho secrets never reach this machine."""

    def __init__(self, cfg, supa, session: requests.Session | None = None, clock=time.time, function: str = "intel-zoho-token"):
        self.cfg, self.supa, self.s, self.clock, self.function = cfg, supa, session or requests.Session(), clock, function
        self._tok = None

    def get(self, force: bool = False) -> dict:
        if self._tok and not force and self.clock() < self._tok["exp"]:
            return self._tok
        try:
            r = self.s.post(f"{self.cfg.supabase_url}/functions/v1/{self.function}", json={}, timeout=20,
                            headers={"apikey": self.cfg.supabase_anon_key, "Authorization": f"Bearer {self.supa.token()}"})
        except requests.RequestException as exc:
            raise TransientError(f"token function unreachable: {exc}") from exc
        if r.status_code >= 500 or r.status_code == 429:
            raise TransientError(f"token function {r.status_code}")
        if r.status_code != 200:
            raise PermanentError(f"Zoho is not connected or the agent is not allowed to use it ({r.status_code})")
        d = r.json()
        self._tok = {"access_token": d["access_token"], "base": d["api_base"].rstrip("/"), "account_id": str(d["account_id"]), "mailbox": str(d.get("mailbox") or ""), "exp": self.clock() + int(d.get("expires_in", 3000)) - 120}
        return self._tok


class ZohoClient:
    provider = "zoho"

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

    def send(self, from_addr: str, to_addr: str, subject: str, body: str, *, reply_to_zoho_id: str | None = None, in_reply_to: str | None = None, references: str | None = None) -> dict:
        """Send plain text. (`in_reply_to`/`references` are accepted for interface parity with Gmail and ignored: Zoho sets them itself.) When `reply_to_zoho_id` is given, use Zoho's reply action so Zoho itself sets In-Reply-To and
        References and the message lands in the same thread. If Zoho definitively refuses the reply action (4xx),
        fail closed for manual review; never downgrade a reply to a new unthreaded message. Network errors and 429/5xx
        are never retried here (outcome unknown: the caller marks the message `unknown`).
        NOT verified against a live Zoho account: see docs/ZOHO_COMPATIBILITY.md."""
        payload = {"fromAddress": from_addr, "toAddress": to_addr, "subject": subject, "content": body, "mailFormat": "plaintext", "askReceipt": "no"}
        if reply_to_zoho_id:
            if not re.fullmatch(r"\d{6,30}", str(reply_to_zoho_id)):
                raise ThreadingRejected("Zoho reply parent id is malformed; refusing an unthreaded fallback")
            try:
                d = self._call("POST", f"/messages/{reply_to_zoho_id}", json={**payload, "action": "reply"}).get("data") or {}
            except ZohoRejected as exc:
                # A 4xx is a definite refusal, but silently converting a reply into a new
                # conversation is unsafe. Keep it failed for manual review instead.
                raise ThreadingRejected(f"Zoho rejected native reply threading: {exc}") from exc
            return {"zoho_message_id": str(d.get("messageId", "")), "thread_id": str(d.get("threadId", "") or ""), "threaded": True}
        d = self._call("POST", "/messages", json=payload).get("data") or {}
        return {"zoho_message_id": str(d.get("messageId", "")), "thread_id": str(d.get("threadId", "") or ""), "threaded": False}

    def list_messages(self, folder: str, limit: int = 50, start: int = 1) -> list[dict]:
        rows = self._call("GET", "/messages/view", params={"folderId": self.folder_id(folder), "limit": limit, "start": start, "sortBy": "date", "sortorder": "false"}).get("data") or []
        return [{"id": str(r.get("messageId")), "folder_id": str(r.get("folderId") or self.folder_id(folder)), "subject": r.get("subject", ""),
                 "from": (r.get("fromAddress") or r.get("sender") or "").strip(), "to": (r.get("toAddress") or "").strip(),
                 "time_ms": int(r.get("receivedTime") or r.get("sentDateInGMT") or 0), "thread_id": str(r.get("threadId", "") or "")} for r in rows if r.get("messageId")]

    def iter_messages(self, folder: str, page_size: int = 50, max_pages: int | None = None):
        """Yield pages using Zoho offsets with overlap and duplicate suppression.

        `max_pages` bounds reconciliation scans; inbox sync may leave it unset to
        traverse the complete backlog before committing its cursor.
        """
        start = 1
        overlap = min(10, max(1, page_size // 5))
        seen_ids: set[str] = set()
        pages = 0
        while max_pages is None or pages < max_pages:
            page = self.list_messages(folder, limit=page_size, start=start)
            pages += 1
            if not page:
                return
            fresh = [row for row in page if row.get("id") not in seen_ids]
            seen_ids.update(row.get("id") for row in page if row.get("id"))
            yield from fresh
            if len(page) < page_size:
                return
            # Zoho offsets are not opaque cursors. Overlap adjacent pages to
            # reduce skips when new messages arrive while the scan is in progress.
            start += max(1, len(page) - overlap)

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
        # Sent-folder reconciliation must look beyond the first page: after a busy
        # day the target can be older than the newest 50 messages. Keep the scan bounded.
        for m in self.iter_messages("sent", page_size=100, max_pages=20):
            if m["time_ms"] and m["time_ms"] < since_ms:
                continue
            recipients = {x.strip().lower() for x in re.split(r"[,;]", m.get("to") or "") if x.strip()}
            if to_email.lower() not in recipients and to_email.lower() not in (m["to"] or "").lower():
                continue
            if token in (m["subject"] or "") or token in self.content_text(m["folder_id"], m["id"]):
                h = self.rfc_headers(m["folder_id"], m["id"])
                return {"zoho_message_id": m["id"], "rfc_message_id": h.get("Message-ID", "").strip(), "thread_id": m["thread_id"], "time_ms": m["time_ms"]}
        return None

    def check(self) -> tuple[bool, str]:
        """Read-only self-test: both folders must be listable. Never sends."""
        ok = bool(self.folder_id("inbox")) and bool(self.folder_id("sent"))
        return ok, "inbox and sent folders readable"
