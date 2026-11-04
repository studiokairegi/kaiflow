import unittest

from kairflow_intel import config as cfgmod
from kairflow_intel import jobs
from kairflow_intel.mail_disabled import DisabledMail


class _D:
    """Just enough of Deps for the three mail handlers while Gmail and Zoho are paused."""
    def __init__(self):
        self.zoho = DisabledMail()
        self.calls = []

    def rpc(self, name, args):
        self.calls.append(name)
        return {"sender_email": "x@y.test"}


class MailPausedTests(unittest.TestCase):
    def test_default_provider_is_none(self):
        self.assertEqual(cfgmod.Config.__dataclass_fields__["mail_provider"].default, "none")

    def test_handlers_skip_without_touching_a_mailbox(self):
        d = _D()
        self.assertEqual(jobs.h_sync_mail(d, {"payload": {}}), {"skipped": "mail provider paused"})
        self.assertEqual(jobs.h_reconcile(d, {"payload": {}}), {"skipped": "mail provider paused"})
        self.assertEqual(jobs.h_send(d, {"payload": {"message_id": "m"}})["reason"], "mail_provider_paused")
        self.assertEqual(d.calls, [])          # no RPC, so nothing was reserved, sent or synced

    def test_disabled_client_check_is_harmless(self):
        ok, detail = DisabledMail().check()
        self.assertTrue(ok)
        self.assertIn("paused", detail)


if __name__ == "__main__":
    unittest.main()
