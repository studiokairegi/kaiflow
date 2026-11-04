"""Stand-in mail client used while Gmail and Zoho are paused (KAIRFLOW_MAIL_PROVIDER=none, the default).

Nothing is initialised, no token is requested and no mailbox is contacted. The Gmail and Zoho client code is untouched and
comes back by setting KAIRFLOW_MAIL_PROVIDER=gmail or zoho (and turning the flag back on in public.email_provider_flags)."""
from __future__ import annotations

REASON = "mail provider paused: email runs through Resend (KAIRFLOW_MAIL_PROVIDER=none)"


class DisabledMail:
    disabled = True

    def check(self) -> tuple[bool, str]:
        return True, REASON
