import unittest
from pathlib import Path

from kairflow_intel import scoring
from kairflow_intel.errors import PermanentError
from kairflow_intel import research

ROOT = Path(__file__).resolve().parents[2]


def ev(kind, url="https://game.example/page"):
    return {"id": kind, "fact_type": kind, "url": url, "snippet": f"verified {kind}", "verified": True}


def meta(**extra):
    return {"developer_name": "Tiny Moon Studio", "prospect_name": "Tiny Moon Studio",
            "contact_email": "maker@game.example", "project_title": "Moonlit Blade",
            "project_url": "https://tiny-moon.itch.io/moonlit-blade", "source": "itch", "source_key": "itch",
            "developer_identity_status": "platform_creator_unverified", "coming_soon": True,
            **extra}


def contact():
    return {"status": "pass", "verified_email": "maker@game.example",
            "evidence": {"source_url": "https://game.example/contact"}}


class IndieCampaignAuditFixTests(unittest.TestCase):
    def test_itch_creator_requires_independent_identity_verification(self):
        rows = [ev("project_description"), ev("devlog", "https://game.example/devlog"),
                ev("anime_visual_screenshot", "https://cdn.example/a.png")]
        result = scoring.score_indie({}, meta(), None, evidence_rows=rows,
                                     contactability_result=contact(), suppression={})
        self.assertFalse(result.mandatory_gates["project_identity"]["passed"])
        verified = scoring.score_indie({}, meta(developer_identity_status="independently_verified"), None,
                                       evidence_rows=rows, contactability_result=contact(), suppression={})
        self.assertTrue(verified.mandatory_gates["project_identity"]["passed"])

    def test_kickstarter_fetch_boundary_rejects_before_network_call(self):
        class Fetch:
            called = False
            def fetch(self, url):
                self.called = True
                raise AssertionError("must not fetch Kickstarter")
        fetch = Fetch()
        p = {"id": "p", "type": "indie_game_developer", "website": "",
             "project_source_url": "https://www.kickstarter.com/projects/team/game"}
        with self.assertRaises(PermanentError):
            research.research(lambda *_: {}, fetch, lambda *_: {}, {"prospect": p})
        self.assertFalse(fetch.called)

    def test_domain_suppression_hardening_migration_covers_parent_domains_at_send(self):
        sql = (ROOT / "supabase/migrations/20270101100000_intelligence_indie_campaign_safety_hardening.sql").read_text().lower()
        self.assertIn("_intel_indie_domain_matches", sql)
        self.assertIn("like '%.'", sql)
        self.assertIn("before update of state on public.intel_messages", sql)
        self.assertIn("new.state in ('reserved', 'sending')", sql)
        self.assertIn("suppression:domain:' || v_suffix", sql)

    def test_followup_candidates_require_active_indie_campaign(self):
        sql = (ROOT / "supabase/migrations/20270101101000_intelligence_indie_pause_followups.sql").read_text().lower()
        self.assertIn("p.type <> 'indie_game_developer' or campaign.status = 'active'", sql)

    def test_indie_discovery_profile_is_not_rendered_for_indie_campaign(self):
        source = (ROOT / "src/intelligence/CampaignView.jsx").read_text()
        self.assertIn('type === "animation_studio_support" && <DiscoveryProfile', source)
        self.assertNotIn('<DiscoveryProfile campaign={c}', source.replace('{type === "animation_studio_support" && <DiscoveryProfile campaign={c} supabase={supabase} onChanged={async () => { await camps.reload(); await onChanged(); }} />}', ''))

    def test_research_refresh_uses_stable_source_signature_for_existing_projects(self):
        source = (ROOT / "intelligence-worker/kairflow_intel/jobs.py").read_text()
        self.assertIn('research:{r[\'prospect_id\']}:refresh:{signature}', source)
        self.assertIn('"last_discovered_at", "cursor"', source)


if __name__ == "__main__":
    unittest.main()
