import unittest
from kairflow_intel.studio_reeval import eligible_prospect

class Phase6ReevaluationScopeTests(unittest.TestCase):
    def test_rejected_review_and_preoutreach_qualified_are_eligible(self):
        for status in ("rejected", "needs_review", "qualified", "lead_linked"):
            with self.subTest(status=status):
                self.assertTrue(eligible_prospect({"type":"animation_studio_support", "origin":"discovered", "status":status}))

    def test_manual_and_taken_over_prospects_are_never_auto_rescored(self):
        for origin in ("crm_existing", "manual", "taken_over"):
            with self.subTest(origin=origin):
                self.assertFalse(eligible_prospect({"type":"animation_studio_support", "origin":origin, "status":"needs_review"}))

    def test_indie_prospects_are_not_in_studio_reevaluation(self):
        self.assertFalse(eligible_prospect({"type":"indie_game_developer", "origin":"discovered", "status":"rejected"}))

    def test_contacted_and_closed_states_are_excluded(self):
        for status in ("contacted", "closed", "suppressed", "replied"):
            with self.subTest(status=status):
                self.assertFalse(eligible_prospect({"type":"animation_studio_support", "origin":"discovered", "status":status}))

if __name__ == "__main__": unittest.main()
