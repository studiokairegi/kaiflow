"""Phase 3 Japanese-language drafting and language-selection regression tests."""
import json
import unittest
from types import SimpleNamespace

from kairflow_intel import classify, drafting, jobs, policy
from kairflow_intel.errors import PermanentError

PROSPECT = {
    "id": "jp-1", "name": "青空アニメーション", "contact_name": "佐藤花子",
    "type": "animation_studio_support", "language": "ja-JP", "country": "Japan",
    "website": "https://aozora.example", "domain": "aozora.example",
}
EVIDENCE = [{
    "id": "ev-jp-1", "verified": True, "fact_type": "portfolio",
    "snippet": "青空アニメーションはテレビアニメの制作実績を公開し、原画と動画を担当しました。",
    "url": "https://aozora.example/works",
}]
KB_ROWS = [
    {"key": "studio.about", "body": "Studio Kairegi is a 2D animation studio."},
    {"key": "services.animation_studio_support", "body": "We support 2D animation production."},
    {"key": "portfolio.main", "body": "Our reel: https://studiokairegi.com/reel"},
    {"key": "studio.about.ja", "body": "Studio Kairegiは2Dアニメーション制作を行うスタジオです。"},
    {"key": "services.animation_studio_support.ja", "body": "レイアウト、原画、動画、仕上げの制作協力に対応しています。"},
    {"key": "services.indie_game_developer.ja", "body": "ゲーム向けの2Dアニメーション映像制作に対応しています。"},
    {"key": "portfolio.main.ja", "body": "制作実績：https://studiokairegi.com/reel"},
    {"key": "policy.opt_out.ja", "body": "今後のご案内が不要でしたら、その旨をご返信ください。"},
]
KB = drafting.kb_map(KB_ROWS)
SETTINGS = {
    "sender_name": "Alex", "sender_email": "alex@studiokairegi.com",
    "physical_address": "Nairobi, Kenya", "opt_out_text": "Reply STOP to opt out.",
}


def writer_for(body, subject="青空アニメーション様の制作実績について", ids=None):
    def writer(instruction, payload, schema):
        data = json.loads(payload)
        return {"subject": subject, "body": body,
                "evidence_ids": ids or [e["id"] for e in data["verified_evidence"]]}
    return writer



class JapaneseInitialDraftFallback(unittest.TestCase):
    def test_missing_recipient_evidence_uses_honest_approved_studio_intro(self):
        called = []
        result = drafting.compose_japanese(
            PROSPECT, [], KB, SETTINGS,
            llm=lambda *args: called.append(args),
            kind="initial",
        )
        self.assertFalse(result["model_written"])
        self.assertIn("Studio Kairegiは2Dアニメーション制作を行うスタジオです。", result["body"])
        self.assertIn("レイアウト、原画、動画、仕上げ", result["body"])
        self.assertIn("青空アニメーション", result["subject"])
        self.assertNotIn("多くのアニメーション作品", result["body"])
        self.assertEqual(called, [])

    def test_unsupported_japanese_volume_claim_is_rejected(self):
        body = ("ご担当者様\n\n突然のご連絡失礼いたします。"
                "貴社の作品を拝見し、多くのアニメーション作品を制作されてきたと感じました。")
        with self.assertRaises(PermanentError):
            drafting.compose_japanese(PROSPECT, EVIDENCE, KB, SETTINGS,
                                      writer_for(body), kind="initial")


