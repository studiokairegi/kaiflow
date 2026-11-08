import unittest
from unittest.mock import patch
from types import SimpleNamespace

from kairflow_intel.providers.smtp import SMTPClient, create_smtp_adapter
from kairflow_intel.errors import MailRejected


class Tokens:
    def get(self):
        return {"host":"smtp.example.com", "port":587, "username":"user@example.com", "password":"secret",
                "tls_mode":"starttls", "mailbox":"user@example.com"}


class FakeSMTP:
    instances = []
    def __init__(self, *args, **kwargs): self.args=args; self.kwargs=kwargs; self.sent=None; self.started=False; FakeSMTP.instances.append(self)
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def ehlo(self): return 250, b"ok"
    def starttls(self, **kwargs): self.started=True
    def login(self, user, password): self.login_args=(user,password)
    def send_message(self, msg, **kwargs): self.sent=(msg,kwargs); return {}


class SMTPAdapterTests(unittest.TestCase):
    def setUp(self): FakeSMTP.instances=[]

    @patch("kairflow_intel.providers.smtp._validate_public_host")
    def test_send_uses_starttls_and_returns_rfc_message_id(self, validate):
        client=SMTPClient(Tokens(), smtp_factory=FakeSMTP)
        result=client.send("user@example.com", "to@example.net", "Subject", "Body", in_reply_to="<parent@example.net>")
        self.assertTrue(FakeSMTP.instances[0].started)
        self.assertEqual(FakeSMTP.instances[0].login_args, ("user@example.com", "secret"))
        self.assertEqual(FakeSMTP.instances[0].sent[0]["In-Reply-To"], "<parent@example.net>")
        self.assertEqual(result["zoho_message_id"], result["rfc_message_id"])
        validate.assert_called_once_with("smtp.example.com", 587)

    def test_sender_must_match_authenticated_mailbox(self):
        with self.assertRaises(MailRejected):
            SMTPClient(Tokens()).send("spoof@example.com", "to@example.net", "S", "B")

    def test_header_injection_is_rejected_before_network(self):
        with self.assertRaises(MailRejected):
            SMTPClient(Tokens()).send("user@example.com", "to@example.net", "Hi\r\nBcc:evil@example.net", "B")

    @patch("kairflow_intel.providers.smtp.socket.getaddrinfo")
    def test_private_host_resolution_is_rejected(self, resolve):
        resolve.return_value=[(2,1,6,"",("127.0.0.1",0))]
        from kairflow_intel.providers.smtp import _validate_public_host
        with self.assertRaises(MailRejected): _validate_public_host("localhost", 587)

    @patch("kairflow_intel.providers.smtp.socket.getaddrinfo")
    def test_public_host_returns_pinned_address_set(self, resolve):
        resolve.return_value=[(2,1,6,"",("93.184.216.34",587))]
        from kairflow_intel.providers.smtp import _validate_public_host
        self.assertEqual(_validate_public_host("smtp.example.com",587), ("93.184.216.34",))
        resolve.assert_called_once_with("smtp.example.com",587,type=__import__("socket").SOCK_STREAM)

    @patch("kairflow_intel.providers.smtp.socket.create_connection")
    def test_pinned_smtp_transport_does_not_resolve_hostname_again(self, connect):
        from kairflow_intel.providers.smtp import _PinnedSMTP
        sock=object(); connect.return_value=sock
        client=object.__new__(_PinnedSMTP); client._pinned_ip="93.184.216.34"
        result=client._get_socket(("smtp.example.com",587),587,10)
        self.assertIs(result,sock)
        connect.assert_called_once_with(("93.184.216.34",587),10)

    def test_smtp_uncertain_reconciliation_never_calls_find_sent_or_retries(self):
        from kairflow_intel.mailops import reconcile
        class Provider:
            provider = "smtp"
            def find_sent(self, *args): raise AssertionError("SMTP must not pretend to have a Sent API")
        calls=[]
        def rpc(name, args):
            calls.append((name,args))
            if name == "intel_agent_stale_sends":
                return [{"id":"m1", "provider_key":"smtp", "provider_account_id":"a1", "token":"t",
                         "to_email":"to@example.net", "reserved_at":"2026-11-08T10:00:00+00:00"}]
            return {"ok":True}
        class Router:
            def for_message(self, message): return Provider()
        result=reconcile(rpc, Router())
        self.assertEqual(result, {"confirmed":0,"absent":0,"left":1})
        self.assertTrue(any(name == "intel_agent_mark_unknown" for name,_ in calls))
        self.assertFalse(any(name == "intel_agent_fail_send" for name,_ in calls))

    def test_factory_is_account_scoped(self):
        cfg=SimpleNamespace(supabase_url="https://example.supabase.co", supabase_anon_key="anon")
        supa=SimpleNamespace(token=lambda:"jwt")
        client=create_smtp_adapter(cfg=cfg, supa=supa, account_id="11111111-1111-4111-8111-111111111111")
        self.assertEqual(client.provider, "smtp")
        self.assertEqual(client.account_id, "11111111-1111-4111-8111-111111111111")


if __name__ == "__main__": unittest.main()
