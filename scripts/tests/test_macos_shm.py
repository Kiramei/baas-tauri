"""Native Darwin integration tests. Run with the prepared backend's Python.

BAAS_SHM_TEST_BACKEND=/path/to/BAAS python scripts/tests/test_macos_shm.py
The desktop preflight must have installed its bundled shm_macos.py first.
No device, GUI, network, or game actions are used.
"""
import ctypes
import errno
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import unittest
import uuid

BACKEND = Path(os.environ.get("BAAS_SHM_TEST_BACKEND", Path(__file__).resolve().parents[2] / "target/debug/bundle/macos/BAAS"))
sys.path.insert(0, str(BACKEND))
if sys.platform == "darwin":
    from service.transport.base import ChannelClosed
    from service.transport.shm_native import SharedMemorySession, SLOT_COUNT
    from service.transport.shm_macos import _LIBC, object_name


@unittest.skipUnless(sys.platform == "darwin", "native macOS primitives required")
class MacSharedMemoryTests(unittest.TestCase):
    def pair(self):
        owner = SharedMemorySession.create("baas-test-" + uuid.uuid4().hex)
        self.addCleanup(owner.close)
        peer = SharedMemorySession(owner.base)
        self.addCleanup(peer.close)
        self.assertEqual(type(owner).__name__, "MacSharedMemorySession")
        return owner, peer

    def test_ring_wrap_backpressure_and_both_directions(self):
        owner, peer = self.pair()
        for direction, writer, reader in [("r2p", owner, peer), ("p2r", peer, owner)]:
            for cycle in range(3):
                for index in range(SLOT_COUNT):
                    self.assertTrue(writer.write_chunk(direction, bytes([cycle, index])))
                self.assertFalse(writer.write_chunk(direction, b"full", block=False))
                for index in range(SLOT_COUNT):
                    self.assertEqual(reader.read_chunk(direction), bytes([cycle, index]))
                self.assertIsNone(reader.read_chunk(direction, block=False))

    def test_stop_interrupts_a_blocked_reader(self):
        owner, peer = self.pair()
        stopped = threading.Event()
        def read():
            try:
                peer.read_chunk("r2p")
            except ChannelClosed:
                stopped.set()
        thread = threading.Thread(target=read, daemon=True)
        thread.start()
        owner.stop()
        thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertTrue(stopped.is_set())

    def test_stop_interrupts_a_blocked_writer(self):
        owner, peer = self.pair()
        for _ in range(SLOT_COUNT):
            owner.write_chunk("r2p", b"full")
        stopped = threading.Event()
        def write():
            try:
                owner.write_chunk("r2p", b"blocked")
            except ChannelClosed:
                stopped.set()
        thread = threading.Thread(target=write, daemon=True)
        thread.start()
        peer.stop()
        thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertTrue(stopped.is_set())

    def test_kernel_names_are_removed_after_attach(self):
        owner, _ = self.pair()
        name = object_name(owner.base)
        fd = _LIBC.shm_open(name, os.O_RDWR, ctypes.c_uint(0))
        if fd >= 0:
            os.close(fd)
        self.assertEqual(fd, -1)
        self.assertEqual(ctypes.get_errno(), errno.ENOENT)
        for suffix in (b"_rf", b"_ru", b"_pf", b"_pu"):
            self.assertLess(len(name + suffix), 31)
            sem = _LIBC.sem_open(name + suffix, 0)
            if sem not in (None, ctypes.c_void_p(-1).value):
                _LIBC.sem_close(sem)
            self.assertIn(sem, (None, ctypes.c_void_p(-1).value))

    def test_creator_failure_does_not_unlink_an_existing_session(self):
        base = "baas-test-" + uuid.uuid4().hex
        owner = SharedMemorySession.create(base)
        try:
            with self.assertRaises(FileExistsError):
                SharedMemorySession.create(base)
            peer = SharedMemorySession(base)
            peer.close()
        finally:
            owner.close()

    def test_old_generation_cleanup_does_not_remove_new_names(self):
        old, peer = self.pair()
        new = SharedMemorySession.create(old.base)
        self.addCleanup(new.close)
        peer.close()
        old.close()
        new_peer = SharedMemorySession(new.base)
        self.addCleanup(new_peer.close)
        new.write_chunk("r2p", b"new generation")
        self.assertEqual(new_peer.read_chunk("r2p"), b"new generation")

    def test_owner_exit_interrupts_a_waiter(self):
        base = "baas-test-" + uuid.uuid4().hex
        code = "import sys;sys.path.insert(0,sys.argv[1]);from service.transport.shm_native import SharedMemorySession; s=SharedMemorySession.create(sys.argv[2]);print('ready',flush=True);sys.stdin.read()"
        child = subprocess.Popen([sys.executable, "-c", code, str(BACKEND), base], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        peer = None
        try:
            self.assertEqual(child.stdout.readline().strip(), "ready")
            peer = SharedMemorySession(base)
            child.kill()
            # Intentionally do not reap first: kqueue must also detect a zombie.
            start = time.monotonic()
            with self.assertRaisesRegex(ChannelClosed, "owner process exited"):
                peer.read_chunk("r2p")
            self.assertLess(time.monotonic() - start, 2)
        finally:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)
            child.stdin.close()
            child.stdout.close()
            if peer is not None:
                peer.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
