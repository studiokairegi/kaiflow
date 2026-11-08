from __future__ import annotations

from ..gmail import GmailClient
from ..provider_tokens import ProviderAccountTokenProvider


def create_gmail_adapter(*, cfg, supa, account_id: str | None = None, session=None):
    """Create the same Gmail adapter for any connected account.

    account_id selects a row in intel_provider_accounts. The legacy token route
    remains available during the migration window when no account id is set.
    """
    if not account_id:
        raise ValueError("KAIRFLOW_MAIL_ACCOUNT_ID is required for account-scoped Gmail adapter use")
    tokens = ProviderAccountTokenProvider(cfg, supa, account_id, provider="gmail", session=session)
    client = GmailClient(tokens, session=session)
    client.account_id = account_id
    return client
