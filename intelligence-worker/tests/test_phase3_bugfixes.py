"""Regression tests for the Phase 3 review findings (quote stripping, body-aware guard, grounding, language routing,
takeover vetting, salutations)."""
import json
import unittest
from unittest.mock import patch

from kairflow_intel import classify, drafting, jobs, policy, takeover
from kairflow_intel.errors import PermanentError
from .test_phase3_japanese import EVIDENCE, KB, KB_ROWS, PROSPECT, SETTINGS, writer_for
from .test_takeover import OUT1, Llm, Rpc, ctx, entry, run

FOOTER = policy.compliance_footer(SETTINGS, opt_out_text=KB["policy.opt_out.ja"]["body"])
OUR_MAIL = "ご担当者様\n\n突然のご連絡失礼いたします。" + FOOTER
GOOD = "青空アニメーションがテレビアニメの制作実績を公開し、原画と動画を担当されていることを拝見しました。"
APPROVED = "弊スタジオは2Dアニメーションの制作スタジオで、レイアウト、原画、動画、仕上げの制作協力に対応しています。"
NO_CONTACT = {**PROSPECT, "contact_name": ""}


def compose(body, prospect=NO_CONTACT, subject="制作協力のご提案｜青空アニメーション"):
    return drafting.compose_japanese(prospect, EVIDENCE, KB, SETTINGS, writer_for(body, subject=subject), kind="initial")


class QuotedJapaneseHistory(unittest.TestCase):
    def test_outlook_ja_quote_with_our_footer_is_not_an_unsubscribe(self):
        body = ("ポートフォリオを送っていただけますか。\n\n-----元のメッセージ-----\n差出人: Alex <alex@studiokairegi.com>\n"
                "送信日時: 2026年11月8日 10:00\n件名: ご提案\n\n" + OUR_MAIL)
        r = classify.classify({"subject": "Re: ご提案", "body_text": body, "from_email": "h@aozora.example"}, set(), None)
        self.assertEqual(r["class"], "portfolio_request")

    def test_apple_and_gmail_ja_attribution_lines_end_the_new_text(self):
        for attribution in ("佐藤花子さんは書きました:", "2026年11月8日(日) 10:00 Alex <alex@studiokairegi.com>:"):
            with self.subTest(attribution=attribution):
                self.assertNotIn("unsubscribe", policy.scan_inbound("Re: x", "了解しました。\n\n" + attribution + "\n" + OUR_MAIL)["hits"])

    def test_a_genuine_japanese_opt_out_above_the_quote_still_suppresses(self):
        body = "今後のご案内は不要です。\n\n-----元のメッセージ-----\n差出人: Alex\n\n" + OUR_MAIL
        self.assertEqual(classify.classify({"subject": "Re: x", "body_text": body, "from_email": "h@a.example"}, set(), None)["class"], "unsubscribe")


class ConsequentialBody(unittest.TestCase):
    def test_body_only_requests_are_consequential(self):
        for text in ("価格を教えてください。", "単価はいくらですか。", "請求書を送付してください。", "クレームです。対応が不誠実でした。",
                     "保証してもらえますか。", "稼働できる人数を教えてください。"):
            with self.subTest(text=text):
                self.assertTrue(drafting._is_consequential_japanese_inbound({"id": "m", "subject": "Re: アニメーション制作協力のご提案", "body": text}))

    def test_portfolio_request_is_not_consequential(self):
        self.assertFalse(drafting._is_consequential_japanese_inbound({"id": "m", "subject": "Re: ご提案", "body": "ポートフォリオをお送りください。"}))


class Grounding(unittest.TestCase):
    def test_invented_claims_are_rejected(self):
        for claim in ("貴社の制作現場では若手育成に力を入れていらっしゃるとお見受けしました。",
                      "貴社がテレビアニメの原画で高い評価を得ていることも存じております。",
                      "新作の制作が順調だとお聞きしました。", "近年は制作スタッフを増員されているとも伺っております。"):
            with self.subTest(claim=claim), self.assertRaises(PermanentError):
                compose(f"ご担当者様\n\n{GOOD}{APPROVED}{claim}")

    def test_ordinary_courtesy_openers_and_closers_are_accepted(self):
        for opener in ("突然のご連絡失礼いたします。", "初めてご連絡いたします。", "ご多忙のところ恐れ入ります。"):
            with self.subTest(opener=opener):
                compose(f"ご担当者様\n\n{opener}\n\n{GOOD}{APPROVED}\n\nご関心があればご連絡ください。")
        for closer in ("よろしくお願いいたします。", "ご検討のほど、よろしくお願い申し上げます。", "何卒、よろしくお願いいたします。"):
            with self.subTest(closer=closer):
                self.assertNotIn(closer, drafting._claim_body(f"ご担当者様\n\n{GOOD}\n\n{closer}"))
                compose(f"ご担当者様\n\n{GOOD}{APPROVED}\n\n{closer}")


