"""Darwin adapter for BAASSHM1; uses the same slots/frames as Windows.

Only the platform primitives differ. The wire decoder, stream routing, byte
budgets, and backpressure remain those of the backend's shared-memory transport.
"""
from __future__ import annotations

import ctypes
import errno
import hashlib
import mmap
import os
import select
import threading
import time

from .base import ChannelClosed
from .shm_native import (
    SharedMemorySession as _WindowsSession,
    HEADER, MAGIC, VERSION, HEADER_BYTES, SLOT_COUNT, SLOT_BYTES,
    MAX_PAYLOAD_BYTES, MAPPING_BYTES, _U32,
)

_LIBC = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
# Darwin declares shm_open as variadic too. Declaring mode as a fixed argument
# passes it in the wrong location on Apple Silicon and creates mode-000 objects.
_LIBC.shm_open.argtypes = [ctypes.c_char_p, ctypes.c_int]
_LIBC.shm_open.restype = ctypes.c_int
_LIBC.shm_unlink.argtypes = [ctypes.c_char_p]
_LIBC.shm_unlink.restype = ctypes.c_int
# sem_open is variadic: two required arguments, followed by mode/value on create.
_LIBC.sem_open.argtypes = [ctypes.c_char_p, ctypes.c_int]
_LIBC.sem_open.restype = ctypes.c_void_p
for _name in ("sem_trywait", "sem_post", "sem_close"):
    getattr(_LIBC, _name).argtypes = [ctypes.c_void_p]
    getattr(_LIBC, _name).restype = ctypes.c_int
_LIBC.sem_unlink.argtypes = [ctypes.c_char_p]
_LIBC.sem_unlink.restype = ctypes.c_int
_SUFFIXES = {"r2p_free": "_rf", "r2p_used": "_ru", "p2r_free": "_pf", "p2r_used": "_pu"}


def object_name(base: str) -> bytes:
    if not base or len(base) > 120 or not all(c.isascii() and (c.isalnum() or c in "-_") for c in base):
        raise ValueError("Shared-memory name must be an ASCII identifier")
    # Keep the longest name below Darwin's 31-byte semaphore name limit.
    return ("/baas_" + hashlib.sha256(base.encode("ascii")).hexdigest()[:20]).encode("ascii")


def _error(operation: str) -> OSError:
    number = ctypes.get_errno()
    return OSError(number, f"Shared memory {operation}: {os.strerror(number)}")


