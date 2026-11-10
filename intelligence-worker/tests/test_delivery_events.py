import unittest
from datetime import datetime, timezone

from kairflow_intel.delivery_events import apply_event, is_forward_transition, normalize_event, normalize_status


class DeliveryEventTests(unittest.TestCase):
    def event(self, **overrides):
        value = {
            "provider_key": "gmail",
            "provider_account_id": "11111111-1111-4111-8111-111111111111",
            "provider_message_id": "gmail-msg-123",
            "provider_event_id": "gmail-event-456",
            "event_type": "message.delivered",
            "occurred_at": "2026-11-08T10:00:00Z",
            "recipient": "Studio@Example.com",
            "reason": "",
            "raw_body": "must never be forwarded",
        }
        value.update(overrides)
        return value

    def test_normalizes_common_provider_vocabulary(self):
        cases = {
            "email.delivered": "delivered",
            "delivery_delayed": "delayed",
            "hard_bounce": "bounced",
            "soft_bounce": "delayed",
            "email.complained": "complained",
            "email.failed": "failed",
            "message.sent": "accepted",
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(normalize_status(raw), expected)

    def test_requires_stable_event_identity_and_exact_account_routing(self):
        with self.assertRaisesRegex(ValueError, "stable provider event id"):
            normalize_event(self.event(provider_event_id=""))
        with self.assertRaisesRegex(ValueError, "provider account id"):
            normalize_event(self.event(provider_account_id=""))
        with self.assertRaisesRegex(ValueError, "provider message id"):
            normalize_event(self.event(provider_message_id=""))

    def test_explicit_event_type_wins_over_conflicting_adapter_status(self):
        self.assertEqual(normalize_status("email.bounced", "delivered"), "bounced")

    def test_explicit_soft_bounce_status_overrides_generic_bounced_event_name(self):
        self.assertEqual(normalize_status("email.bounced", "soft_bounce"), "delayed")
        self.assertEqual(normalize_status("email.bounced", "hard_bounce"), "bounced")

    def test_rejects_unknown_event_status(self):
        with self.assertRaisesRegex(ValueError, "unsupported"):
            normalize_event(self.event(event_type="email.opened"))

    def test_reduces_event_to_safe_rpc_payload(self):
        payload = normalize_event(self.event(reason="  mailbox\nnot found  "))
        self.assertEqual(payload["p_status"], "delivered")
        self.assertEqual(payload["p_recipient"], "studio@example.com")
        self.assertEqual(payload["p_reason"], "  mailbox not found  ")
        self.assertNotIn("raw_body", payload)
        self.assertEqual(payload["p_occurred_at"], "2026-11-08T10:00:00+00:00")

    def test_supports_epoch_milliseconds_and_naive_datetimes(self):
        p = normalize_event(self.event(occurred_at=1794132000000))
        self.assertTrue(p["p_occurred_at"].endswith("+00:00"))
        p = normalize_event(self.event(occurred_at=datetime(2026, 11, 8, 10, tzinfo=None)))
        self.assertTrue(p["p_occurred_at"].endswith("+00:00"))

    def test_out_of_order_events_never_regress_delivery_state(self):
        self.assertTrue(is_forward_transition("accepted", "delayed"))
        self.assertTrue(is_forward_transition("delayed", "delivered"))
        self.assertTrue(is_forward_transition("delivered", "bounced"))
        self.assertTrue(is_forward_transition("bounced", "complained"))
        self.assertFalse(is_forward_transition("delivered", "delayed"))
        self.assertFalse(is_forward_transition("bounced", "delivered"))
        self.assertFalse(is_forward_transition("complained", "bounced"))

    def test_rpc_is_called_once_with_stable_event_payload(self):
        calls = []
        def rpc(name, payload):
            calls.append((name, payload))
            return {"ok": True, "found": True, "duplicate": False, "applied": True}
        result = apply_event(rpc, self.event())
        self.assertTrue(result["applied"])
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0], "intel_agent_apply_delivery_event")
        self.assertEqual(calls[0][1]["p_provider_event_id"], "gmail-event-456")

    def test_rpc_failure_is_not_acknowledged(self):
        def rpc(_name, _payload):
            return {"ok": False, "reason": "not matched"}
        with self.assertRaisesRegex(RuntimeError, "not durably accepted"):
            apply_event(rpc, self.event())

    def test_unmatched_rpc_result_is_not_acknowledged_even_if_ok_flag_is_true(self):
        def rpc(_name, _payload):
            return {"ok": True, "found": False, "reason": "message_not_matched"}
        with self.assertRaisesRegex(RuntimeError, "message_not_matched"):
            apply_event(rpc, self.event())

    def test_rpc_must_report_durable_processing_outcome(self):
        def rpc(_name, _payload):
            return {"ok": True, "found": True}
        with self.assertRaisesRegex(RuntimeError, "durable processing outcome"):
            apply_event(rpc, self.event())

    def test_valid_idempotent_duplicate_is_acknowledged(self):
        def rpc(_name, _payload):
            return {"ok": True, "found": True, "duplicate": True, "applied": False}
        self.assertTrue(apply_event(rpc, self.event())["duplicate"])


if __name__ == "__main__":
    unittest.main()
