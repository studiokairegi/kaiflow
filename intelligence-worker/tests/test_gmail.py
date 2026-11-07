import base64
import unittest
from email import message_from_bytes

from kairflow_intel import gmail, mailops
from kairflow_intel.errors import MailRejected, PermanentError, TransientError
from .test_ops import FakeRpc, FakeZoho


class Tok:
    def __init__(self, mailbox="studio@gmail.com"): self.mailbox = mailbox
    def get(self, force=False): return {"access_token": "A", "base": "https://gmail.test/gmail/v1", "account_id": "me", "mailbox": self.mailbox}


class Resp:
    def __init__(self, code=200, body=None): self.status_code, self._b, self.text = code, body if body is not None else {}, str(body)
    def json(self): return self._b


class Sess:
    """Scripted HTTP session: routes by (method, path suffix)."""
    def __init__(self, routes): self.routes, self.calls = routes, []
    def request(self, method, url, params=None, json=None, **kw):
        self.calls.append((method, url, params, json))
        for (m, suffix), r in self.routes.items():
            if m == method and url.endswith(suffix):
                if isinstance(r, Exception): raise r
                return r(json, params) if callable(r) else r
        return Resp(404, {"error": "no route"})


def decode_raw(raw): return message_from_bytes(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))


class Mime(unittest.TestCase):
    def test_threading_headers_and_generated_message_id(self):
        msg, mid = gmail.build_mime("studio@gmail.com", "dev@pixel.com", "Re: Hello", "Body", "<a@x>", "<z@x> <a@x>")
        self.assertEqual((msg["In-Reply-To"], msg["References"], msg["Message-ID"]), ("<a@x>", "<z@x> <a@x>", mid))
        self.assertTrue(mid.startswith("<") and mid.endswith("@gmail.com>"))

    def test_references_always_end_with_the_parent_and_are_bounded(self):
        msg, _ = gmail.build_mime("s@g.com", "d@p.com", "Re: x", "b", "<p@x>", " ".join(f"<r{i}@x>" for i in range(60)))
        refs = msg["References"].split(); self.assertEqual(refs[-1], "<p@x>"); self.assertLessEqual(len(refs), 21)

    def test_malformed_parent_ids_are_dropped_not_injected(self):
        msg, _ = gmail.build_mime("s@g.com", "d@p.com", "x", "b", "<a@x>\r\nBcc: evil@x.com", None)
        self.assertIsNone(msg["In-Reply-To"]); self.assertIsNone(msg["Bcc"])

    def test_line_breaks_in_subject_or_address_are_refused(self):
        for args in (("s@g.com", "d@p.com\r\nBcc: e@x.com", "x"), ("s@g.com", "d@p.com", "Hi\nBcc: e@x.com")):
            with self.assertRaises(MailRejected): gmail.build_mime(*args, "b")