class MacSharedMemorySession(_WindowsSession):
    def __init__(self, base: str, *, create: bool = False, owner_pid: int | None = None) -> None:
        self.base = base
        self._closed = False
        self._view = None
        self._fd = None
        self._owner_queue = None
        self._owner_dead = False
        self._owner_lock = threading.Lock()
        self._semaphores = {}
        self._owned_names = []
        self._owns_mapping_name = False
        self._name = object_name(base)
        self._indices = {(d, r): 0 for d in ("r2p", "p2r") for r in ("read", "write")}
        try:
            flags = os.O_RDWR | (os.O_CREAT | os.O_EXCL if create else 0)
            fd = _LIBC.shm_open(self._name, flags, ctypes.c_uint(0o600))
            if fd < 0:
                raise _error("shm_open")
            self._fd = fd
            os.set_inheritable(fd, False)
            self._owns_mapping_name = create
            if create:
                os.ftruncate(fd, MAPPING_BYTES)
            stat = os.fstat(fd)
            page_bytes = os.sysconf("SC_PAGE_SIZE")
            rounded_bytes = ((MAPPING_BYTES + page_bytes - 1) // page_bytes) * page_bytes
            # Darwin reports the shm object's page-rounded allocation size (16K
            # pages on Apple Silicon, commonly 4K on Intel), not ftruncate's size.
            if stat.st_uid != os.getuid() or not MAPPING_BYTES <= stat.st_size <= rounded_bytes:
                raise ValueError("Shared-memory mapping has invalid ownership or size")
            self._view = mmap.mmap(fd, MAPPING_BYTES, flags=mmap.MAP_SHARED, prot=mmap.PROT_READ | mmap.PROT_WRITE)
            if create:
                self._write(0, HEADER.pack(MAGIC, VERSION, HEADER_BYTES, SLOT_COUNT, SLOT_BYTES,
                                          MAX_PAYLOAD_BYTES, owner_pid or os.getpid()))
            header = HEADER.unpack(self._read(0, HEADER.size))
            if header[:6] != (MAGIC, VERSION, HEADER_BYTES, SLOT_COUNT, SLOT_BYTES, MAX_PAYLOAD_BYTES):
                raise ValueError("Shared-memory header does not match protocol version 1")
            self.owner_pid = header[6]
            self._owner_queue = select.kqueue()
            self._owner_queue.control([select.kevent(self.owner_pid, filter=select.KQ_FILTER_PROC,
                                      flags=select.KQ_EV_ADD | select.KQ_EV_ENABLE,
                                      fflags=select.KQ_NOTE_EXIT)], 0, 0)
            for key, suffix in _SUFFIXES.items():
                name = self._name + suffix.encode("ascii")
                initial = SLOT_COUNT if key.endswith("free") else 0
                handle = (_LIBC.sem_open(name, os.O_CREAT | os.O_EXCL,
                                        ctypes.c_uint(0o600), ctypes.c_uint(initial)) if create else
                          _LIBC.sem_open(name, 0))
                if handle is None or handle == ctypes.c_void_p(-1).value:
                    raise _error("sem_open")
                self._semaphores[key] = handle
                if create:
                    self._owned_names.append(name)
            if not create:
                # Every handle is now open on both sides. Names can go away even
                # while mappings/sem handles remain live, avoiding crash orphans.
                _LIBC.shm_unlink(self._name)
                for suffix in _SUFFIXES.values():
                    _LIBC.sem_unlink(self._name + suffix.encode("ascii"))
                # Tell the creator not to unlink the same names again on close:
                # a new generation may already have reused them by that time.
                self._write(40, _U32.pack(1))
        except BaseException:
            self.close()
            raise

    def _read(self, offset: int, length: int) -> bytes:
        return self._view[offset:offset + length]

    def _write(self, offset: int, payload: bytes) -> None:
        self._view[offset:offset + len(payload)] = payload

    def new_wake_event(self):
        return threading.Semaphore(0)

    def wake(self, event) -> None:
        event.release()

    def wait_for_wake(self, event) -> None:
        self._acquire(event, 0xFFFFFFFF)

    def _check_live(self) -> None:
        if self._closed or _U32.unpack(self._read(36, 4))[0]:
            raise ChannelClosed("Shared-memory session stopped")
        # A dedicated lock also makes owner-death detection persistent if two
        # workers check the queue at the same time, or the owner becomes a zombie.
        with self._owner_lock:
            if not self._owner_dead:
                self._owner_dead = bool(self._owner_queue.control(None, 1, 0))
            if self._owner_dead:
                raise ChannelClosed("Shared-memory owner process exited")

    def _acquire(self, semaphore, timeout: int) -> bool:
        deadline = None if timeout == 0xFFFFFFFF else time.monotonic() + timeout / 1000
        while True:
            self._check_live()
            if isinstance(semaphore, threading.Semaphore):
                acquired = semaphore.acquire(blocking=False)
            else:
                result = _LIBC.sem_trywait(semaphore)
                acquired = result == 0
                if not acquired and ctypes.get_errno() not in (errno.EAGAIN, errno.EINTR):
                    raise _error("sem_trywait")
            if acquired:
                self._check_live()
                return True
            if deadline is not None and time.monotonic() >= deadline:
                return False
            # macOS has no sem_timedwait. Avoid spinning or an uninterruptible
            # sem_wait while still noticing stop/owner death promptly.
            time.sleep(0.001)

    def _release(self, key: str) -> None:
        if _LIBC.sem_post(self._semaphores[key]) != 0:
            raise _error("sem_post")

    def stop(self) -> None:
        if not self._closed and self._view is not None:
            self._write(36, _U32.pack(1))

    def close(self) -> None:
        """Call only after stopping and joining all workers, like the Win32 peer."""
        if self._closed:
            return
        self._closed = True
        if self._owner_queue is not None:
            self._owner_queue.close()
            self._owner_queue = None
        if self._view is not None:
            if _U32.unpack(self._read(40, 4))[0]:
                self._owns_mapping_name = False
                self._owned_names.clear()
            self._view.close()
            self._view = None
        if self._fd is not None:
            os.close(self._fd)
            self._fd = None
        for handle in self._semaphores.values():
            _LIBC.sem_close(handle)
        self._semaphores.clear()
        for name in self._owned_names:
            _LIBC.sem_unlink(name)
        if self._owns_mapping_name:
            _LIBC.shm_unlink(self._name)
