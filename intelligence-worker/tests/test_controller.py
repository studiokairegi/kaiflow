import tempfile
import unittest
from pathlib import Path

from kairflow_intel import config  # noqa: F401 - confirms worker package remains importable

# controller.py is intentionally a standalone stdlib module beside the package.
import importlib.util

CONTROLLER_PATH = Path(__file__).resolve().parents[1] / "controller.py"
spec = importlib.util.spec_from_file_location("kairflow_local_controller", CONTROLLER_PATH)
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)


class ControllerSecurityTests(unittest.TestCase):
    def test_only_exact_app_origins_are_allowed(self):
        self.assertTrue(controller.allowed_origin("https://app.studiokairegi.com"))
        self.assertTrue(controller.allowed_origin("http://localhost:5173"))
        self.assertFalse(controller.allowed_origin("https://studiokairegi.com"))
        self.assertFalse(controller.allowed_origin("https://app.studiokairegi.com.attacker.test"))
        self.assertFalse(controller.allowed_origin("null"))
        self.assertFalse(controller.allowed_origin(None))

    def test_env_reader_does_not_evaluate_shell_syntax(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "worker.env"
            path.write_text("# comment\nA=plain\nB=\"quoted value\"\nC=$(whoami)\nnot a key=x\n", encoding="utf-8")
            self.assertEqual(controller.read_env_file(path), {"A": "plain", "B": "quoted value", "C": "$(whoami)"})

    def test_remote_ollama_urls_are_not_local(self):
        self.assertTrue(controller.LOCAL_OLLAMA.fullmatch("http://127.0.0.1:11434"))
        self.assertTrue(controller.LOCAL_OLLAMA.fullmatch("http://localhost:11434/"))
        self.assertFalse(controller.LOCAL_OLLAMA.fullmatch("http://192.168.1.5:11434"))
        self.assertFalse(controller.LOCAL_OLLAMA.fullmatch("https://ollama.example.com"))


if __name__ == "__main__":
    unittest.main()
