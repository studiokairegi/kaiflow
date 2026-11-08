"""Account-scoped SMTP submission adapter. SMTP is send-only; IMAP is a later stage."""
from __future__ import annotations

import smtplib
import ssl
import ipaddress
import socket
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

from ..errors import MailRejected, PermanentError, TransientError


def _validate_public_host(host: str, port: int = 0) -> tuple[str, ...]:
    """Resolve once and return the exact public addresses used for the connection.

    Every returned address must be globally routable. Callers using the built-in
    SMTP transport connect to one of these IPs directly, avoiding a second DNS lookup.
    """
    try:
        rows = socket.getaddrinfo(host, port or None, type=socket.SOCK_STREAM)
        addresses = tuple(dict.fromkeys(ipaddress.ip_address(row[4][0]).compressed for row in rows))
    except (OSError, ValueError) as exc:
        raise TransientError("SMTP hostname could not be resolved") from exc
    if not addresses or any(not ipaddress.ip_address(value).is_global for value in addresses):
        raise MailRejected("SMTP host must resolve only to public IP addresses")
    return addresses


class _PinnedSMTP(smtplib.SMTP):
    def __init__(self, host, port, *, pinned_ip, **kwargs):
        self._pinned_ip = pinned_ip
        super().__init__(host, port, **kwargs)

    def _get_socket(self, host, port, timeout):
        sock = socket.create_connection((self._pinned_ip, port), timeout)
        return sock


class _PinnedSMTPSSL(smtplib.SMTP_SSL):
    def __init__(self, host, port, *, pinned_ip, **kwargs):
        self._pinned_ip = pinned_ip
        super().__init__(host, port, **kwargs)

    def _get_socket(self, host, port, timeout):
        raw = socket.create_connection((self._pinned_ip, port), timeout)
        return self.context.wrap_socket(raw, server_hostname=self._host)


class SMTPClient:
    provider = "smtp"

    def __init__(self, tokens, *, session=None, smtp_factory=None):
        self.tokens = tokens
        self.smtp_factory = smtp_factory

    def send(self, from_addr, to_addr, subject, body, *, reply_to_zoho_id=None, in_reply_to=None, references=None):
        if any(c in (str(from_addr) + str(to_addr) + str(subject)) for c in "\r\n"):
            raise MailRejected("header injection attempt")
        creds = self.tokens.get()
        mailbox = str(creds.get("mailbox") or "").lower()
        if mailbox and str(from_addr).strip().lower() != mailbox:
            raise MailRejected("Sender address must equal the authenticated SMTP mailbox")
        msg = EmailMessage()
        mid = make_msgid(domain=mailbox.rsplit("@", 1)[-1] if "@" in mailbox else None)
        msg["From"], msg["To"], msg["Subject"] = from_addr, to_addr, subject
        msg["Date"], msg["Message-ID"] = formatdate(localtime=False), mid
        if in_reply_to:
            if not (in_reply_to.startswith("<") and in_reply_to.endswith(">") and "\n" not in in_reply_to):
                raise MailRejected("Invalid In-Reply-To header")
            msg["In-Reply-To"] = in_reply_to
            refs = " ".join(references.split()[-20:]) if references else ""
            msg["References"] = refs if in_reply_to in refs else (refs + " " + in_reply_to).strip()
        msg.set_content(body, subtype="plain", charset="utf-8")
        host, port = creds["host"], int(creds["port"])
        addresses = _validate_public_host(host, port)
        mode = creds["tls_mode"]
        factory = self.smtp_factory or _PinnedSMTP
        try:
            if mode == "ssl":
                ssl_factory = self.smtp_factory or _PinnedSMTPSSL
                kwargs = {"timeout": 25, "context": ssl.create_default_context()}
                if self.smtp_factory is None: kwargs["pinned_ip"] = addresses[0]
                smtp = ssl_factory(host, port, **kwargs)
            elif mode == "starttls":
                kwargs = {"timeout": 25}
                if self.smtp_factory is None: kwargs["pinned_ip"] = addresses[0]
                smtp = factory(host, port, **kwargs)
                smtp.ehlo()
                smtp.starttls(context=ssl.create_default_context())
                smtp.ehlo()
            else:
                raise MailRejected("SMTP requires implicit TLS or STARTTLS")
            with smtp:
                smtp.login(creds["username"], creds["password"])
                refused = smtp.send_message(msg, from_addr=from_addr, to_addrs=[to_addr])
                if refused:
                    raise MailRejected("SMTP server refused recipient")
        except MailRejected:
            raise
        except (smtplib.SMTPAuthenticationError, smtplib.SMTPRecipientsRefused, smtplib.SMTPSenderRefused, smtplib.SMTPDataError) as exc:
            raise MailRejected(f"SMTP rejected message ({type(exc).__name__})") from exc
        except (OSError, smtplib.SMTPException, TimeoutError) as exc:
            # Connection loss after DATA may mean accepted: caller marks outcome unknown.
            raise TransientError(f"SMTP outcome uncertain ({type(exc).__name__})") from exc
        return {"zoho_message_id": mid, "thread_id": "", "threaded": bool(in_reply_to), "rfc_message_id": mid}

    def check(self):
        creds = self.tokens.get()
        try:
            addresses = _validate_public_host(creds["host"], int(creds["port"]))
            factory = self.smtp_factory or (_PinnedSMTPSSL if creds["tls_mode"] == "ssl" else _PinnedSMTP)
            kwargs = {"timeout": 15}
            if self.smtp_factory is None: kwargs["pinned_ip"] = addresses[0]
            if creds["tls_mode"] == "ssl": kwargs["context"] = ssl.create_default_context()
            with factory(creds["host"], int(creds["port"]), **kwargs) as smtp:
                smtp.ehlo()
                if creds["tls_mode"] == "starttls":
                    smtp.starttls(context=ssl.create_default_context()); smtp.ehlo()
                smtp.login(creds["username"], creds["password"])
            return True, "SMTP authentication and TLS handshake succeeded; no email was sent"
        except Exception as exc:
            return False, f"SMTP connection test failed ({type(exc).__name__})"


def create_smtp_adapter(*, cfg, supa, account_id: str | None = None, session=None):
    if not account_id:
        raise ValueError("account_id is required for SMTP adapter")
    from ..provider_tokens import ProviderAccountTokenProvider
    tokens = ProviderAccountTokenProvider(cfg, supa, account_id, provider="smtp", session=session)
    client = SMTPClient(tokens)
    client.account_id = account_id
    return client