class LanguageRouting(unittest.TestCase):
    def test_one_decision_for_metadata(self):
        for language, country, expected in (("ja-JP", "US", True), ("en", "Japan", False), ("", "Japan", True), ("ja", "", True)):
            p = {**PROSPECT, "language": language, "country": country}
            with self.subTest(language=language, country=country):
                self.assertEqual(drafting.should_use_japanese(p), expected)
                self.assertEqual(drafting.is_japanese_animation_prospect(p), expected)

    def test_english_reply_from_a_japan_studio_is_composed_in_english(self):
        p = {**PROSPECT, "language": "", "country": "Japan", "contact_name": ""}
        inbound = {"id": "in-1", "subject": "Re: Animation", "body": "Thanks for the details. Please send the portfolio link."}
        self.assertFalse(drafting.should_use_japanese(p, [], inbound))
        ev = [{"id": "ev1", "verified": True, "fact_type": "portfolio", "url": "https://aozora.example/works",
               "snippet": "Aozora Animation publishes its television anime credits."}]
        def llm(instruction, payload, schema):
            return {"subject": "Re: Animation", "evidence_ids": ["in-1", "ev1"],
                    "body": "Hello,\n\nHere is our portfolio link: https://studiokairegi.com/reel"}
        try:
            drafting.compose_english(p, ev, KB, SETTINGS, llm, kind="reply", inbound=inbound)
        except PermanentError as exc:   # a later quality gate may object; the language gate must not
            self.assertNotIn("not used for Japanese prospects", str(exc))

    def test_takeover_english_choice_never_uses_japanese_templates(self):
        c = ctx([OUT1], status="contacted")
        c["prospect"].update(type="animation_studio_support", country="Japan", language="en")
        out, rpc = run(c)
        for call in rpc.named("intel_agent_upsert_draft"):
            self.assertNotRegex(call["p_body"], r"[\u3040-\u30ff]")


class Salutations(unittest.TestCase):
    def test_accepted_forms(self):
        for greeting in ("佐藤花子様", "佐藤様", "青空アニメーション\n佐藤様", "青空アニメーション 佐藤花子様", "ご担当 佐藤様"):
            with self.subTest(greeting=greeting):
                drafting._validate_japanese_recipient_name(greeting + "\n\n本文", PROSPECT)

    def test_wrong_or_generic_for_named_contact_is_rejected(self):
        for greeting in ("田中様", "田中太郎様", "ご担当者様", "鈴木 佐藤様"):
            with self.subTest(greeting=greeting), self.assertRaises(PermanentError):
                drafting._validate_japanese_recipient_name(greeting + "\n\n本文", PROSPECT)

    def test_spaced_name_accepts_family_token(self):
        drafting._validate_japanese_recipient_name("佐藤様\n\n本文", {**PROSPECT, "contact_name": "佐藤 花子"})


class TakeoverVetting(unittest.TestCase):
    MAIL = {"subject": "Re: 制作協力", "body": "ご担当者様\n\n" + GOOD + "\n\n" + FOOTER, "model_written": True,
            "evidence_trace": [{"id": "ev-jp-1", "fact_type": "portfolio", "url": "", "snippet": "x"}]}

    def _jp_ctx(self):
        c = ctx([OUT1, entry("inbound", "制作実績に興味があります。資料をお願いします。", "2026-10-06", "Re: 制作協力")])
        c["prospect"]["language"] = "ja"
        return c

    def test_evidence_trace_is_stored_for_takeover_drafts(self):
        with patch.object(takeover, "_draft_japanese_takeover", return_value=dict(self.MAIL)):
            out, rpc = run(self._jp_ctx(), Llm({"summary": "s", "intent": "interested", "open_questions": [], "language": "ja"}))
        self.assertEqual(out["next_action"], "reply")
        self.assertEqual(len(rpc.named("intel_agent_set_message_evidence")), 1)

    def test_near_duplicate_takeover_draft_is_regenerated_once_then_goes_to_a_person(self):
        class DupRpc(Rpc):
            def __call__(self, name, p=None):
                if name == "intel_agent_recent_outbound":
                    self.calls.append((name, p or {}))
                    return [{"subject": "x", "body_text": TakeoverVetting.MAIL["body"], "state": "sent", "prospect_name": "別会社", "contact_name": "山田"}]
                return super().__call__(name, p)
        c = self._jp_ctx()
        with patch.object(takeover, "_draft_japanese_takeover", return_value=dict(self.MAIL)) as composer:
            out, rpc = run(c, Llm({"summary": "s", "intent": "interested", "open_questions": [], "language": "ja"}), rpc=DupRpc(c))
        self.assertEqual(composer.call_count, 2)
        self.assertEqual(out["next_action"], "needs_human")
        self.assertEqual(rpc.named("intel_agent_upsert_draft"), [])


if __name__ == "__main__":
    unittest.main()
