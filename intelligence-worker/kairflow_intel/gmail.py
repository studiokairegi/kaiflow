"""Gmail REST client: the free alternative to Zoho Mail. Same small surface as ZohoClient (folder_id, send, list_messages, content_text,
rfc_headers, find_sent, check) so mailops/jobs do not care which provider is connected. NOT exercised against a live Google account:
run `python -m kairflow_intel selftest gmail` (read-only) after connecting, and fix any response-shape difference in THIS file only.

Why this is better for threading: we build the RFC 822 message ourselves, so In-Reply-To / References are set exactly, and the
Message-ID we generate is returned immediately (no search of the Sent folder is needed to learn it)."""
from __future__ import annotations

import base64
import re
import time
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

import requests

from .errors import MailRejected, PermanentError, TransientError
from .safety import html_to_text

LABELS = {"inbox": "INBOX", "sent": "SENT"}
HEADERS = ["From", "To", "Subject", "Message-ID", "In-Reply-To", "References", "Auto-Submitted"]
HEX_ID = re.compile(r"^[0-9a-f]{8,32}$")


class GmailRejected(MailRejected):
    """Google definitively refused the request (4xx). The message was NOT sent."""


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii")


def _decode(data: str) -> str:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)).decode("utf-8", "replace")


def build_mime(from_addr: str, to_addr: str, subject: str, body: str, in_reply_to: str | None = None, references: str | None = None) -> tuple[EmailMessage, str]:
    """Plain-text message with explicit threading headers. Returns the message and the Message-ID we assigned to it."""
    if any(c in (from_addr + to_addr + subject) for c in "\r\n"):
        raise GmailRejected("header injection attempt: line breaks are not allowed in address or subject")
    msg = EmailMessage()
    domain = from_addr.rsplit("@", 1)[-1] if "@" in from_addr else None
    mid = make_msgid(domain=domain)
    msg["From"], msg["To"], msg["Subject"], msg["Date"], msg["Message-ID"] = from_addr, to_addr, subject, formatdate(localtime=False), mid
    if in_reply_to and re.fullmatch(r"<[^<>\s]{3,300}>", in_reply_to.strip()):
        msg["In-Reply-To"] = in_reply_to.strip()
        refs = " ".join(r for r in re.findall(r"<[^<>\s]{3,300}>", references or "")[-20:])
        msg["References"] = refs if in_reply_to.strip() in refs else (refs + " " + in_reply_to.strip()).strip()
    msg.set_content(body, subtype="plain", charset="utf-8")
    return msg, mid


