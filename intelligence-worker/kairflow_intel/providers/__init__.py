"""Installed email-provider adapters for KairFlow Intelligence."""
from .base import ProviderManifest, ProviderNotInstalled
from .registry import ProviderRegistry, build_registry

__all__ = ["ProviderManifest", "ProviderNotInstalled", "ProviderRegistry", "build_registry"]
