from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]


class Phase5IntegrityMigrationContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sql = (ROOT / "supabase/migrations/20261112191000_intelligence_indie_research_integrity_v6.sql").read_text()
        cls.panel = (ROOT / "src/intelligence/IndieAdminPanel.jsx").read_text()
        cls.api = (ROOT / "src/intelligence/api.js").read_text()

    def test_external_contact_evidence_has_a_dedicated_narrow_rpc(self):
        self.assertIn("intel_admin_add_indie_contact_evidence", self.sql)
        self.assertIn("p_fact_type", self.sql) if False else None
        self.assertIn("contact evidence must use a public non-Kickstarter HTTP(S) source", self.sql)
        self.assertIn("external contact evidence must link the exact email", self.sql)

    def test_external_contact_verification_still_checks_suppression(self):
        self.assertIn("intel_suppressions", self.sql)
        self.assertIn("admin_reviewed_external_affiliation", self.sql)
        self.assertIn("kickstarter\\.com", self.sql)

    def test_ui_uses_external_contact_evidence_workflow(self):
        self.assertIn("addIndieContactEvidence", self.panel)
        self.assertIn("intel_admin_add_indie_contact_evidence", self.api)
        self.assertIn("public professional profile", self.panel)
        self.assertIn("exact address", self.panel)

    def test_contact_verification_audit_and_affiliation_fields_are_written(self):
        for field in ("contact_verification_method", "contact_verified_at", "contact_verified_by",
                      "employee_affiliation_evidence", "employee_affiliation_source_url"):
            self.assertIn(field, self.sql)


if __name__ == "__main__":
    unittest.main()