class JapaneseLanguageSelection(unittest.TestCase):
    def test_site_language_and_country_select_japanese(self):
        self.assertTrue(drafting.should_use_japanese(PROSPECT))
        self.assertTrue(drafting.should_use_japanese({**PROSPECT, "language": "ja-JP", "country": "US"}))

    def test_current_english_correspondence_overrides_japan_country_default(self):
        p = {**PROSPECT, "language": "", "country": "Japan"}
        self.assertFalse(drafting.should_use_japanese(p, inbound={"body": "Thanks for the details. Please send the portfolio link."}))

    def test_existing_japanese_inbound_thread_selects_japanese(self):
        p = {**PROSPECT, "language": "en", "country": "US"}
        history = [{"direction": "inbound", "body_text": "制作実績を拝見しました。資料をお送りください。"}]
        self.assertTrue(drafting.should_use_japanese(p, history))

    def test_current_english_reply_overrides_older_japanese_thread(self):
        p = {**PROSPECT, "language": "en", "country": "US"}
        history = [{"direction": "inbound", "body_text": "制作実績を拝見しました。資料をお送りください。"}]
        self.assertFalse(drafting.should_use_japanese(p, history, {"body": "Thanks, please send the portfolio link."}))

    def test_short_japanese_acknowledgements_keep_japanese_thread_language(self):
        p = {**PROSPECT, "language": "en", "country": "US"}
        for reply in ("はい。", "お願いします。", "OKです。"):
            with self.subTest(reply=reply):
                self.assertTrue(drafting.should_use_japanese(p, inbound={"body": reply}))

    def test_short_english_reply_can_override_previous_japanese_thread(self):
        p = {**PROSPECT, "language": "ja", "country": "Japan"}
        history = [{"direction": "inbound", "body_text": "制作実績について質問があります。"}]
        self.assertFalse(drafting.should_use_japanese(p, history, {"body": "Thanks, understood. Please use English from now on."}))

    def test_ambiguous_short_reply_preserves_established_japanese_thread_language(self):
        p = {**PROSPECT, "language": "en", "country": "US"}
        history = [
            {"direction": "inbound", "body_text": "作品を拝見しました。"},
            {"direction": "outbound", "body_text": "ご返信ありがとうございます。"},
        ]
        for subject in ("", "Re: Thanks", "Re: Thanks for your time"):
            with self.subTest(subject=subject):
                self.assertTrue(drafting.should_use_japanese(p, history, {"body": "Thanks.", "subject": subject}))

    def test_ambiguous_reply_preserves_language_of_latest_outbound_when_no_decisive_inbound_exists(self):
        p_en = {**PROSPECT, "language": "en", "country": "US"}
        p_ja = {**PROSPECT, "language": "ja", "country": "Japan"}
        self.assertTrue(drafting.should_use_japanese(
            p_en, [{"direction": "outbound", "body_text": "ご案内をお送りします。"}],
            {"body": "Thanks."}))
        self.assertFalse(drafting.should_use_japanese(
            p_ja, [{"direction": "outbound", "body_text": "Thank you for your time."}],
            {"body": "Thanks."}))
        # A clear language choice in the current inbound always wins over thread history.
        self.assertFalse(drafting.should_use_japanese(
            p_en, [{"direction": "outbound", "body_text": "ご案内をお送りします。"}],
            {"body": "Thanks for the information. Please send details."}))

    def test_ambiguous_reply_uses_nearest_decisive_inbound_language(self):
        p = {**PROSPECT, "language": "ja", "country": "Japan"}
        history = [
            {"direction": "inbound", "body_text": "作品を拝見しました。"},
            {"direction": "inbound", "body_text": "Thanks for the information. Please send details."},
        ]
        self.assertFalse(drafting.should_use_japanese(p, history, {"body": "Thanks."}))

    def test_quoted_japanese_or_english_text_does_not_override_new_sender_text(self):
        p = {**PROSPECT, "language": "en", "country": "US"}
        self.assertFalse(drafting.should_use_japanese(p, inbound={"body": "Thanks.\n\n> ポートフォリオをお願いします。"}))
        p_ja = {**PROSPECT, "language": "en", "country": "US"}
        self.assertTrue(drafting.should_use_japanese(p_ja, inbound={"body": "はい。\n\n> Thanks for your email."}))

    def test_japanese_indie_prospect_requires_its_own_approved_japanese_kb(self):
        p = {"type": "indie_game_developer", "language": "ja"}
        with self.assertRaises(PermanentError):
            drafting.require_japanese_kb_for(p, {k: v for k, v in KB.items() if k != "services.indie_game_developer.ja"})
        drafting.require_japanese_kb_for(p, KB)


