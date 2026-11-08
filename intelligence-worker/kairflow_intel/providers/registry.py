from __future__ import annotations

from .base import ProviderManifest, ProviderNotInstalled, ProviderRegistration


class ProviderRegistry:
    """Runtime registry of adapter code installed in this worker.

    The database catalogue controls which installed adapters may be connected;
    it cannot upload or execute code. Adding a provider requires a reviewed
    adapter registration, while adding another account requires no code change.
    """
    def __init__(self):
        self._providers: dict[str, ProviderRegistration] = {}

    def register(self, manifest: ProviderManifest, factory) -> None:
        key = manifest.provider_key.strip().lower()
        if not key or key != manifest.provider_key or not key.replace("-", "").replace("_", "").isalnum():
            raise ValueError("provider_key must be a normalized identifier")
        if key in self._providers:
            raise ValueError(f"provider adapter already registered: {key}")
        self._providers[key] = ProviderRegistration(manifest, factory)

    def manifest(self, provider_key: str) -> ProviderManifest:
        try:
            return self._providers[provider_key.strip().lower()].manifest
        except KeyError as exc:
            raise ProviderNotInstalled(f"provider adapter is not installed: {provider_key}") from exc

    def create(self, provider_key: str, **context):
        try:
            registration = self._providers[provider_key.strip().lower()]
        except KeyError as exc:
            raise ProviderNotInstalled(f"provider adapter is not installed: {provider_key}") from exc
        return registration.factory(**context)

    def manifests(self) -> tuple[ProviderManifest, ...]:
        return tuple(x.manifest for x in self._providers.values())

    def keys(self) -> tuple[str, ...]:
        return tuple(self._providers)


def build_registry() -> ProviderRegistry:
    """Build the code-installed adapter registry.

    Resend is deliberately absent: this registry is for prospect communication.
    Its transactional integration will be registered in a separate route later.
    """
    from .gmail import create_gmail_adapter
    from .zoho import create_zoho_adapter
    from .smtp import create_smtp_adapter

    registry = ProviderRegistry()
    registry.register(ProviderManifest(
        provider_key="gmail", display_name="Gmail", adapter_version="1.0.0",
        capabilities=frozenset({"send", "receive", "threading", "sent-reconciliation", "connection-test"}),
        auth_methods=frozenset({"oauth2"}),
        message_purposes=frozenset({"business_correspondence", "consented_prospecting"}),
        supports_multiple_accounts=True, account_selection_required=True,
    ), create_gmail_adapter)
    registry.register(ProviderManifest(
        provider_key="zoho", display_name="Zoho Mail", adapter_version="1.0.0",
        capabilities=frozenset({"send", "receive", "threading", "sent-reconciliation", "connection-test"}),
        auth_methods=frozenset({"oauth2"}),
        # Zoho prospecting is permitted only through the mandatory human-approval
        # gate enforced by the database before account assignment and final send.
        message_purposes=frozenset({"business_correspondence", "consented_prospecting"}),
        supports_multiple_accounts=True, account_selection_required=True,
    ), create_zoho_adapter)
    registry.register(ProviderManifest(
        provider_key="smtp", display_name="SMTP", adapter_version="1.0.0",
        capabilities=frozenset({"send", "connection-test", "rfc-message-id"}),
        auth_methods=frozenset({"smtp_password"}),
        message_purposes=frozenset({"business_correspondence", "consented_prospecting"}),
        supports_multiple_accounts=True, account_selection_required=True,
    ), create_smtp_adapter)
    return registry
