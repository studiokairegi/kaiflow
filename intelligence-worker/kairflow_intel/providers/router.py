from __future__ import annotations

from .registry import build_registry


class DynamicProviderRouter:
    """Resolve an installed adapter from the account durably assigned to a message."""
    def __init__(self, cfg, supa, fallback=None):
        self.cfg, self.supa, self.fallback = cfg, supa, fallback
        self.registry = build_registry()

    def for_message(self, message: dict):
        account_id = message.get("provider_account_id")
        provider_key = message.get("provider_key")
        # Legacy routing is valid only when the message has no account assignment at all.
        # A half-populated assignment is corruption and must fail closed, never fall back.
        if account_id is None and provider_key is None:
            if self.fallback is None:
                raise ValueError("message has no provider account assignment")
            return self.fallback
        if not account_id or not provider_key:
            raise ValueError("incomplete provider account assignment; refusing legacy fallback")
        return self.registry.create(provider_key, cfg=self.cfg, supa=self.supa, account_id=str(account_id))

    # Non-message mailbox jobs continue using the configured legacy/default adapter.
    def __getattr__(self, name):
        if self.fallback is None:
            raise AttributeError(name)
        return getattr(self.fallback, name)
