"""Cross-mode, per-machine singleton lock for the Intelligence worker."""
from __future__ import annotations

import ctypes
import ctypes.wintypes
import os
import tempfile

ERROR_ALREADY_EXISTS = 183


class WorkerAlreadyRunning(RuntimeError):
    pass


class WorkerProcessLock:
    def __init__(self, name: str = "KairFlowIntelligenceWorker"):
        self.name = name
        self.handle = None
        self.file = None
        self.kernel32 = None

    def acquire(self) -> "WorkerProcessLock":
        if os.name == "nt":
            self._acquire_windows()
        else:
            self._acquire_posix()
        return self

    def _acquire_windows(self) -> None:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
        class SECURITY_ATTRIBUTES(ctypes.Structure):
            _fields_ = [("nLength", ctypes.wintypes.DWORD), ("lpSecurityDescriptor", ctypes.wintypes.LPVOID), ("bInheritHandle", ctypes.wintypes.BOOL)]
        descriptor = ctypes.wintypes.LPVOID()
        sddl = "D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;AU)"
        convert = advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW
        convert.argtypes = [ctypes.wintypes.LPCWSTR, ctypes.wintypes.DWORD, ctypes.POINTER(ctypes.wintypes.LPVOID), ctypes.POINTER(ctypes.wintypes.DWORD)]
        convert.restype = ctypes.wintypes.BOOL
        if not convert(sddl, 1, ctypes.byref(descriptor), None):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            local_free = kernel32.LocalFree
            local_free.argtypes = [ctypes.wintypes.HANDLE]
            local_free.restype = ctypes.wintypes.HANDLE
            attrs = SECURITY_ATTRIBUTES(ctypes.sizeof(SECURITY_ATTRIBUTES), descriptor, False)
            create = kernel32.CreateMutexW
            create.argtypes = [ctypes.POINTER(SECURITY_ATTRIBUTES), ctypes.wintypes.BOOL, ctypes.wintypes.LPCWSTR]
            create.restype = ctypes.wintypes.HANDLE
            ctypes.set_last_error(0)
            handle = create(ctypes.byref(attrs), True, "Global\\" + self.name)
            if not handle:
                raise ctypes.WinError(ctypes.get_last_error())
            if ctypes.get_last_error() == ERROR_ALREADY_EXISTS:
                kernel32.CloseHandle(handle)
                raise WorkerAlreadyRunning("Another KairFlow Intelligence worker instance already owns the machine-wide lock.")
            self.handle, self.kernel32 = handle, kernel32
        finally:
            kernel32.LocalFree(descriptor)

    def _acquire_posix(self) -> None:
        import fcntl
        safe_name = "".join(ch for ch in self.name.lower() if ch.isalnum() or ch in "-_ ").strip().replace(" ", "-")
        path = os.path.join(tempfile.gettempdir(), f"{safe_name or 'kairflow-worker'}.lock")
        f = open(path, "a+b")
        try:
            fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            f.close()
            raise WorkerAlreadyRunning("Another KairFlow Intelligence worker instance already owns the process lock.") from exc
        self.file = f

    def release(self) -> None:
        if self.handle:
            self.kernel32.ReleaseMutex(self.handle)
            self.kernel32.CloseHandle(self.handle)
            self.handle = None
        if self.file:
            import fcntl
            fcntl.flock(self.file.fileno(), fcntl.LOCK_UN)
            self.file.close()
            self.file = None

    def __enter__(self):
        return self.acquire()

    def __exit__(self, *_):
        self.release()