class GmailClient:
    def __init__(self, tokens, session: requests.Session | None = None):
        self.tokens, self.s = tokens, session or requests.Session()
        self._meta: dict[str, dict] = {}      # id -> metadata headers (messages never change, so caching is safe)

    def _call(self, method: str, path: str, *, params=None, json=None):
        for attempt in (0, 1):
            t = self.tokens.get(force=attempt == 1)
            try:
                r = self.s.request(method, f"{t['base']}/users/me{path}", params=params, json=json, timeout=30,
                                   headers={"Authorization": f"Bearer {t['access_token']}", "Accept": "application/json"})
            except requests.RequestException as exc:
                raise TransientError(f"gmail network error: {exc}") from exc       # for a send: outcome UNKNOWN
            if r.status_code == 401 and attempt == 0:
                continue
            if r.status_code == 429 or r.status_code >= 500:
                raise TransientError(f"gmail {r.status_code}")                      # for a send: outcome unknown
            if r.status_code >= 400:
                raise GmailRejected(f"gmail {r.status_code}: {r.text[:200]}")
            try:
                return r.json()
            except ValueError as exc:
                raise TransientError("gmail returned a non-JSON response") from exc
        raise TransientError("gmail authorization failed")

    def folder_id(self, kind: str) -> str:
        if kind.lower() not in LABELS:
            raise PermanentError(f"unknown mailbox folder {kind!r}")
        return LABELS[kind.lower()]

    def _thread_of(self, message_id: str) -> str | None:
        if not HEX_ID.match(str(message_id or "")):
            return None
        try:
            return self._call("GET", f"/messages/{message_id}", params={"format": "minimal"}).get("threadId")
        except (MailRejected, TransientError):
            return None                                                           # threading by headers still works without it

    def send(self, from_addr: str, to_addr: str, subject: str, body: str, *, reply_to_zoho_id: str | None = None,
             in_reply_to: str | None = None, references: str | None = None) -> dict:
        mailbox = (self.tokens.get().get("mailbox") or "").lower()
        if mailbox and from_addr.strip().lower() != mailbox:
            # Gmail would silently rewrite From; the compliance footer and Settings must match the account that really sends.
            raise GmailRejected(f"Sender email in Settings ({from_addr}) must equal the connected Gmail address ({mailbox})")
        msg, mid = build_mime(from_addr, to_addr, subject, body, in_reply_to, references)
        payload = {"raw": _b64url(msg.as_bytes())}
        thread = self._thread_of(reply_to_zoho_id) if reply_to_zoho_id else None
        if thread:
            payload["threadId"] = thread
        d = self._call("POST", "/messages/send", json=payload)       # network errors / 429 / 5xx propagate: caller marks the send `unknown`
        return {"zoho_message_id": str(d.get("id", "")), "thread_id": str(d.get("threadId", "") or ""), "threaded": bool(in_reply_to), "rfc_message_id": mid}

    def _headers_of(self, message_id: str) -> dict:
        if message_id not in self._meta:
            d = self._call("GET", f"/messages/{message_id}", params={"format": "metadata", "metadataHeaders": HEADERS})
            h = {x["name"]: x.get("value", "") for x in (d.get("payload", {}).get("headers") or [])}
            self._meta[message_id] = {"headers": h, "time_ms": int(d.get("internalDate") or 0), "thread_id": str(d.get("threadId", "") or ""), "labels": d.get("labelIds") or []}
        return self._meta[message_id]

    def list_messages(self, folder: str, limit: int = 50, start: int = 1) -> list[dict]:
        label = self.folder_id(folder)
        rows = self._call("GET", "/messages", params={"labelIds": label, "maxResults": max(1, min(limit, 100))}).get("messages") or []
        out = []
        for r in rows:
            meta = self._headers_of(r["id"])
            h = meta["headers"]
            out.append({"id": r["id"], "folder_id": label, "subject": h.get("Subject", ""), "from": h.get("From", ""), "to": h.get("To", ""),
                        "time_ms": meta["time_ms"], "thread_id": meta["thread_id"]})
        return out

    def content_text(self, folder_id: str, message_id: str) -> str:
        d = self._call("GET", f"/messages/{message_id}", params={"format": "full"})

        def walk(part, want):
            if part.get("mimeType") == want and (part.get("body") or {}).get("data"):
                return _decode(part["body"]["data"])
            for sub in part.get("parts") or []:
                found = walk(sub, want)
                if found:
                    return found
            return ""
        payload = d.get("payload") or {}
        plain = walk(payload, "text/plain")
        return (plain or html_to_text(walk(payload, "text/html"), limit=20000))[:20000]

    def rfc_headers(self, folder_id: str, message_id: str) -> dict:
        try:
            return dict(self._headers_of(message_id)["headers"])
        except (MailRejected, TransientError):
            return {}                                  # best effort: the Ref token still matches replies

    def find_sent(self, token: str, to_email: str, since_ms: int) -> dict | None:
        """Look in Sent for the message carrying our token: proves whether a send happened (used to settle `unknown` sends)."""
        rows = self._call("GET", "/messages", params={"labelIds": "SENT", "q": f"to:{to_email}", "maxResults": 25}).get("messages") or []
        for r in rows:
            meta = self._headers_of(r["id"])
            if meta["time_ms"] and meta["time_ms"] < since_ms:
                continue
            if token in meta["headers"].get("Subject", "") or token in self.content_text("SENT", r["id"]):
                return {"zoho_message_id": r["id"], "rfc_message_id": meta["headers"].get("Message-ID", "").strip(), "thread_id": meta["thread_id"], "time_ms": meta["time_ms"]}
        return None

    def check(self) -> tuple[bool, str]:
        """Read-only self-test: profile + newest inbox entry. Never sends."""
        prof = self._call("GET", "/profile")
        self._call("GET", "/messages", params={"labelIds": "INBOX", "maxResults": 1})
        return bool(prof.get("emailAddress")), f"signed in as {prof.get('emailAddress', '?')}"
