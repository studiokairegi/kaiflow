import unittest
from unittest.mock import Mock, patch

from kairflow_intel import main
from kairflow_intel.errors import RpcError


class LivePreflightTests(unittest.TestCase):
    def test_ollama_preflight_checks_both_models_and_schema_output(self):
        cfg = Mock(ollama_model="qwen2.5:3b-instruct", ollama_fast_model="qwen2.5:1.5b-instruct", mail_provider="none")
        llm = Mock()
        llm.list_models.return_value = [cfg.ollama_model, cfg.ollama_fast_model]
        llm.generate_json.return_value = {"ok": True}
        deps = Mock(llm=llm)
        with patch.object(main, "build", return_value=(Mock(), deps)):
            self.assertEqual(main.selftest(cfg, "ollama"), 0)
        self.assertEqual(llm.generate_json.call_count, 2)
        self.assertEqual([c.kwargs["fast"] for c in llm.generate_json.call_args_list], [False, True])

    def test_ollama_preflight_fails_if_configured_model_is_missing(self):
        cfg = Mock(ollama_model="qwen2.5:3b-instruct", ollama_fast_model="qwen2.5:1.5b-instruct", mail_provider="none")
        llm = Mock()
        llm.list_models.return_value = [cfg.ollama_model]
        deps = Mock(llm=llm)
        with patch.object(main, "build", return_value=(Mock(), deps)):
            self.assertEqual(main.selftest(cfg, "ollama"), 1)
        llm.generate_json.assert_called_once()

    def test_supabase_preflight_probes_force_review_signature_without_inserting(self):
        cfg = Mock(mail_provider="none")
        rpc = Mock()
        rpc.side_effect = [
            {"autonomy": "autonomous", "kill_switch": True},
            RpcError("prospect not found", "P0001", 400),
        ]
        deps = Mock(llm=Mock())
        with patch.object(main, "build", return_value=(Mock(), deps)):
            deps.rpc = rpc
            self.assertEqual(main.selftest(cfg, "supabase"), 0)
        probe = rpc.call_args_list[1].args[1]
        self.assertIs(probe["p_force_review"], True)
        self.assertEqual(probe["p_kind"], "initial")

    def test_supabase_preflight_detects_missing_migration_signature(self):
        cfg = Mock(mail_provider="none")
        rpc = Mock(side_effect=[{"autonomy": "assisted", "kill_switch": True}, RpcError("function not found", "PGRST202", 404)])
        deps = Mock(llm=Mock())
        with patch.object(main, "build", return_value=(Mock(), deps)):
            deps.rpc = rpc
            self.assertEqual(main.selftest(cfg, "supabase"), 1)


if __name__ == "__main__":
    unittest.main()
