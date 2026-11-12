from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "supabase/migrations/20261112180000_intelligence_indie_research_verification_v5.sql"


class IndieResearchMigrationContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sql = MIGRATION.read_text(encoding="utf-8").lower()

    def test_admin_identity_rpc_requires_two_admin_reviewed_evidence_types(self):
        self.assertIn("intel_admin_verify_indie_identity", self.sql)
        self.assertIn("source='admin_review' and fact_type='developer_identity'", self.sql)
        self.assertIn("source='admin_review' and fact_type='project_identity'", self.sql)
        self.assertIn("independently_verified", self.sql)
        self.assertIn("creator role is only recorded for kickstarter manual imports", self.sql)

    def test_kickstarter_urls_are_rejected_as_identity_evidence_sources(self):
        self.assertIn("v_url ~* 'kickstarter\\.com'", self.sql)
        self.assertIn("v_domain = public._intel_indie_domain(p.website)", self.sql)

    def test_contact_verification_requires_exact_email_in_reviewed_evidence(self):
        self.assertIn("intel_admin_verify_indie_contact", self.sql)
        self.assertIn("position(v_email in lower(e.snippet))=0", self.sql)
        self.assertIn("contact_verification','human_confirmed'", self.sql)

    def test_contact_verification_checks_suppression_before_update(self):
        self.assertIn("from public.intel_suppressions s", self.sql)
        self.assertIn("suppressed, bounced, complained or opted-out email cannot be verified", self.sql)

    def test_visual_review_and_dated_evidence_are_explicit_admin_actions(self):
        self.assertIn("anime_visual_screenshot", self.sql)
        self.assertIn("anime_visual_artwork", self.sql)
        self.assertIn("anime_visual_trailer", self.sql)
        self.assertIn("dated evidence requires an explicit event date", self.sql)

    def test_all_new_admin_rpcs_are_authenticated_only(self):
        for name in ("intel_admin_add_indie_evidence", "intel_admin_verify_indie_identity", "intel_admin_verify_indie_contact"):
            self.assertRegex(self.sql, rf"revoke all on function public\.{name}\(")
            self.assertRegex(self.sql, rf"grant execute on function public\.{name}\(")
            self.assertNotRegex(self.sql, rf"grant execute on function public\.{name}\([^;]* to anon")