class JapaneseInboundPolicy(unittest.TestCase):
    def test_japanese_meeting_requests_are_hard_escalations_even_if_model_is_positive(self):
        examples = (
            "お電話で一度お話しできますでしょうか。",
            "オンラインで面談をお願いできますか。",
            "来週、日程調整をお願いできますか。",
        )
        for message in examples:
            with self.subTest(message=message):
                result = classify.classify(
                    {"subject": "Re: 制作協力について", "body_text": message}, set(),
                    lambda *_: {"label": "positive", "confidence": 0.99, "summary": "Positive"})
                self.assertEqual(result["class"], "meeting_request")
                self.assertTrue(result["escalate"])
                self.assertFalse(result["auto_ok"])
                self.assertIn("meeting", policy.scan_inbound("", message)["hits"])

    def test_alternate_japanese_meeting_and_scheduling_phrases_are_hard_escalations(self):
        examples = (
            "打合せをお願いできますか。",
            "お打合せできますでしょうか。",
            "会議を設定できますか。",
            "来週の候補日を教えてください。",
        )
        for message in examples:
            with self.subTest(message=message):
                result = classify.classify(
                    {"subject": "Re: 制作協力について", "body_text": message}, set(),
                    lambda *_: {"label": "positive", "confidence": 0.99, "summary": "Positive"})
                self.assertEqual(result["class"], "meeting_request")
                self.assertTrue(result["escalate"])
                self.assertFalse(result["auto_ok"])
                self.assertIn("meeting", policy.scan_inbound("", message)["hits"])
                self.assertTrue(drafting._is_consequential_japanese_inbound({"body": message}))

    def test_ordinary_meeting_references_and_confirmations_are_not_escalated(self):
        examples = (
            "打合せ資料を添付いたします。",
            "先日はお打ち合わせありがとうございました。",
            "打合せは来週に決まりました。",
            "候補日は社内で決定しました。",
            "会議の資料を添付しました。",
            "We discussed the meeting in yesterday's email.",
            "The meeting is confirmed for next week.",
        )
        for message in examples:
            with self.subTest(message=message):
                self.assertNotIn("meeting", policy.scan_inbound("Re: 資料", message)["hits"])
                self.assertFalse(drafting._is_consequential_japanese_inbound({"body": message}))

    def test_meeting_requests_still_escalate_with_request_language(self):
        examples = (
            "来週の打合せをお願いできますか。",
            "会議を設定できますでしょうか。",
            "来週の候補日を教えてください。",
            "Could we schedule a meeting next week?",
            "Please book a call with us.",
        )
        for message in examples:
            with self.subTest(message=message):
                self.assertIn("meeting", policy.scan_inbound("Re: ご相談", message)["hits"])
                self.assertTrue(drafting._is_consequential_japanese_inbound({"body": message}))

    def test_meeting_document_requests_are_not_misclassified_as_meeting_requests(self):
        examples = (
            "Could we send the meeting notes?",
            "Would you share meeting materials?",
            "Could we review the agenda?",
            "打合せ資料をお送りいただけますか。",
            "議事録を共有いただけますか。",
            "会議資料を送ってください。",
            "会議の議題を教えていただけますか。",
        )
        for message in examples:
            with self.subTest(message=message):
                self.assertNotIn("meeting", policy.scan_inbound("Re: 資料", message)["hits"])
                self.assertFalse(drafting._is_consequential_japanese_inbound({"body": message}))
                result = classify.classify(
                    {"subject": "Re: 制作協力について", "body_text": message}, set(),
                    lambda *_: {"label": "positive", "confidence": 0.99, "summary": "Positive"})
                self.assertNotEqual(result["class"], "meeting_request")

    def test_indirect_english_meeting_scheduling_requests_are_hard_escalations(self):
        examples = (
            "Would you mind scheduling a meeting?",
            "Would you mind setting up a call?",
            "Could we find a time to talk next week?",
            "Could we find some time to speak?",
        )
        for message in examples:
            with self.subTest(message=message):
                self.assertIn("meeting", policy.scan_inbound("Re: project", message)["hits"])
                result = classify.classify(
                    {"subject": "Re: project", "body_text": message}, set(),
                    lambda *_: {"label": "positive", "confidence": 0.99, "summary": "Positive"})
                self.assertEqual(result["class"], "meeting_request")
                self.assertTrue(result["escalate"])
                self.assertFalse(result["auto_ok"])

    def test_japanese_meeting_time_and_date_negotiation_requests_are_hard_escalations(self):
        examples = (
            "来週お打合せのお時間をいただけますでしょうか。",
            "打ち合わせの日時を決めたいです。",
            "会議の日程を調整したいです。",
        )
        for message in examples:
            with self.subTest(message=message):
                self.assertIn("meeting", policy.scan_inbound("Re: ご相談", message)["hits"])
                result = classify.classify(
                    {"subject": "Re: ご相談", "body_text": message}, set(),
                    lambda *_: {"label": "positive", "confidence": 0.99, "summary": "Positive"})
                self.assertEqual(result["class"], "meeting_request")
                self.assertTrue(result["escalate"])
                self.assertFalse(result["auto_ok"])
                self.assertTrue(drafting._is_consequential_japanese_inbound({"body": message}))

    def test_explicit_english_meeting_arrangements_remain_hard_escalations(self):
        examples = (
            "Could we schedule a meeting next week?",
            "Please book a call with us.",
            "Could we arrange a call?",
            "Would you be available for a meeting?",
            "Let's meet next week.",
            "Could you join a call?",
        )
        for message in examples:
            with self.subTest(message=message):
                self.assertIn("meeting", policy.scan_inbound("Re: project", message)["hits"])
                result = classify.classify(
                    {"subject": "Re: project", "body_text": message}, set(),
                    lambda *_: {"label": "positive", "confidence": 0.99, "summary": "Positive"})
                self.assertEqual(result["class"], "meeting_request")
                self.assertTrue(result["escalate"])
                self.assertFalse(result["auto_ok"])

    def test_japanese_opt_out_variants_are_hard_unsubscribe_even_if_model_is_positive(self):
        for message in ("メールはもう不要です。", "今後のメールは必要ありません。", "営業メールは結構です。"):
            with self.subTest(message=message):
                result = classify.classify({"subject": "Re: ご案内", "body_text": message}, set(),
                                           lambda *_: {"label": "positive", "confidence": 0.99})
                self.assertEqual(result["class"], "unsubscribe")
                self.assertFalse(result["auto_ok"])

    def test_japanese_delivery_and_availability_requests_are_hard_escalations(self):
        for message in ("来月までに納品できますか。", "いつ頃から対応できますか。"):
            with self.subTest(message=message):
                result = classify.classify({"subject": "Re: 制作協力", "body_text": message}, set(),
                                           lambda *_: {"label": "positive", "confidence": 0.99})
                self.assertIn(result["class"], ("deadline", "availability"))
                self.assertTrue(result["escalate"])
                self.assertFalse(result["auto_ok"])

    def test_quoted_opt_out_does_not_mark_new_reply_as_unsubscribe(self):
        result = classify.classify({"subject": "Re: ご案内", "body_text": "資料をお願いします。\n\n> メールはもう不要です。"}, set(),
                                   lambda *_: {"label": "portfolio_request", "confidence": 0.95})
        self.assertEqual(result["class"], "portfolio_request")
        self.assertTrue(result["auto_ok"])


