import unittest
from kairflow_intel.worker_lock import WorkerAlreadyRunning, WorkerProcessLock

class WorkerLockTests(unittest.TestCase):
    def test_second_instance_cannot_acquire_same_machine_lock(self):
        first = WorkerProcessLock("KairFlowWorkerTest").acquire()
        try:
            with self.assertRaises(WorkerAlreadyRunning):
                WorkerProcessLock("KairFlowWorkerTest").acquire()
        finally:
            first.release()

    def test_lock_can_be_reacquired_after_release(self):
        first = WorkerProcessLock("KairFlowWorkerReleaseTest").acquire()
        first.release()
        second = WorkerProcessLock("KairFlowWorkerReleaseTest").acquire()
        second.release()

if __name__ == "__main__":
    unittest.main()
