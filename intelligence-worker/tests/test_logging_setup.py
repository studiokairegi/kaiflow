import sys
import tempfile
import unittest
from pathlib import Path

from kairflow_intel.logging_setup import configure_rotating_logs


class RotatingLogTests(unittest.TestCase):
    def test_stdout_and_stderr_rotate_while_worker_is_running(self):
        old_out, old_err = sys.stdout, sys.stderr

        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / 'worker.log'
            handler = None
            out_stream = None
            err_stream = None

            try:
                handler = configure_rotating_logs(str(log), max_bytes=16, backups=3)
                out_stream = sys.stdout
                err_stream = sys.stderr

                sys.stdout.write('a' * 20 + '\n')
                sys.stdout.write('b' * 20 + '\n')
                sys.stderr.write('error line\n')
                sys.stdout.flush()
                sys.stderr.flush()

                assert log.exists()
                assert Path(str(log) + '.1').exists()
                assert Path(str(log) + '.2').exists()
                assert len(list(Path(tmp).glob('worker.log*'))) <= 4
            finally:
                sys.stdout, sys.stderr = old_out, old_err
                if out_stream is not None:
                    out_stream.flush()
                if err_stream is not None:
                    err_stream.flush()
                if handler is not None:
                    handler.close()


if __name__ == '__main__':
    unittest.main()