class JapaneseComposer(unittest.TestCase):
    def test_initial_is_individualized_and_grounded(self):
        body = ("佐藤花子様\n\n貴社が公開されたテレビアニメの制作実績を拝見しました。\n"
                "弊社ではレイアウト、原画、動画、仕上げの制作協力に対応しています。")
        mail = drafting.compose_japanese(PROSPECT, EVIDENCE, KB, SETTINGS,
            writer_for(body), kind="initial")
        self.assertTrue(mail["model_written"])
        self.assertEqual(mail["personalization"]["language"], "ja")
        self.assertIn("今後のご案内が不要でしたら", mail["body"])
        self.assertIn("Nairobi, Kenya", mail["body"])
        self.assertEqual(mail["evidence_ids"], ["ev-jp-1"])

    def test_unsupported_japanese_subject_claim_is_rejected(self):
        body = ("佐藤花子様\n\n貴社が公開されたテレビアニメの制作実績を拝見しました。\n"
                "弊社ではレイアウト、原画、動画、仕上げの制作協力に対応しています。")
        with self.assertRaises(PermanentError):
            drafting.compose_japanese(PROSPECT, EVIDENCE, KB, SETTINGS,
                writer_for(body, "青空アニメーション様の受賞歴について"), kind="initial")

    def test_reply_must_cite_inbound_and_answer_portfolio_request(self):
        inbound = {"id": "msg-1", "subject": "Re: ご相談", "body": "ポートフォリオのリンクをお送りいただけますか。"}
        body = "佐藤花子様\n\nご返信ありがとうございます。ポートフォリオのリンクをお送りします。"
        mail = drafting.compose_japanese(PROSPECT, EVIDENCE, KB, SETTINGS,
            writer_for(body, "Re: ご相談", ["msg-1", "ev-jp-1"]), kind="reply", inbound=inbound)
        self.assertIn("msg-1", mail["evidence_ids"])

    def test_reply_that_does_not_answer_inbound_is_rejected(self):
        inbound = {"id": "msg-1", "subject": "Re: ご相談", "body": "ポートフォリオのリンクをお送りいただけますか。"}
        body = "佐藤花子様\n\nご連絡ありがとうございます。弊社は2Dアニメーション制作を行っています。"
        with self.assertRaises(PermanentError):
            drafting.compose_japanese(PROSPECT, EVIDENCE, KB, SETTINGS,
                writer_for(body, "Re: ご相談", ["msg-1", "ev-jp-1"]), kind="reply", inbound=inbound)


    def test_reengagement_uses_distinct_japanese_composition_instruction(self):
        seen = {}
        body = ("佐藤花子様\n\n貴社が公開されたテレビアニメの制作実績を拝見しました。\n"
                "弊社ではレイアウト、原画、動画、仕上げの制作協力に対応しています。")
        mail = drafting.compose_japanese(PROSPECT, EVIDENCE, KB, SETTINGS,
            lambda instruction, payload, schema: (seen.update(instruction=instruction) or
                writer_for(body)(instruction, payload, schema)),
            kind="reengagement",
            history=[{"direction": "outbound", "state": "sent", "body_text": "前回のご案内です。"}])
        self.assertIn("控えめな再連絡", seen["instruction"])
        self.assertTrue(mail["model_written"])

    def test_consequential_japanese_reply_requires_manual_review(self):
        inbound = {"id": "msg-2", "subject": "料金について", "body": "料金と納期の見積をお願いします。"}
        with self.assertRaises(PermanentError):
            drafting.compose_japanese(PROSPECT, EVIDENCE, KB, SETTINGS,
                writer_for("佐藤花子様\n\nご連絡ありがとうございます。", "Re: 料金", ["msg-2", "ev-jp-1"]),
                kind="reply", inbound=inbound)

    def test_meeting_document_requests_can_use_normal_japanese_reply_path(self):
        examples = ("打合せ資料をお送りいただけますか。", "議事録を共有いただけますか。",
                    "会議資料を送ってください。", "会議の議題を教えていただけますか。")
        for message in examples:
            with self.subTest(message=message):
                self.assertFalse(drafting._is_consequential_japanese_inbound({"body": message}))
        inbound = {"id": "msg-doc", "subject": "Re: 資料", "body": examples[0]}
        mail = drafting.compose_japanese(PROSPECT, EVIDENCE, KB, SETTINGS,
            writer_for("佐藤花子様\n\nご連絡ありがとうございます。資料をお送りします。", "Re: 資料", ["msg-doc", "ev-jp-1"]),
            kind="reply", inbound=inbound)
        self.assertTrue(mail["model_written"])

    def test_japanese_meeting_and_scheduling_replies_require_manual_review(self):
        for message in ("お電話で一度お話しできますでしょうか。",
                        "オンラインで面談をお願いできますか。",
                        "来週、日程調整をお願いできますか。",
                        "打合せをお願いできますか。",
                        "お打合せできますでしょうか。",
                        "会議を設定できますか。",
                        "来週の候補日を教えてください。"):
            with self.subTest(message=message):
                self.assertTrue(drafting._is_consequential_japanese_inbound({"body": message}))
                with self.assertRaises(PermanentError):
                    drafting.compose_japanese(PROSPECT, EVIDENCE, KB, SETTINGS,
                        writer_for("佐藤花子様\n\nご連絡ありがとうございます。", "Re: 制作協力", ["msg-meeting", "ev-jp-1"]),
                        kind="reply", inbound={"id": "msg-meeting", "subject": "Re: 制作協力", "body": message})

    def test_japanese_salutation_accepts_name_honorific_without_whitespace(self):
        for greeting in ("佐藤花子様", "佐藤 花子様", "山田先生"):
            prospect = {**PROSPECT, "contact_name": "佐藤花子" if "山田" not in greeting else "山田"}
            body = (greeting + "\n\n貴社が公開されたテレビアニメの制作実績を拝見しました。\n"
                    "弊社ではレイアウト、原画、動画、仕上げの制作協力に対応しています。")
            with self.subTest(greeting=greeting):
                drafting._validate_japanese_recipient_name(body, prospect)
                self.assertNotIn(greeting, drafting._claim_body(body))

    def test_wrong_japanese_recipient_name_is_rejected(self):
        body = ("田中様\n\n貴社が公開されたテレビアニメの制作実績を拝見しました。\n"
                "弊社ではレイアウト、原画、動画、仕上げの制作協力に対応しています。")
        with self.assertRaises(PermanentError):
            drafting.compose_japanese(PROSPECT, EVIDENCE, KB, SETTINGS, writer_for(body), kind="initial")

    def test_wrong_company_name_in_initial_subject_is_rejected(self):
        body = ("佐藤花子様\n\n貴社が公開されたテレビアニメの制作実績を拝見しました。\n"
                "弊社ではレイアウト、原画、動画、仕上げの制作協力に対応しています。")
        with self.assertRaises(PermanentError):
            drafting.compose_japanese(PROSPECT, EVIDENCE, KB, SETTINGS,
                writer_for(body, "青空スタジオ様の制作実績について"), kind="initial")

    def test_generic_greeting_allowed_when_contact_name_is_missing(self):
        drafting._validate_japanese_recipient_name("ご担当者様\n\nご連絡いたします。", {"name": "青空アニメーション"})
        drafting._validate_japanese_recipient_name("青空アニメーション御中\n\nご連絡いたします。", {"name": "青空アニメーション"})

    def test_natural_japanese_portfolio_answers_are_accepted(self):
        inbound = {"body": "過去作品の資料を見せていただけますか。"}
        for reply in ("作品集をお送りします。", "過去作品の資料を添付いたします。", "こちらから作例をご覧いただけます。"):
            with self.subTest(reply=reply):
                self.assertTrue(drafting._japanese_reply_addresses_inbound(reply, inbound))

    def test_unrelated_japanese_reply_is_rejected_for_portfolio_request(self):
        self.assertFalse(drafting._japanese_reply_addresses_inbound(
            "弊社の制作体制についてご案内いたします。", {"body": "過去作品の資料を見せていただけますか。"}))

    def test_japanese_opt_out_and_delivery_requests_are_consequential(self):
        for message in ("メールはもう不要です。", "今後のメールは必要ありません。", "営業メールは結構です。",
                        "来月までに納品できますか。", "いつ頃から対応できますか。"):
            with self.subTest(message=message):
                self.assertTrue(drafting._is_consequential_japanese_inbound({"body": message}))

    def test_missing_research_uses_non_personalized_approved_intro(self):
        result = drafting.compose_japanese(PROSPECT, [], KB, SETTINGS,
            writer_for("佐藤花子様\\n\\nご連絡ありがとうございます。"), kind="initial")
        self.assertFalse(result["model_written"])
        self.assertEqual(result["evidence_ids"], [])
        self.assertIn("Studio Kairegiは2Dアニメーション制作を行うスタジオです。", result["body"])

    def test_japanese_duplicate_and_name_swap_detection(self):
        a = "佐藤花子様\n\n貴社が公開されたテレビアニメの制作実績を拝見しました。原画と動画の制作協力に対応しています。"
        b = "田中様\n\n貴社が公開されたテレビアニメの制作実績を拝見しました。原画と動画の制作協力に対応しています。"
        result = drafting.uniqueness_check(
            {"subject": "制作実績について", "body": a},
            [{"subject": "制作実績について", "body": b, "names": ["田中"]}],
            threshold=drafting.SIMILARITY_THRESHOLD, names=["佐藤"])
        self.assertFalse(result["ok"])

    def test_distinct_japanese_messages_pass_similarity(self):
        a = "貴社が公開されたテレビアニメの制作実績を拝見しました。"
        b = "貴社の背景美術とキャラクター設定の取り組みを拝見しました。"
        result = drafting.uniqueness_check(
            {"subject": "制作実績について", "body": a},
            [{"subject": "制作内容について", "body": b}],
            threshold=drafting.SIMILARITY_THRESHOLD)
        self.assertTrue(result["ok"])


