"""Regression tests for the second Phase 3 review (false suppression, price/prior-contact language, language selection,
thread subjects, recipient names). Each case failed before the corresponding fix."""
import unittest

from kairflow_intel import classify, drafting, policy
from kairflow_intel.errors import PermanentError
from tests.test_phase3_japanese import EVIDENCE, KB, PROSPECT, SETTINGS, writer_for

BASE = "青空アニメーション 佐藤花子様\n\n"
GOOD = BASE + "青空アニメーションのテレビアニメの制作実績を拝見し、原画と動画の工程についてご連絡いたしました。"
SIG = "\n\nStudio Kairegi 田中"
EN_PROSPECT = {**PROSPECT, "language": "en", "country": "US"}


def compose(body, subject="青空アニメーション様の制作実績について", kind="initial", **kw):
    ids = kw.pop("ids", None)
    return drafting.compose_japanese(PROSPECT, kw.pop("evidence", EVIDENCE), KB, SETTINGS, writer_for(body, subject, ids), kind=kind, **kw)


class InboundClassification(unittest.TestCase):
    def hits(self, text):
        return policy.scan_inbound("Re: ご提案", text)["hits"]

    def test_channel_and_acceptance_phrases_are_not_opt_outs(self):
        for text in ("メールで結構です。ポートフォリオをお送りください。", "ご連絡はメールでお願いします。電話は不要です。",
                     "それで結構です。ぜひお願いします。", "はい、それで結構です。", "日程はそれで結構です。"):
            with self.subTest(text=text):
                self.assertFalse(self.hits(text) & {"unsubscribe", "decline"})

    def test_real_opt_outs_and_declines_still_detected(self):
        for text in ("今後のご案内は不要です。", "営業メールは結構です。", "メールは結構です。", "メールでのご連絡は結構です。",
                     "配信停止してください。", "今後ご連絡は控えてください。"):
            with self.subTest(text=text):
                self.assertIn("unsubscribe", self.hits(text))
        self.assertIn("decline", self.hits("今回は結構です。"))

    def test_acceptance_is_not_classified_as_rejection_that_suppresses(self):
        r = classify.classify({"subject": "Re: ご提案", "body_text": "はい、それで結構です。", "from_email": "a@b.jp"}, set(), None)
        self.assertNotIn(r["class"], ("rejection", "unsubscribe"))


class OutboundLanguageRules(unittest.TestCase):
    def test_amounts_are_rejected(self):
        for s in ("原画と動画の制作協力は1件5,000円から承ります。", "原画と動画の制作協力は1件￥5,000でお受けします。",
                  "原画と動画の制作協力は1件30ドルです。", "原画と動画の制作協力は五千円です。"):
            with self.subTest(s=s), self.assertRaises(PermanentError):
                compose(GOOD + s + SIG)

    def test_policy_validation_blocks_amounts_in_any_japanese_body(self):
        body = GOOD + "1件5,000円です。\n" + KB["policy.opt_out.ja"]["body"]
        self.assertTrue(policy.validate_outbound("件名", body, SETTINGS, set(), "reply"))
        self.assertFalse(policy.PRICE_IN_DRAFT_JA.search("円滑に進行します"))

    def test_prior_contact_and_experience_claims_are_rejected(self):
        for s in ("先日はお時間をいただき、ありがとうございました。", "先日お会いした際にお話しした件です。", "いつもお世話になっております。"):
            with self.subTest(s=s), self.assertRaises(PermanentError):
                compose(BASE + s + "青空アニメーションの制作実績を拝見しました。" + SIG)

    def test_played_claim_is_rejected_even_when_evidence_mentions_players(self):
        ev = [{**EVIDENCE[0], "snippet": EVIDENCE[0]["snippet"] + "プレイヤーが操作する2Dアクションの制作実績も公開しています。"}]
        with self.assertRaises(PermanentError):
            compose(BASE + "青空アニメーションの制作実績を拝見し、ゲームもプレイいたしました。原画と動画の工程でご協力できます。" + SIG, evidence=ev)

    def test_followup_may_refer_to_our_own_earlier_mail(self):
        history = [{"direction": "outbound", "state": "sent", "kind": "initial", "subject": "青空アニメーション様の制作実績について",
                    "body_text": "ご案内をお送りしました。"}]
        r = compose(GOOD.replace("ご連絡いたしました", "改めてご連絡いたしました") + "先日お送りしたご案内の件です。" + SIG, kind="followup",
                    history=history, parent_subject="青空アニメーション様の制作実績について")
        self.assertTrue(r["subject"].startswith("Re: "))


