from __future__ import annotations

from ..zoho import ZohoClient
from ..provider_tokens import ProviderAccountTokenProvider


def create_zoho_adapter(*, cfg, supa, account_id: str | None = None, session=None):
    """Create an account-scoped Zoho Mail adapter for any connected Zoho mailbox."""
    if not account_id:
        raise ValueError("KAIRFLOW_MAIL_ACCOUNT_ID is required for account-scoped Zoho adapter use")
    tokens = ProviderAccountTokenProvider(cfg, supa, account_id, provider="zoho", session=session)
    client = ZohoClient(tokens, session=session)
    client.account_id = account_id
    return client