class JapaneseJobRouting(unittest.TestCase):
    def _run(self, status="lead_linked", messages=None):
        prospect = {**PROSPECT, "status": status, "contact_email": "contact@aozora.example"}
        context = {"prospect": prospect, "evidence": EVIDENCE, "messages": messages or [], "lead": {}}
        calls = []
        def rpc(name, params=None):
            calls.append((name, params or {}))
            if name == "intel_agent_context":
                return context
            if name == "intel_agent_settings":
                return SETTINGS
            if name == "intel_agent_kb":
                return KB_ROWS
            if name == "intel_agent_recent_outbound":
                return []
            if name == "intel_agent_upsert_draft":
                return {"ok": True, "message_id": "draft-1", "state": "pending_approval"}
            return {}
        class LLM:
            def generate_json(self, instruction, payload, schema, **kwargs):
                self.instruction = instruction
                data = json.loads(payload)
                body = ("佐藤花子様\n\n貴社が公開されたテレビアニメの制作実績を拝見しました。\n"
                        "弊社ではレイアウト、原画、動画、仕上げの制作協力に対応しています。")
                return {"subject": "青空アニメーション様の制作実績について", "body": body,
                        "evidence_ids": [e["id"] for e in data["verified_evidence"] if e["fact_type"] == "portfolio"]}
        llm = LLM()
        deps = jobs.Deps(cfg=SimpleNamespace(worker_id="phase3-test"), rpc=rpc,
                         fetcher=None, zoho=None, llm=llm)
        result = jobs.h_draft(deps, {"payload": {"prospect_id": "jp-1", "kind": "initial" if status == "lead_linked" else "followup"}})
        return result, calls, llm

    def test_initial_japanese_prospect_uses_model_composer_and_stays_pending_approval(self):
        result, calls, llm = self._run()
        self.assertIn("あなたはStudio Kairegi", llm.instruction)
        draft = next(params for name, params in calls if name == "intel_agent_upsert_draft")
        self.assertFalse(draft["p_auto_ok"])
        self.assertEqual(draft["p_kind"], "initial")
        self.assertIn("貴社が公開された", draft["p_body"])
        self.assertEqual(result["state"], "pending_approval")

    def test_japanese_followup_uses_actual_sent_history(self):
        sent = [{"direction": "outbound", "kind": "initial", "state": "sent",
                 "subject": "制作実績について", "body_text": "先日、制作協力についてご案内しました。",
                 "sent_at": "2026-11-01T10:00:00Z"}]
        result, calls, llm = self._run(status="contacted", messages=sent)
        self.assertIn("実際に送信済み", llm.instruction)
        draft = next(params for name, params in calls if name == "intel_agent_upsert_draft")
        self.assertEqual(draft["p_kind"], "followup")
        self.assertFalse(draft["p_auto_ok"])