class LanguageSelection(unittest.TestCase):
    def test_japanese_signature_under_english_message_does_not_select_japanese(self):
        body = "Thanks for reaching out. Could you send over your showreel and a few samples?\n\nBest,\nHanako\n\n株式会社青空アニメーション\n代表取締役 佐藤花子"
        self.assertFalse(drafting.should_use_japanese(EN_PROSPECT, inbound={"body": body}))
        no_signoff = "Thanks for reaching out. Could you send over your showreel and a few samples?\n株式会社青空アニメーション\n代表取締役 佐藤花子"
        self.assertFalse(drafting.should_use_japanese(EN_PROSPECT, inbound={"body": no_signoff}))

    def test_japanese_message_with_english_signature_stays_japanese(self):
        body = "制作実績を拝見しました。資料をお送りください。\n\nBest regards,\nHanako Sato\nAozora Animation Inc."
        self.assertTrue(drafting.should_use_japanese(EN_PROSPECT, inbound={"body": body}))

    def test_stock_english_courtesy_keeps_an_established_japanese_thread(self):
        hist = [{"direction": "inbound", "body_text": "制作実績を拝見しました。資料をお送りください。"}]
        for text in ("Thank you.", "Thank you!", "Sounds good", "Got it, thanks"):
            with self.subTest(text=text):
                self.assertTrue(drafting.should_use_japanese({**PROSPECT, "language": "ja"}, hist, {"body": text}))
        self.assertFalse(drafting.should_use_japanese({**PROSPECT, "language": "ja"}, hist, {"body": "Please send the English portfolio link."}))


class ThreadSubjects(unittest.TestCase):
    INBOUND = {"id": "m1", "subject": "Re: Animation production support for Aozora", "body": "ポートフォリオのリンクを送っていただけますか。"}
    REPLY = "ご担当者様\n\nご連絡ありがとうございます。ポートフォリオのリンクをお送りします。\nhttps://studiokairegi.com/reel\n制作実績を拝見しました。" + SIG

    def reply(self, subject):
        return drafting.compose_japanese({**PROSPECT, "contact_name": ""}, EVIDENCE, KB, SETTINGS, writer_for(self.REPLY, subject, ["m1", "ev-jp-1"]),
                                         kind="reply", inbound=self.INBOUND)

    def test_reply_keeps_the_conversation_subject_whatever_the_model_wrote(self):
        for model_subject in ("全く別の件名です", "Re: 青空アニメーション様の制作実績について"):
            with self.subTest(model_subject=model_subject):
                self.assertEqual(self.reply(model_subject)["subject"], "Re: Animation production support for Aozora")

    def test_followup_keeps_parent_subject_with_single_re(self):
        r = compose(GOOD + SIG, subject="全く別の件名です", kind="followup", history=[{"direction": "outbound", "state": "sent", "body_text": "ご案内"}],
                    parent_subject="Animation production support for Aozora")
        self.assertEqual(r["subject"], "Re: Animation production support for Aozora")


class RecipientNames(unittest.TestCase):
    def accepted(self, greeting, contact="佐藤花子"):
        try:
            drafting._validate_japanese_recipient_name(greeting + "\n\n本文", {**PROSPECT, "contact_name": contact})
            return True
        except PermanentError:
            return False

    def test_truncated_and_given_only_names_are_rejected(self):
        self.assertFalse(self.accepted("佐藤花様"))
        self.assertFalse(self.accepted("花子様", "佐藤 花子"))
        self.assertTrue(all(self.accepted(g) for g in ("佐藤様", "佐藤花子様")))
        self.assertTrue(self.accepted("佐藤様", "佐藤 花子"))
        self.assertTrue(self.accepted("長谷川様", "長谷川花子"))
        # An unspaced name cannot reveal where the family name ends; a spaced contact name is exact.
        self.assertTrue(self.accepted("長谷川様", "長谷川 花子"))
        self.assertFalse(self.accepted("長谷様", "長谷川 花子"))
        self.assertTrue(self.accepted("Sato様", "Hanako Sato"))


class Similarity(unittest.TestCase):
    def test_japanese_salutation_does_not_hide_a_reused_message(self):
        text = "原画と動画の工程でご協力できればと存じます。ポートフォリオは下記です。"
        a = {"subject": "A", "body": "株式会社青空アニメーション 佐藤花子様\n\n" + text, "names": ["青空アニメーション"]}
        b = {"subject": "B", "body": "ご担当者様\n\n" + text}
        self.assertFalse(drafting.uniqueness_check(b, [a], drafting.SIMILARITY_THRESHOLD)["ok"])
        self.assertEqual(drafting._similarity_text("株式会社X 佐藤様\n\n本文です"), "本文です")
        self.assertEqual(drafting._similarity_text("本文です 配信停止"), "本文です")


if __name__ == "__main__":
    unittest.main()
