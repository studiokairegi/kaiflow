import unittest
from types import SimpleNamespace

from kairflow_intel.providers.base import ProviderManifest, ProviderNotInstalled
from kairflow_intel.providers.registry import ProviderRegistry
from kairflow_intel.providers import build_registry
from kairflow_intel.provider_tokens import ProviderAccountTokenProvider
from kairflow_intel import config


class RegistryTests(unittest.TestCase):
    def test_registry_is_dynamic_and_rejects_duplicate_or_uninstalled_adapters(self):
        registry = ProviderRegistry()
        manifest = ProviderManifest("example-mail", "Example Mail", "1.0.0", frozenset({"send"}),
                                    frozenset({"oauth2"}), frozenset({"business_correspondence"}))
        registry.register(manifest, lambda **kw: kw)
        self.assertEqual(registry.create("example-mail", account_id="a"), {"account_id": "a"})
        self.assertEqual(registry.manifest("example-mail"), manifest)
        with self.assertRaises(ValueError): registry.register(manifest, lambda **kw: kw)
        with self.assertRaises(ProviderNotInstalled): registry.create("not-installed")

    def test_prospect_registry_uses_reviewed_mailbox_adapters_not_resend(self):
        registry = build_registry()
        self.assertIn("gmail", registry.keys())
        self.assertIn("zoho", registry.keys())
        self.assertNotIn("resend", registry.keys())
        self.assertTrue(registry.manifest("gmail").supports_multiple_accounts)
        self.assertTrue(registry.manifest("zoho").supports_multiple_accounts)
        self.assertEqual(registry.manifest("zoho").message_purposes, frozenset({"business_correspondence"}))

    def test_gmail_factory_reuses_same_client_for_any_account_id(self):
        from kairflow_intel.providers.gmail import create_gmail_adapter
        cfg = SimpleNamespace(supabase_url="https://p.supabase.co", supabase_anon_key="anon")
        supa = SimpleNamespace(token=lambda: "jwt")
        first = create_gmail_adapter(cfg=cfg, supa=supa, account_id="11111111-1111-4111-8111-111111111111")
        second = create_gmail_adapter(cfg=cfg, supa=supa, account_id="22222222-2222-4222-8222-222222222222")
        self.assertEqual(first.provider, "gmail")
        self.assertEqual(first.account_id, "11111111-1111-4111-8111-111111111111")
        self.assertEqual(second.account_id, "22222222-2222-4222-8222-222222222222")
        self.assertIs(type(first), type(second))


    def test_zoho_factory_is_account_scoped_and_uses_shared_client(self):
        from kairflow_intel.providers.zoho import create_zoho_adapter
        cfg = SimpleNamespace(supabase_url="https://p.supabase.co", supabase_anon_key="anon")
        supa = SimpleNamespace(token=lambda: "jwt")
        first = create_zoho_adapter(cfg=cfg, supa=supa, account_id="11111111-1111-4111-8111-111111111111")
        second = create_zoho_adapter(cfg=cfg, supa=supa, account_id="22222222-2222-4222-8222-222222222222")
        self.assertEqual(first.provider, "zoho")
        self.assertEqual(first.account_id, "11111111-1111-4111-8111-111111111111")
        self.assertEqual(second.account_id, "22222222-2222-4222-8222-222222222222")
        self.assertIs(type(first), type(second))

    def test_token_provider_is_account_scoped_and_checks_provider_identity(self):
        class Response:
            status_code = 200
            def json(self):
                return {"provider": "gmail", "access_token": "short", "expires_in": 3600,
                        "api_base": "https://gmail.googleapis.com/gmail/v1/", "external_account_id": "me", "mailbox": "a@gmail.com"}
        class Session:
            def __init__(self): self.args = None
            def post(self, *args, **kwargs): self.args = (args, kwargs); return Response()
        session = Session()
        cfg = SimpleNamespace(supabase_url="https://p.supabase.co", supabase_anon_key="anon")
        supa = SimpleNamespace(token=lambda: "jwt")
        provider = ProviderAccountTokenProvider(cfg, supa, "11111111-1111-4111-8111-111111111111", provider="gmail", session=session)
        token = provider.get()
        self.assertEqual(token["mailbox"], "a@gmail.com")
        self.assertEqual(session.args[1]["json"]["account_id"], "11111111-1111-4111-8111-111111111111")
        self.assertNotIn("refresh_token", token)


    def test_zoho_account_token_provider_preserves_data_center_api_base_and_external_id(self):
        class Response:
            status_code = 200
            def json(self):
                return {"provider": "zoho", "access_token": "short", "expires_in": 3600,
                        "api_base": "https://mail.zoho.eu/api", "external_account_id": "98765", "account_id": "98765", "mailbox": "sales@example.com"}
        class Session:
            def post(self, *args, **kwargs): return Response()
        cfg = SimpleNamespace(supabase_url="https://p.supabase.co", supabase_anon_key="anon")
        supa = SimpleNamespace(token=lambda: "jwt")
        provider = ProviderAccountTokenProvider(cfg, supa, "33333333-3333-4333-8333-333333333333", provider="zoho", session=Session())
        token = provider.get()
        self.assertEqual(token["base"], "https://mail.zoho.eu/api")
        self.assertEqual(token["account_id"], "98765")
        self.assertEqual(token["mailbox"], "sales@example.com")
        self.assertNotIn("refresh_token", token)

    def test_config_uses_installed_adapter_registry_and_requires_account_selection(self):
        base = {"KAIRFLOW_SUPABASE_URL": "https://example.supabase.co", "KAIRFLOW_SUPABASE_ANON_KEY": "anon",
                "KAIRFLOW_AGENT_EMAIL": "agent@example.test", "KAIRFLOW_AGENT_PASSWORD": "pw",
                "KAIRFLOW_OLLAMA_URL": "http://127.0.0.1:11434", "KAIRFLOW_MAIL_PROVIDER": "gmail"}
        with self.assertRaises(config.ConfigError): config.load(base)
        cfg = config.load({**base, "KAIRFLOW_MAIL_ACCOUNT_ID": "11111111-1111-4111-8111-111111111111"})
        self.assertEqual(cfg.mail_provider, "gmail")
        self.assertEqual(cfg.mail_account_id, "11111111-1111-4111-8111-111111111111")
        with self.assertRaises(config.ConfigError): config.load({**base, "KAIRFLOW_MAIL_PROVIDER": "future-provider"})

    def test_resend_is_not_accepted_as_a_prospect_adapter(self):
        env = {"KAIRFLOW_SUPABASE_URL": "https://example.supabase.co", "KAIRFLOW_SUPABASE_ANON_KEY": "anon",
               "KAIRFLOW_AGENT_EMAIL": "agent@example.test", "KAIRFLOW_AGENT_PASSWORD": "pw",
               "KAIRFLOW_OLLAMA_URL": "http://127.0.0.1:11434", "KAIRFLOW_MAIL_PROVIDER": "resend"}
        with self.assertRaises(config.ConfigError): config.load(env)


if __name__ == "__main__":
    unittest.main()