class JapaneseReplyRouting(unittest.TestCase):
    def test_inbound_japanese_reply_is_answered_in_japanese_and_waits_for_approval(self):
        inbound = {"id": "in-jp-1", "prospect_id": "jp-1", "from_email": "contact@aozora.example",
                   "subject": "Re: 制作協力について",
                   "body_text": "ポートフォリオのリンクをお送りいただけますか。興味があります。"}
        context = {"prospect": {**PROSPECT, "status": "contacted", "contact_email": "contact@aozora.example"},
                   "evidence": EVIDENCE, "messages": [], "lead": {}}
        calls = []
        def rpc(name, params=None):
            calls.append((name, params or {}))
            if name == "intel_agent_settings": return SETTINGS
            if name == "intel_agent_kb": return KB_ROWS
            if name == "intel_agent_unprocessed_inbound": return [inbound]
            if name == "intel_agent_context": return context
            if name == "intel_agent_recent_outbound": return []
            if name == "intel_agent_upsert_draft":
                return {"ok": True, "message_id": "reply-1", "state": "pending_approval"}
            return {}
        class LLM:
            def generate_json(self, instruction, payload, schema, **kwargs):
                if instruction.startswith("次の日本語メール"):
                    self.classification_instruction = instruction
                    return {"label": "portfolio_request", "confidence": 0.95, "summary": "ポートフォリオを希望"}
                data = json.loads(payload)
                self.composition_instruction = instruction
                return {"subject": "Re: 制作協力について",
                        "body": "佐藤花子様\n\nご返信ありがとうございます。ポートフォリオのリンクをお送りします。",
                        "evidence_ids": ["in-jp-1", "ev-jp-1"]}
        llm = LLM()
        deps = jobs.Deps(cfg=SimpleNamespace(worker_id="phase3-reply-test"), rpc=rpc,
                         fetcher=None, zoho=None, llm=llm)
        result = jobs.h_classify(deps, {"payload": {"message_id": "in-jp-1"}})
        self.assertIn("次の日本語メール", llm.classification_instruction)
        self.assertIn("あなたはStudio Kairegi", llm.composition_instruction)
        draft = next(params for name, params in calls if name == "intel_agent_upsert_draft")
        self.assertEqual(draft["p_kind"], "reply")
        self.assertFalse(draft["p_auto_ok"])
        self.assertIn("ポートフォリオのリンク", draft["p_body"])
        self.assertLess([name for name, _ in calls].index("intel_agent_upsert_draft"),
                        [name for name, _ in calls].index("intel_agent_classify_inbound"))
        self.assertEqual(result["classified"], 1)