class Client(unittest.TestCase):
    def client(self, routes, mailbox="studio@gmail.com"): return gmail.GmailClient(Tok(mailbox), Sess(routes)), None

    def test_send_posts_a_raw_message_with_thread_and_returns_our_message_id(self):
        sent = {}
        routes = {("GET", "/messages/18c0ffee12345678"): Resp(200, {"threadId": "T9"}),
                  ("POST", "/messages/send"): lambda j, p: (sent.update(j), Resp(200, {"id": "G1", "threadId": "T9"}))[1]}
        c = gmail.GmailClient(Tok(), Sess(routes))
        out = c.send("studio@gmail.com", "dev@pixel.com", "Re: Hi", "Body", reply_to_zoho_id="18c0ffee12345678", in_reply_to="<a@x>", references="<a@x>")
        self.assertEqual((out["zoho_message_id"], out["thread_id"], out["threaded"]), ("G1", "T9", True)); self.assertTrue(out["rfc_message_id"].startswith("<"))
        self.assertEqual(sent["threadId"], "T9"); m = decode_raw(sent["raw"]); self.assertEqual(m["In-Reply-To"], "<a@x>"); self.assertEqual(m["Message-ID"], out["rfc_message_id"])

    def test_sender_must_equal_the_connected_mailbox_and_nothing_is_sent_otherwise(self):
        s = Sess({}); c = gmail.GmailClient(Tok("studio@gmail.com"), s)
        with self.assertRaises(MailRejected): c.send("someone.else@gmail.com", "d@p.com", "x", "b")
        self.assertEqual(s.calls, [])

    def test_uncertain_outcomes_are_never_swallowed(self):
        import requests
        for r in (requests.ConnectionError("down"), Resp(429), Resp(503)):
            c = gmail.GmailClient(Tok(), Sess({("POST", "/messages/send"): r}))
            with self.assertRaises(TransientError): c.send("studio@gmail.com", "d@p.com", "x", "b")

    def test_a_4xx_is_a_definitive_rejection(self):
        c = gmail.GmailClient(Tok(), Sess({("POST", "/messages/send"): Resp(400, {"error": "Invalid To header"})}))
        with self.assertRaises(MailRejected): c.send("studio@gmail.com", "d@p.com", "x", "b")

    def test_thread_lookup_failure_still_sends_threaded_by_headers(self):
        c = gmail.GmailClient(Tok(), Sess({("GET", "/messages/18c0ffee12345678"): Resp(404), ("POST", "/messages/send"): Resp(200, {"id": "G2", "threadId": "T"})}))
        self.assertEqual(c.send("studio@gmail.com", "d@p.com", "Re: x", "b", reply_to_zoho_id="18c0ffee12345678", in_reply_to="<a@x>")["zoho_message_id"], "G2")


    def test_find_sent_searches_multiple_pages(self):
        token = "kf" + "a" * 32
        def list_page(_json, params):
            if params.get("pageToken") == "next":
                return Resp(200, {"messages": [{"id": "match"}]})
            return Resp(200, {"messages": [{"id": "other"}], "nextPageToken": "next"})
        routes = {
            ("GET", "/messages"): list_page,
            ("GET", "/messages/other"): Resp(200, {"payload": {"headers": [{"name": "Subject", "value": "not a match"}]}, "internalDate": "1760000000000", "threadId": "t1"}),
            ("GET", "/messages/match"): Resp(200, {"payload": {"headers": [{"name": "Subject", "value": "Ref " + token}, {"name": "Message-ID", "value": "<m@x>"}]}, "internalDate": "1760000000000", "threadId": "t2"}),
        }
        c = gmail.GmailClient(Tok(), Sess(routes))
        found = c.find_sent(token, "to@x.test", 0)
        self.assertEqual(found["zoho_message_id"], "match")
        self.assertEqual(found["thread_id"], "t2")

    def test_listing_reading_and_headers(self):
        html = base64.urlsafe_b64encode(b"<p>Hello <b>there</b></p>").decode()
        plain = base64.urlsafe_b64encode(b"Sure, send pricing. Ref: kf" + b"a" * 32).decode()
        meta = {"threadId": "T1", "internalDate": "1790000000000", "payload": {"headers": [{"name": "From", "value": "Dev <dev@pixel.com>"}, {"name": "Subject", "value": "Re: Hi"},
                {"name": "Message-ID", "value": "<m1@pixel.com>"}, {"name": "In-Reply-To", "value": "<a@x>"}]}}
        full = {"payload": {"mimeType": "multipart/alternative", "parts": [{"mimeType": "text/html", "body": {"data": html}}, {"mimeType": "text/plain", "body": {"data": plain}}]}}
        s = Sess({("GET", "/messages"): Resp(200, {"messages": [{"id": "m1"}]}), ("GET", "/messages/m1"): lambda j, p: Resp(200, full if p.get("format") == "full" else meta)})
        c = gmail.GmailClient(Tok(), s)
        rows = c.list_messages("inbox"); self.assertEqual((rows[0]["id"], rows[0]["time_ms"], rows[0]["thread_id"], rows[0]["subject"]), ("m1", 1790000000000, "T1", "Re: Hi"))
        self.assertIn("send pricing", c.content_text("INBOX", "m1")); self.assertIn("kf" + "a" * 32, c.content_text("INBOX", "m1"))
        self.assertEqual(c.rfc_headers("INBOX", "m1")["In-Reply-To"], "<a@x>")
        n = len(s.calls); c.rfc_headers("INBOX", "m1"); self.assertEqual(len(s.calls), n, "headers are cached")

    def test_html_only_mail_is_converted_to_text(self):
        html = base64.urlsafe_b64encode(b"<p>Hello <b>there</b></p>").decode()
        c = gmail.GmailClient(Tok(), Sess({("GET", "/messages/h1"): Resp(200, {"payload": {"mimeType": "text/html", "body": {"data": html}}})}))
        self.assertIn("Hello", c.content_text("INBOX", "h1")); self.assertNotIn("<p>", c.content_text("INBOX", "h1"))

    def test_find_sent_matches_our_token_and_honours_the_time_window(self):
        tok = "kf" + "b" * 32
        body = base64.urlsafe_b64encode(f"Hi\n\nRef: {tok}".encode()).decode()
        meta = lambda t: {"threadId": "T", "internalDate": str(t), "payload": {"headers": [{"name": "Subject", "value": "Hi"}, {"name": "Message-ID", "value": "<s1@gmail.com>"}]}}
        routes = {("GET", "/messages"): Resp(200, {"messages": [{"id": "s1"}]}), ("GET", "/messages/s1"): lambda j, p: Resp(200, {"payload": {"mimeType": "text/plain", "body": {"data": body}}} if p["format"] == "full" else meta(2_000))}
        found = gmail.GmailClient(Tok(), Sess(routes)).find_sent(tok, "d@p.com", 1_000)
        self.assertEqual((found["zoho_message_id"], found["rfc_message_id"]), ("s1", "<s1@gmail.com>"))
        self.assertIsNone(gmail.GmailClient(Tok(), Sess(routes)).find_sent(tok, "d@p.com", 5_000))
        self.assertIsNone(gmail.GmailClient(Tok(), Sess(routes)).find_sent("kf" + "c" * 32, "d@p.com", 1_000))

    def test_unknown_folder_is_refused(self):
        with self.assertRaises(PermanentError): gmail.GmailClient(Tok(), Sess({})).folder_id("trash")


class SendPath(unittest.TestCase):
    def test_gmail_message_id_is_stored_without_searching_sent(self):
        r, z = FakeRpc(), FakeZoho(); r.add("m1")
        orig = z.send
        z.send = lambda *a, **k: {**orig(*a, **k), "rfc_message_id": "<ours@gmail.com>"}
        z.find_sent = lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not search Sent when the Message-ID is already known"))
        self.assertEqual(mailops.send_message(r, z, "m1")["reason"], "ok")
        self.assertEqual(z.headers, [(None, None)])


if __name__ == "__main__":
    unittest.main()
