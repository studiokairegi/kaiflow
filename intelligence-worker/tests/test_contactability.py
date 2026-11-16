import unittest
from kairflow_intel.contactability import assess


class Contactability(unittest.TestCase):
    def test_published_official_domain_email_is_review_not_verified(self):
        r = assess(email="info@studio.example", official_domain="studio.example",
                   source_url="https://studio.example/contact", verification="website_extracted",
                   verified_email="info@studio.example")
        self.assertEqual(r["status"], "needs_review")
        self.assertEqual(r["evidence"]["deliverability"], "unknown")

    def test_human_confirmed_named_business_email_passes(self):
        r = assess(email="producer@studio.example", official_domain="studio.example",
                   source_url="https://studio.example/company", verification="human_confirmed",
                   verified_email="producer@studio.example", employee_affiliation=True)
        self.assertEqual(r["status"], "pass")

    def test_verified_employee_email_from_third_party_source_passes(self):
        r = assess(email="producer@studio.example", official_domain="studio.example",
                   source_url="https://professional.example/profile/producer",
                   verification="human_confirmed", verified_email="producer@studio.example",
                   employee_affiliation=True)
        self.assertEqual(r["status"], "pass")
        self.assertFalse(r["evidence"]["source_is_official"])
        self.assertTrue(r["evidence"]["employee_affiliation"])
        self.assertEqual(r["evidence"]["deliverability"], "human_confirmed")

    def test_third_party_source_without_employee_affiliation_needs_review(self):
        r = assess(email="producer@studio.example", official_domain="studio.example",
                   source_url="https://professional.example/profile/producer",
                   verification="human_confirmed", verified_email="producer@studio.example",
                   employee_affiliation=False)
        self.assertEqual(r["status"], "needs_review")

    def test_employee_affiliation_without_deliverability_needs_review(self):
        r = assess(email="producer@studio.example", official_domain="studio.example",
                   source_url="https://professional.example/profile/producer",
                   employee_affiliation=True)
        self.assertEqual(r["status"], "needs_review")
        self.assertEqual(r["evidence"]["deliverability"], "unknown")

    def test_generic_address_uses_same_evidence_standard(self):
        r = assess(email="info@studio.example", official_domain="studio.example",
                   source_url="https://studio.example/contact", verification="human_confirmed",
                   verified_email="info@studio.example")
        self.assertEqual(r["status"], "pass")

    def test_provider_delivery_evidence_can_establish_deliverability(self):
        r = assess(email="hello@studio.example", official_domain="studio.example",
                   source_url="https://studio.example/contact", delivery_evidence="delivered")
        self.assertEqual(r["status"], "pass")
        self.assertEqual(r["evidence"]["deliverability"], "provider_delivered")

    def test_invalid_syntax_rejected(self):
        self.assertEqual(assess(email="not-an-email", official_domain="studio.example")["status"], "rejected")

    def test_bounce_and_complaint_rejected(self):
        for kw in ({"bounced": True}, {"complained": True}):
            self.assertEqual(assess(email="info@studio.example", **kw)["status"], "rejected")

    def test_employee_affiliation_does_not_bypass_official_domain_association(self):
        r = assess(email="producer@gmail.com", official_domain="studio.example",
                   source_url="https://professional.example/profile/producer",
                   verification="human_confirmed", verified_email="producer@gmail.com",
                   employee_affiliation=True)
        self.assertEqual(r["status"], "needs_review")
        self.assertFalse(r["evidence"]["official_domain_associated"])

    def test_employee_affiliation_does_not_bypass_domain_for_non_indie_campaign(self):
        r = assess(email="producer@gmail.com", official_domain="studio.example",
                   source_url="https://studio.example/team", verification="human_confirmed",
                   verified_email="producer@gmail.com", employee_affiliation=True)
        self.assertEqual(r["status"], "needs_review")

    def test_indie_personal_email_requires_an_association_source_url(self):
        r = assess(email="maker@gmail.com", official_domain="tinymoon.dev", allow_personal_email=True,
                   verification="human_confirmed", verified_email="maker@gmail.com")
        self.assertEqual(r["status"], "needs_review")
        self.assertIn("source URL", r["reason"])

    def test_verified_personal_email_published_on_official_source_can_pass(self):
        r = assess(email="producer@gmail.com", official_domain="studio.example",
                   source_url="https://studio.example/team", verification="human_confirmed",
                   verified_email="producer@gmail.com", employee_affiliation=True, allow_personal_email=True)
        self.assertEqual(r["status"], "pass")

    def test_gmail_outlook_and_proton_addresses_can_pass_with_official_association(self):
        for address in ("founder@gmail.com", "founder@outlook.com", "founder@proton.me", "founder@protonmail.com"):
            with self.subTest(address=address):
                r = assess(email=address, official_domain="studio.example", source_url="https://studio.example/team",
                           verification="human_confirmed", verified_email=address, employee_affiliation=True,
                           allow_personal_email=True)
                self.assertEqual(r["status"], "pass")

    def test_personal_email_external_affiliation_requires_a_cited_relationship(self):
        r = assess(email="producer@proton.me", official_domain="studio.example",
                   source_url="https://profile.example/producer", verification="human_confirmed",
                   verified_email="producer@proton.me", employee_affiliation=True,
                   affiliation_evidence="producer@proton.me is the founder and developer of Studio Example.",
                   affiliation_source_url="https://profile.example/producer", allow_personal_email=True)
        self.assertEqual(r["status"], "pass")

    def test_suppression_overrides_all_other_verification(self):
        r = assess(email="producer@gmail.com", official_domain="studio.example",
                   source_url="https://studio.example/team", verification="human_confirmed",
                   verified_email="producer@gmail.com", suppressed=True, suppression_reason="unsubscribe", allow_personal_email=True)
        self.assertEqual(r["status"], "rejected")

    def test_dot_atom_local_part_validation(self):
        for address in (".producer@studio.example", "producer.@studio.example", "pro..ducer@studio.example"):
            with self.subTest(address=address):
                self.assertEqual(assess(email=address, official_domain="studio.example")["status"], "rejected")

    def test_valid_dotted_local_part_is_accepted(self):
        r = assess(email="first.last@studio.example", official_domain="studio.example",
                   source_url="https://studio.example/contact", verification="human_confirmed",
                   verified_email="first.last@studio.example")
        self.assertEqual(r["status"], "pass")

    def test_unrelated_email_domain_needs_review(self):
        r = assess(email="producer@other.example", official_domain="studio.example",
                   source_url="https://studio.example/contact", verification="human_confirmed",
                   verified_email="producer@other.example")
        self.assertEqual(r["status"], "needs_review")

    def test_contact_form_only_rejected(self):
        self.assertEqual(assess(contact_form_only=True)["status"], "rejected")

    def test_missing_address_rejected(self):
        self.assertEqual(assess()["status"], "rejected")

    def test_lookalike_host_not_official(self):
        r = assess(email="info@studio.example", official_domain="studio.example",
                   source_url="https://studio.example.attacker.test/contact",
                   verification="human_confirmed", verified_email="info@studio.example")
        self.assertEqual(r["status"], "needs_review")



if __name__ == "__main__":
    unittest.main()
