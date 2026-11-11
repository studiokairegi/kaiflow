import unittest

from kairflow_intel import mailops


def _router(clients):
    class Registry:
        def create(self, key, **ctx):
            c = clients[ctx["account_id"]]
            if isinstance(c, Exception):
                raise c
            return c
    class Router:
        cfg = object(); supa = object(); registry = Registry()
    return Router()


class Rpc:
    def __init__(self): self.inbound = []; self.cursors = {}
    def __call__(self, name, params=None):
        params = params or {}
        if name == "intel_agent_receive_sync_state":
            if params.get("p_set") is not None: self.cursors[params["p_account_id"]] = params["p_set"]
            return self.cursors.get(params["p_account_id"], {})
        if name == "intel_agent_record_inbound":
            self.inbound.append(params); return {"message_id": f"m{len(self.inbound)}", "duplicate": False}
        return None


class Provider:
    def __init__(self, items): self.items = items; self.yielded = 0
    def iter_messages(self, folder, page_size=50):
        for i in self.items:
            self.yielded += 1
            yield i
    def content_text(self, *_): return "hi"
    def rfc_headers(self, *_): return {}


def item(i, sender="rina@x.com", t=1_700_000_000_000):
    return {"id": i, "folder_id": "inbox", "subject": "Re", "from": sender, "to": "", "time_ms": t, "thread_id": "t"}


class MultiAccountSync(unittest.TestCase):
    def test_failing_account_does_not_starve_the_others(self):
        good = Provider([item("1")])
        rpc = Rpc()
        accounts = [{"id": "bad", "provider_key": "gmail", "mailbox": "a@s.test", "receive_enabled": True},
                    {"id": "good", "provider_key": "zoho", "mailbox": "b@s.test", "receive_enabled": True}]
        with self.assertRaises(RuntimeError):
            mailops.sync_provider_accounts(rpc, _router({"bad": RuntimeError("revoked"), "good": good}), set(), overlap_ms=0, accounts=accounts, initial_lookback_ms=None)
        self.assertEqual([x["p_zoho_message_id"] for x in rpc.inbound], ["in:zoho:good:1"])
        self.assertIn("good", rpc.cursors)
        self.assertNotIn("bad", rpc.cursors)

    def test_mail_from_another_connected_mailbox_is_internal(self):
        p = Provider([item("1", sender="Studio B <b@s.test>"), item("2")])
        rpc = Rpc()
        accounts = [{"id": "a", "provider_key": "gmail", "mailbox": "a@s.test", "receive_enabled": True},
                    {"id": "b", "provider_key": "zoho", "mailbox": "b@s.test", "receive_enabled": True}]
        mailops.sync_provider_accounts(rpc, _router({"a": p, "b": Provider([])}), set(), overlap_ms=0, accounts=accounts, initial_lookback_ms=None)
        self.assertEqual([x["p_from_email"] for x in rpc.inbound], ["rina@x.com"])

    def test_scan_stops_after_a_page_of_messages_older_than_the_cursor(self):
        rpc = Rpc(); rpc.cursors["a"] = {"last_time_ms": 2_000_000_000_000}
        old = [item(str(i), t=1_000_000_000_000) for i in range(500)]
        p = Provider([item("new", t=2_000_000_000_100)] + old)
        mailops.sync_provider_accounts(rpc, _router({"a": p}), set(), overlap_ms=0, limit=50,
                                       accounts=[{"id": "a", "provider_key": "gmail", "mailbox": "a@s.test", "receive_enabled": True}])
        self.assertEqual(len(rpc.inbound), 1)
        self.assertLessEqual(p.yielded, 51)

    def test_new_account_reads_only_the_recent_window(self):
        now = 2_000_000_000_000
        day = 86_400_000
        p = Provider([item("recent", t=now - 2 * day), item("old", t=now - 90 * day)])
        rpc = Rpc()
        mailops.sync_provider_accounts(rpc, _router({"a": p}), set(), overlap_ms=0, now_ms=lambda: now,
                                       accounts=[{"id": "a", "provider_key": "gmail", "mailbox": "a@s.test", "receive_enabled": True}])
        self.assertEqual([x["p_zoho_message_id"] for x in rpc.inbound], ["in:gmail:a:recent"])
        self.assertEqual(rpc.cursors["a"], {"last_time_ms": now - 2 * day})


if __name__ == "__main__":
    unittest.main()
