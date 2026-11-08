import os
import sys
import tempfile
import unittest
from pathlib import Path
from kairflow_intel.logging_setup import configure_rotating_logs

class RotatingLogTests(unittest.TestCase):
    def test_stdout_and_stderr_rotate_while_worker_is_running(self):
        old_out, old_err = sys.stdout, sys.stderr
        try:
            with tempfile.TemporaryDirectory() as tmp:
                log = Path(tmp) / "worker.log"
                configure_rotating_logs(str(log), max_bytes=16, backups=3)
                sys.stdout.write("a" * 20 + "\n")
                sys.stdout.write("b" * 20 + "\n")
                sys.stderr.write("error line\n")
                sys.stdout.flush(); sys.stderr.flush()
                self.assertTrue(log.exists())
                self.assertTrue(Path(str(log) + ".1").exists())
                self.assertTrue(Path(str(log) + ".2").exists())
                self.assertLessEqual(len(list(Path(tmp).glob("worker.log*"))), 4)
        finally:
            sys.stdout, sys.stderr = old_out, old_err

if __name__ == "__main__":
    unittest.main()
