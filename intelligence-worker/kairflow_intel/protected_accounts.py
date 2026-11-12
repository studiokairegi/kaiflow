"""Hard exclusions for protected Studio Kairegi prospect accounts.

Name matching is intentionally conservative (normalized exact title/name only) to
avoid suppressing unrelated projects based on incidental mentions in page text.
Database status and outbound-message guards provide the final protected-account and
email/domain suppression checks.
"""
from __future__ import annotations

import re
import unicodedata

PROTECTED_NAMES = frozenset({
    "Brain Jar Games",
    "Brain Jar Games LLC",
    "Brain Jar Games Inc",
    "Silver Line Interactive",
    "Silver Line Interactive Inc",
    "Silver Line Interactive LLC",
    "Thermite Games",
    "Thermite Games LLC",
    "Thermite Games Inc",
    "Lie of Caelum: Spirit",
})


def normalize_name(value: str) -> str:
    value = unicodedata.normalize("NFKC", str(value or "")).casefold()
    return " ".join(re.findall(r"[a-z0-9]+", value))


_PROTECTED_KEYS = frozenset(normalize_name(x) for x in PROTECTED_NAMES)


def match_protected(*values: str) -> str | None:
    """Return the protected canonical name only for an exact normalized match."""
    for value in values:
        key = normalize_name(value)
        if key in _PROTECTED_KEYS:
            return next(name for name in PROTECTED_NAMES if normalize_name(name) == key)
    return None
