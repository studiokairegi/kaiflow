"""Bounded rotating log stream for worker stdout/stderr."""
from __future__ import annotations

import logging
import logging.handlers
import os
import atexit


class RotatingTextStream:
    def __init__(self, handler: logging.Handler, level: int = logging.INFO):
        self.handler, self.level = handler, level
        self.encoding = "utf-8"
        self.errors = "replace"
        self._buffer = ""

    def _emit(self, line: str) -> None:
        record = logging.LogRecord("kairflow.worker", self.level, "", 0, line, (), None)
        self.handler.handle(record)

    def write(self, value: str) -> int:
        if not isinstance(value, str):
            value = str(value)
        self._buffer += value
        while "\n" in self._buffer:
            line, self._buffer = self._buffer.split("\n", 1)
            self._emit(line.rstrip("\r"))
        return len(value)

    def flush(self) -> None:
        if self._buffer:
            self._emit(self._buffer)
            self._buffer = ""
        self.handler.flush()

    def isatty(self) -> bool:
        return False

    def writable(self) -> bool:
        return True


def configure_rotating_logs(path: str, max_bytes: int = 5 * 1024 * 1024, backups: int = 3):
    import sys
    target = os.path.abspath(os.path.expandvars(path))
    os.makedirs(os.path.dirname(target), exist_ok=True)
    handler = logging.handlers.RotatingFileHandler(target, maxBytes=max_bytes, backupCount=backups, encoding="utf-8", delay=False)
    handler.setFormatter(logging.Formatter("%(message)s"))
    stream = RotatingTextStream(handler)
    error_stream = RotatingTextStream(handler, logging.ERROR)
    sys.stdout = stream
    sys.stderr = error_stream
    def shutdown():
        stream.flush()
        error_stream.flush()
        handler.close()
    atexit.register(shutdown)
    return handler
