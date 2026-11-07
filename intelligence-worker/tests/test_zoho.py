import unittest

from kairflow_intel.errors import ThreadingRejected
from kairflow_intel.zoho import ZohoClient, ZohoRejected


class Tokens:
    def get(self, force=False):
        return {"base": "https://mail.zoho.test/api", "account_id": "1234567890", "access_token": "token"}


class ZohoHardening(unittest.TestCase):
    def test_reply_action_rejection_never_falls_back_to_new_message(self):
        client = ZohoClient(Tokens())
        calls = []

        def call(method, path, **kwargs):
            calls.append((method, path, kwargs))
            raise ZohoRejected("zoho 400: reply action unavailable")

        client._call = call
        with self.assertRaises(ThreadingRejected):
            client.send("from@example.test", "to@example.test", "Re: subject", "body", reply_to_zoho_id="123456789")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1], "/messages/123456789")

    def test_malformed_reply_parent_is_rejected_without_send(self):
        client = ZohoClient(Tokens())
        calls = []
        client._call = lambda *a, **k: calls.append((a, k))
        with self.assertRaises(ThreadingRejected):
            client.send("from@example.test", "to@example.test", "Re: subject", "body", reply_to_zoho_id="not-a-zoho-id")
        self.assertEqual(calls, [])

    def test_find_sent_scans_beyond_first_page(self):
        client = ZohoClient(Tokens())
        first = [
            {"id": f"old-{i}", "folder_id": "sent", "subject": "unrelated", "from": "", "to": "to@example.test",
             "time_ms": 2_000_000_000_000 - i, "thread_id": "t"}
            for i in range(100)
        ]
        target = {"id": "target", "folder_id": "sent", "subject": "hello", "from": "", "to": "to@example.test",
                  "time_ms": 2_000_000_000_100, "thread_id": "thread-target"}
        calls = []

        def list_messages(folder, limit=50, start=1):
            calls.append(start)
            if start == 1:
                return first
            if start == 91:
                return first[80:] + [target] + [
                    {"id": f"later-{i}", "folder_id": "sent", "subject": "unrelated", "from": "", "to": "to@example.test",
                     "time_ms": 1_900_000_000_000 - i, "thread_id": "t"}
                    for i in range(79)
                ]
            return []

        client.list_messages = list_messages
        client.content_text = lambda folder, message_id: "kf" + "a" * 32 if message_id == "target" else ""
        client.rfc_headers = lambda folder, message_id: {"Message-ID": "<target@example.test>"}
        found = client.find_sent("kf" + "a" * 32, "to@example.test", 1)
        self.assertEqual(found["zoho_message_id"], "target")
        self.assertEqual(calls[:2], [1, 91])


if __name__ == "__main__":
    unittest.main()
