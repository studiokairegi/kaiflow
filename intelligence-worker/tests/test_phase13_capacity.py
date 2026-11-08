import json
import importlib.util
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock

from kairflow_intel.errors import PermanentError, TransientError
from kairflow_intel.ollama import OllamaClient

ROOT = Path(__file__).resolve().parents[1]
BENCHMARK_PATH = ROOT / "scripts" / "phase13_ollama_benchmark.py"
_spec = importlib.util.spec_from_file_location("phase13_ollama_benchmark", BENCHMARK_PATH)
benchmark = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(benchmark)


class Response:
    def __init__(self, status=200, payload=None):
        self.status_code = status
        self.payload = payload or {"message": {"content": json.dumps({"ok": True})}}
    def json(self):
        return self.payload


class Phase13BenchmarkHarnessTests(unittest.TestCase):
    def test_retention_diagnostics_sql_is_read_only(self):
        sql = (ROOT.parent / "supabase" / "diagnostics" / "phase13_retention_diagnostics.sql").read_text(encoding="utf-8")
        statements = "\n".join(line for line in sql.splitlines() if not line.lstrip().startswith("--")).upper()
        import re
        statements = re.sub(r"/\*.*?\*/", " ", statements, flags=re.S)
        self.assertNotRegex(statements, r"\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|VACUUM|REINDEX)\b")
        self.assertGreaterEqual(statements.count("SELECT"), 6)

    def test_benchmark_response_validator_accepts_valid_contract(self):
        value = {"language": "ja", "summary": "要約", "facts": ["事実"], "subject": "件名", "body": "本文"}
        self.assertEqual(benchmark.validate_benchmark_output(value), value)

    def test_benchmark_response_validator_rejects_wrong_types_and_language(self):
        valid = {"language": "en", "summary": "ok", "facts": [], "subject": "", "body": ""}
        for field, bad in (("language", "fr"), ("summary", 3), ("facts", ["ok", 2]), ("subject", None), ("body", [])):
            with self.subTest(field=field):
                value = dict(valid); value[field] = bad
                with self.assertRaises(ValueError):
                    benchmark.validate_benchmark_output(value)

    def test_benchmark_response_validator_rejects_oversize_and_extra_fields(self):
        valid = {"language": "en", "summary": "ok", "facts": [], "subject": "", "body": ""}
        for field, value in (("summary", "x" * 501), ("subject", "x" * 121), ("body", "x" * 1801)):
            with self.subTest(field=field):
                candidate = dict(valid); candidate[field] = value
                with self.assertRaises(ValueError):
                    benchmark.validate_benchmark_output(candidate)
        candidate = dict(valid, unexpected=True)
        with self.assertRaises(ValueError):
            benchmark.validate_benchmark_output(candidate)
        with self.assertRaises(ValueError):
            benchmark.validate_benchmark_output([valid])
        missing = dict(valid); missing.pop("body")
        with self.assertRaises(ValueError):
            benchmark.validate_benchmark_output(missing)
        self.assertIs(benchmark.SCHEMA["additionalProperties"], False)

    def test_benchmark_url_allows_only_loopback_http(self):
        for url in ("http://127.0.0.1:11434", "http://localhost:11434", "http://[::1]:11434", "http://127.12.1.2:11434"):
            with self.subTest(url=url):
                self.assertTrue(benchmark.validate_local_ollama_url(url).startswith("http://"))
        for url in ("https://localhost:11434", "http://example.com:11434", "http://192.168.1.20:11434", "http://user@localhost:11434", "http://localhost:11434/proxy", "http://localhost:99999"):
            with self.subTest(url=url):
                with self.assertRaises(ValueError):
                    benchmark.validate_local_ollama_url(url)

    def test_cli_rejects_remote_url_even_in_self_test_mode(self):
        result = subprocess.run([sys.executable, str(BENCHMARK_PATH), "--self-test", "--url", "http://example.com:11434"], capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("remote Ollama hosts are blocked", result.stderr)

    def test_benchmark_definition_self_test_is_offline(self):
        result = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "phase13_ollama_benchmark.py"), "--self-test"],
            capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("no network access", result.stdout)


class OllamaFailureClassificationTests(unittest.TestCase):
    def setUp(self):
        self.cfg = Mock(ollama_url="http://127.0.0.1:11434", ollama_model="main", ollama_fast_model="fast")
        self.schema = {"type": "object", "required": ["ok"], "properties": {"ok": {"type": "boolean"}}}

    def test_timeout_is_transient_and_retryable(self):
        import requests
        session = Mock()
        session.post.side_effect = requests.ReadTimeout("slow local model")
        with self.assertRaises(TransientError):
            OllamaClient(self.cfg, session).generate_json("instruction", "synthetic", self.schema)

    def test_429_and_5xx_are_transient(self):
        for status in (429, 500, 503):
            with self.subTest(status=status):
                session = Mock(); session.post.return_value = Response(status)
                with self.assertRaises(TransientError):
                    OllamaClient(self.cfg, session).generate_json("instruction", "synthetic", self.schema)

    def test_client_error_is_permanent(self):
        session = Mock(); session.post.return_value = Response(400)
        with self.assertRaises(PermanentError):
            OllamaClient(self.cfg, session).generate_json("instruction", "synthetic", self.schema)

    def test_malformed_structured_output_is_transient(self):
        session = Mock(); session.post.return_value = Response(200, {"message": {"content": "not json"}})
        with self.assertRaises(TransientError):
            OllamaClient(self.cfg, session).generate_json("instruction", "synthetic", self.schema)


if __name__ == "__main__":
    unittest.main()
