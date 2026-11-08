import tempfile
import unittest
import threading
from email.message import Message
from types import MethodType
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


    def test_controller_requires_per_install_bearer_token(self):
        with tempfile.TemporaryDirectory() as d:
            token_path = Path(d) / "controller.token"
            token_path.write_text("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n", encoding="utf-8")
            instance = controller.WorkerController.__new__(controller.WorkerController)
            instance.token_file = token_path
            self.assertTrue(instance.authenticate("Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"))
            self.assertFalse(instance.authenticate(""))
            self.assertFalse(instance.authenticate("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"))
            self.assertFalse(instance.authenticate("Bearer wrong-token"))
            self.assertFalse(instance.authenticate("Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA extra"))
            token_path.unlink()
            self.assertFalse(instance.authenticate("Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"))

    def test_controller_token_is_not_exposed_by_status_payload(self):
        with tempfile.TemporaryDirectory() as d:
            token_path = Path(d) / "controller.token"
            token_path.write_text("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", encoding="utf-8")
            instance = controller.WorkerController.__new__(controller.WorkerController)
            instance.token_file = token_path
            instance.lock = threading.RLock()
            instance.process = None
            instance.started_at = None
            instance.last_exit_code = None
            instance.last_error = None
            payload = instance.status()
            self.assertNotIn("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", str(payload))
            self.assertNotIn("token", payload)

    def test_http_control_guard_rejects_missing_or_wrong_token(self):
        with tempfile.TemporaryDirectory() as d:
            token_path = Path(d) / "controller.token"
            token_path.write_text("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", encoding="utf-8")
            instance = controller.WorkerController.__new__(controller.WorkerController)
            instance.token_file = token_path
            handler = object.__new__(controller.Handler)
            handler.headers = Message()
            handler.headers["Host"] = f"{controller.HOST}:{controller.PORT}"
            handler.headers["Origin"] = "https://app.studiokairegi.com"
            controller.Handler.controller = instance
            errors = []
            handler._json = MethodType(lambda _self, code, payload: errors.append((code, payload)), handler)
            self.assertFalse(handler._valid_request())
            self.assertEqual(errors[-1][0], 401)
            handler.headers["Authorization"] = "Bearer wrong"
            self.assertFalse(handler._valid_request())
            self.assertEqual(errors[-1][0], 401)
            del handler.headers["Authorization"]
            handler.headers["Authorization"] = "Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
            self.assertTrue(handler._valid_request())
            del handler.headers["Origin"]
            handler.headers["Origin"] = "https://attacker.example"
            self.assertFalse(handler._valid_request())
            self.assertEqual(errors[-1][0], 403)

    def test_remote_ollama_urls_are_not_local(self):
        self.assertTrue(controller.LOCAL_OLLAMA.fullmatch("http://127.0.0.1:11434"))
        self.assertTrue(controller.LOCAL_OLLAMA.fullmatch("http://localhost:11434/"))
        self.assertFalse(controller.LOCAL_OLLAMA.fullmatch("http://192.168.1.5:11434"))
        self.assertFalse(controller.LOCAL_OLLAMA.fullmatch("https://ollama.example.com"))


if __name__ == "__main__":
    unittest.main()
