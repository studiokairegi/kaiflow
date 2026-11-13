from pathlib import Path
import unittest


class CampaignFollowupSendCapMigrationTests(unittest.TestCase):
    def test_final_send_trigger_applies_campaign_specific_ceiling(self):
        path = (Path(__file__).resolve().parents[2] / "supabase" / "migrations" /
                "20261230100000_intelligence_campaign_followup_send_cap.sql")
        sql = path.read_text()
        self.assertIn("new.state <> 'sending'", sql)
        self.assertIn("new.kind <> 'followup'", sql)
        self.assertIn("when v_campaign_type = 'indie_game_developer' then 4 else 3", sql)
        self.assertIn("least(v_configured_cap", sql)
        self.assertIn("m.state in ('reserved', 'sending', 'sent', 'unknown')", sql)
        self.assertIn("before update of state on public.intel_messages", sql)
        self.assertIn("new.state = 'sending'", sql)

    def test_admin_chat_accepts_the_indie_four_followup_setting(self):
        path = (Path(__file__).resolve().parents[2] / "supabase" / "migrations" /
                "20261230100000_intelligence_campaign_followup_send_cap.sql")
        sql = path.read_text()
        self.assertIn("(a ->> 'max_followups')::int > 4", sql)
        self.assertIn("max_followups_must_be_0_to_4", sql)

    def test_final_send_cap_counts_only_other_followups_for_same_prospect(self):
        path = (Path(__file__).resolve().parents[2] / "supabase" / "migrations" /
                "20261230100000_intelligence_campaign_followup_send_cap.sql")
        sql = path.read_text()
        self.assertIn("m.prospect_id = new.prospect_id", sql)
        self.assertIn("m.id <> new.id", sql)
        self.assertIn("v_existing >= v_effective_cap", sql)


if __name__ == "__main__":
    unittest.main()
