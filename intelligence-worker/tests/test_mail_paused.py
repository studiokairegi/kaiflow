import unittest
from unittest.mock import patch

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
        if name == "intel_agent_receive_accounts": return []
        return {"sender_email": "x@y.test"}


class MailPausedTests(unittest.TestCase):
    def test_default_provider_is_none(self):
        self.assertEqual(cfgmod.Config.__dataclass_fields__["mail_provider"].default, "none")

    def test_handlers_skip_without_touching_a_mailbox(self):
        d = _D()
        self.assertEqual(jobs.h_sync_mail(d, {"payload": {}}), {"skipped": "mail provider paused"})
        with patch("kairflow_intel.jobs.mailops.reconcile", return_value={"confirmed": 0, "absent": 0, "left": 1}) as reconcile:
            self.assertEqual(jobs.h_reconcile(d, {"payload": {}}), {"confirmed": 0, "absent": 0, "left": 1})
            reconcile.assert_called_once_with(d.rpc, d.zoho)
        self.assertEqual(jobs.h_send(d, {"payload": {"message_id": "m"}})["reason"], "mail_provider_paused")
        self.assertEqual(d.calls, ["intel_agent_receive_accounts"])  # only the read-only account inventory probe


    def test_registry_accounts_sync_even_when_legacy_fallback_is_disabled(self):
        d = _D()
        d.rpc = lambda name, args: ([{"id": "acct", "provider_key": "gmail", "mailbox": "a@studio.test", "receive_enabled": True}]
                                   if name == "intel_agent_receive_accounts" else {"sender_email": "x@y.test"})
        with patch("kairflow_intel.jobs.mailops.sync_provider_accounts", return_value={"accounts": 1, "seen": 2, "new": 1}) as sync:
            self.assertEqual(jobs.h_sync_mail(d, {"payload": {}}), {"accounts": 1, "seen": 2, "new": 1})
            sync.assert_called_once()

    def test_smtp_sync_is_explicitly_skipped_as_send_only(self):
        class SmtpRouter:
            provider = "smtp"
            disabled = False
        d = _D(); d.zoho = SmtpRouter()
        self.assertEqual(jobs.h_sync_mail(d, {"payload": {}}),
                         {"skipped": "SMTP is send-only; connect Gmail or Zoho Mail to synchronize inbound replies"})
        self.assertEqual(d.calls, ["intel_agent_receive_accounts"])

    def test_disabled_client_check_is_harmless(self):
        ok, detail = DisabledMail().check()
        self.assertTrue(ok)
        self.assertIn("paused", detail)


if __name__ == "__main__":
    unittest.main()
