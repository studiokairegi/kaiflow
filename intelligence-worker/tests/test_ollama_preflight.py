import unittest
from unittest.mock import Mock

from kairflow_intel.ollama import OllamaClient
from kairflow_intel.errors import TransientError


class Response:
    def __init__(self, payload, status=200):
        self.payload, self.status_code = payload, status
    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")
    def json(self):
        return self.payload


class OllamaPreflight(unittest.TestCase):
    def test_list_models_returns_exact_installed_tags(self):
        session = Mock()
        session.get.return_value = Response({"models": [{"name": "qwen2.5:3b-instruct"}, {"name": "qwen2.5:1.5b-instruct"}]})
        cfg = Mock(ollama_url="http://127.0.0.1:11434")
        self.assertEqual(set(OllamaClient(cfg, session).list_models()), {"qwen2.5:3b-instruct", "qwen2.5:1.5b-instruct"})

    def test_malformed_tags_response_fails_closed(self):
        session = Mock()
        session.get.return_value = Response({"unexpected": []})
        cfg = Mock(ollama_url="http://127.0.0.1:11434")
        with self.assertRaises(TransientError):
            OllamaClient(cfg, session).list_models()


if __name__ == "__main__":
    unittest.main()
