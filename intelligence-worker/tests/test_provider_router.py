import unittest
from types import SimpleNamespace
from unittest.mock import patch

from kairflow_intel.providers.router import DynamicProviderRouter


class RouterTests(unittest.TestCase):
    def test_legacy_fallback_only_when_both_assignment_fields_are_absent(self):
        fallback = object()
        router = DynamicProviderRouter(SimpleNamespace(), SimpleNamespace(), fallback=fallback)
        self.assertIs(router.for_message({}), fallback)
        with self.assertRaisesRegex(ValueError, "incomplete provider account assignment"):
            router.for_message({"provider_account_id": "account-1"})
        with self.assertRaisesRegex(ValueError, "incomplete provider account assignment"):
            router.for_message({"provider_key": "gmail"})

    def test_no_assignment_without_fallback_fails_closed(self):
        router = DynamicProviderRouter(SimpleNamespace(), SimpleNamespace())
        with self.assertRaisesRegex(ValueError, "no provider account assignment"):
            router.for_message({})


if __name__ == "__main__":
    unittest.main()
