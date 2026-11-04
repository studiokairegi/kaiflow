"""Stand-in mail client used while outbound mail is disabled (KAIRFLOW_MAIL_PROVIDER=none, the default).

Nothing is initialised, no token is requested and no provider is contacted. Gmail and Zoho remain available as optional adapters; Resend is server-side only."""
from __future__ import annotations

REASON = "mail provider paused (KAIRFLOW_MAIL_PROVIDER=none)"


class DisabledMail:
    disabled = True

    def check(self) -> tuple[bool, str]:
        return True, REASON