if __name__ == "__main__":
    unittest.main()

class JapaneseDeepRegression(unittest.TestCase):
    def test_opt_out_is_contextual_and_never_overridden_by_positive_model(self):
        positive = lambda *_: {"label": "positive", "confidence": 0.99}
        for message in (
            "今後このような営業メールをお送りいただく必要はございません。",
            "今後のご連絡はご遠慮ください。",
            "メールを停止していただけますか。",
            "今後は営業メールをお送りいただかなくて結構です。",
        ):
            with self.subTest(message=message):
                result = classify.classify({"subject": "Re: ご案内", "body_text": message}, set(), positive)
                self.assertEqual(result["class"], "unsubscribe")
                self.assertFalse(result["auto_ok"])

    def test_non_email_解除_context_never_suppresses(self):
        for message in (
            "契約解除について相談したいです。",
            "契約を解除する場合の条件を教えてください。",
            "アカウント制限の解除は可能でしょうか。",
            "権限解除の手順を教えてください。",
        ):
            with self.subTest(message=message):
                result = classify.classify({"subject": "Re: ご案内", "body_text": message}, set(),
                    lambda *_: {"label": "positive", "confidence": 0.99})
                self.assertNotEqual(result["class"], "unsubscribe")
                self.assertFalse(result["auto_ok"])

    def test_quoted_opt_out_is_ignored_but_new_opt_out_is_not(self):
        quoted = classify.classify({"subject": "Re: ご案内", "body_text": "資料をお願いします。\n\n> 今後のご連絡はご遠慮ください。"}, set(),
            lambda *_: {"label": "portfolio_request", "confidence": 0.99})
        self.assertEqual(quoted["class"], "portfolio_request")
        current = classify.classify({"subject": "Re: ご案内", "body_text": "今後のご連絡はご遠慮ください。\n\n> 資料をお願いします。"}, set(),
            lambda *_: {"label": "positive", "confidence": 0.99})
        self.assertEqual(current["class"], "unsubscribe")

    def test_japanese_declines_are_deterministic_and_neutral_future_openness_is_not(self):
        for message in ("今回は見送らせていただきます。", "今回は辞退させていただきます。", "現時点では検討しておりません。"):
            with self.subTest(message=message):
                result = classify.classify({"subject": "Re: ご案内", "body_text": message}, set(),
                    lambda *_: {"label": "positive", "confidence": 0.99})
                self.assertEqual(result["class"], "rejection")
                self.assertFalse(result["auto_ok"])
        neutral = policy.scan_inbound("", "また機会があればお願いします。")["hits"]
        self.assertNotIn("decline", neutral)

    def test_short_kanji_acknowledgements_and_japanese_subject_are_used(self):
        p = {**PROSPECT, "language": "en", "country": "US"}
        for ack in ("了解", "承知", "了解しました", "承知しました"):
            with self.subTest(ack=ack):
                self.assertTrue(drafting._has_japanese_text(ack))
                self.assertTrue(drafting.should_use_japanese(p, inbound={"subject": "Re: 制作実績について", "body": ack}))

    def test_deadline_terms_require_commitment_context(self):
        portfolio = classify.classify({"subject": "Re: ご案内", "body_text": "制作実績として納品事例を拝見しました。"}, set(),
            lambda *_: {"label": "positive", "confidence": 0.99})
        self.assertEqual(portfolio["class"], "positive")
        deadline = classify.classify({"subject": "Re: 制作協力", "body_text": "来月までに納品できますか。"}, set(),
            lambda *_: {"label": "positive", "confidence": 0.99})
        self.assertEqual(deadline["class"], "deadline")
        self.assertTrue(deadline["escalate"])

    def test_japanese_reply_intent_validator_fails_closed_for_unknown_multistep_requests(self):
        inbound = {"body": "作品資料を送っていただき、来週の打ち合わせ候補日も教えてください。"}
        self.assertFalse(drafting._japanese_reply_addresses_inbound("資料をお送りします。", inbound))

    def test_japanese_reply_intent_validator_accepts_relevant_interest_response(self):
        inbound = {"body": "御社のサービスに興味があります。詳しくお話を聞かせてください。"}
        reply = "ご関心をお寄せいただきありがとうございます。制作内容をご案内いたします。"
        self.assertTrue(drafting._japanese_reply_addresses_inbound(reply, inbound))
