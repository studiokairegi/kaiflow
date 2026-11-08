from __future__ import annotations

from dataclasses import dataclass
from typing import FrozenSet, Protocol


@dataclass(frozen=True)
class ProviderManifest:
    """Public, non-secret description of an installed adapter."""
    provider_key: str
    display_name: str
    adapter_version: str
    capabilities: FrozenSet[str]
    auth_methods: FrozenSet[str]
    message_purposes: FrozenSet[str]
    supports_multiple_accounts: bool = True
    account_selection_required: bool = False


class AdapterFactory(Protocol):
    def __call__(self, **context): ...


@dataclass(frozen=True)
class ProviderRegistration:
    manifest: ProviderManifest
    factory: AdapterFactory


class ProviderNotInstalled(LookupError):
    pass
