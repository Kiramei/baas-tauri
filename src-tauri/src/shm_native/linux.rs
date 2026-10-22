//! POSIX shared memory and named semaphores for the same fixed-slot wire format
//! used on Windows. The Rust owner alone unlinks generation-scoped resources.
use crate::shm_protocol::*;
use std::{
    ffi::CString,
    io,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    ptr::NonNull,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const WAIT_SLICE: Duration = Duration::from_millis(50);

fn failure(operation: &str, error: impl std::fmt::Display) -> String {
    format!("shared memory {operation}: {error}")
}

fn identifier(base: &str) -> Result<CString, String> {
    if base.is_empty()
        || base.len() > 120
        || !base
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("shared-memory name must be an ASCII identifier".into());
    }
    Ok(CString::new(format!("/{base}")).expect("validated ASCII identifier"))
}

struct Mapping {
    name: CString,
    linked: AtomicBool,
    _fd: OwnedFd,
    view: NonNull<u8>,
}

impl Mapping {
    fn create(name: CString) -> Result<Self, String> {
        let fd = unsafe {
            libc::shm_open(
                name.as_ptr(),
                libc::O_CREAT | libc::O_EXCL | libc::O_RDWR | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd == -1 {
            return Err(failure("shm_open(create)", io::Error::last_os_error()));
        }
        let fd = unsafe { OwnedFd::from_raw_fd(fd) };
        let result = (|| {
            if unsafe { libc::ftruncate(fd.as_raw_fd(), REGION_BYTES as libc::off_t) } == -1 {
                return Err(failure("ftruncate", io::Error::last_os_error()));
            }
            let mapped = unsafe {
                libc::mmap(
                    std::ptr::null_mut(),
                    REGION_BYTES,
                    libc::PROT_READ | libc::PROT_WRITE,
                    libc::MAP_SHARED,
                    fd.as_raw_fd(),
                    0,
                )
            };
            if mapped == libc::MAP_FAILED {
                return Err(failure("mmap", io::Error::last_os_error()));
            }
            match NonNull::new(mapped.cast::<u8>()) {
                Some(view) => Ok(view),
                None => {
                    unsafe { libc::munmap(mapped, REGION_BYTES) };
                    Err("shared memory mmap returned a null address".into())
                }
            }
        })();
        match result {
            Ok(view) => Ok(Self {
                name,
                linked: AtomicBool::new(true),
                _fd: fd,
                view,
            }),
            Err(error) => {
                // Only unlink after our exclusive creation succeeded.
                unsafe { libc::shm_unlink(name.as_ptr()) };
                Err(error)
            }
        }
    }

    fn unlink(&self) -> Result<(), String> {
        if !self.linked.swap(false, Ordering::AcqRel) {
            return Ok(());
        }
        if unsafe { libc::shm_unlink(self.name.as_ptr()) } == -1
            && io::Error::last_os_error().raw_os_error() != Some(libc::ENOENT)
        {
            let error = io::Error::last_os_error();
            self.linked.store(true, Ordering::Release);
            return Err(failure("shm_unlink", error));
        }
        Ok(())
    }
}

impl Drop for Mapping {
    fn drop(&mut self) {
        unsafe {
            libc::munmap(self.view.as_ptr().cast(), REGION_BYTES);
        }
        let _ = self.unlink();
    }
}

struct Semaphore {
    name: CString,
    linked: AtomicBool,
    handle: NonNull<libc::sem_t>,
}

impl Semaphore {
    fn create(base: &str, suffix: &str, initial: u32) -> Result<Self, String> {
        let name = CString::new(format!("/{base}_{suffix}"))
            .expect("validated identifier and static suffix");
        let handle = unsafe {
            libc::sem_open(
                name.as_ptr(),
                libc::O_CREAT | libc::O_EXCL,
                0o600 as libc::mode_t,
                initial as libc::c_uint,
            )
        };
        if handle == libc::SEM_FAILED {
            return Err(failure("sem_open(create)", io::Error::last_os_error()));
        }
        Ok(Self {
            name,
            linked: AtomicBool::new(true),
            handle: NonNull::new(handle).expect("successful sem_open returns a semaphore"),
        })
    }

    fn post(&self) -> Result<(), String> {
        if unsafe { libc::sem_post(self.handle.as_ptr()) } == -1 {
            Err(failure("sem_post", io::Error::last_os_error()))
        } else {
            Ok(())
        }
    }

    fn unlink(&self) -> Result<(), String> {
        if !self.linked.swap(false, Ordering::AcqRel) {
            return Ok(());
        }
        if unsafe { libc::sem_unlink(self.name.as_ptr()) } == -1
            && io::Error::last_os_error().raw_os_error() != Some(libc::ENOENT)
        {
            let error = io::Error::last_os_error();
            self.linked.store(true, Ordering::Release);
            return Err(failure("sem_unlink", error));
        }
        Ok(())
    }

    fn try_wait(&self) -> Result<bool, String> {
        loop {
            if unsafe { libc::sem_trywait(self.handle.as_ptr()) } == 0 {
                return Ok(true);
            }
            match io::Error::last_os_error().raw_os_error() {
                Some(libc::EINTR) => continue,
                Some(libc::EAGAIN) => return Ok(false),
                _ => return Err(failure("sem_trywait", io::Error::last_os_error())),
            }
        }
    }

    fn wait_slice(&self, duration: Duration) -> Result<bool, String> {
        // sem_timedwait uses CLOCK_REALTIME. Overall deadlines below use the
        // monotonic clock so interruptions cannot continually extend a timeout.
        let deadline = SystemTime::now()
            .checked_add(duration)
            .ok_or_else(|| "shared-memory wait deadline overflow".to_string())?
            .duration_since(UNIX_EPOCH)
            .map_err(|error| failure("clock", error))?;
        let deadline = libc::timespec {
            tv_sec: deadline.as_secs() as libc::time_t,
            tv_nsec: deadline.subsec_nanos() as libc::c_long,
        };
        if unsafe { libc::sem_timedwait(self.handle.as_ptr(), &deadline) } == 0 {
            return Ok(true);
        }
        match io::Error::last_os_error().raw_os_error() {
            Some(libc::EINTR | libc::ETIMEDOUT) => Ok(false),
            _ => Err(failure("sem_timedwait", io::Error::last_os_error())),
        }
    }

    fn signaled(&self) -> Result<bool, String> {
        // The stop semaphore is a manual-reset event: nobody consumes it.
        // sem_getvalue's only possible value is a nonnegative stop count.
        let mut count = 0;
        if unsafe { libc::sem_getvalue(self.handle.as_ptr(), &mut count) } == -1 {
            Err(failure("sem_getvalue(stop)", io::Error::last_os_error()))
        } else {
            Ok(count > 0)
        }
    }
}

impl Drop for Semaphore {
    fn drop(&mut self) {
        unsafe {
            libc::sem_close(self.handle.as_ptr());
        }
        let _ = self.unlink();
    }
}

pub struct NativeSession {
    mapping: Mapping,
    stop: Semaphore,
    locally_stopped: AtomicBool,
    r2p_free: Semaphore,
    r2p_used: Semaphore,
    p2r_free: Semaphore,
    p2r_used: Semaphore,
}

// The writer and reader own independent ring indices and disjoint slot ranges.
// sem_wait/post publish data across processes before a peer borrows a slot.
unsafe impl Send for NativeSession {}
unsafe impl Sync for NativeSession {}

impl NativeSession {
    pub fn create(base: &str) -> Result<Self, String> {
        let mapping = Mapping::create(identifier(base)?)?;
        let stop = Semaphore::create(base, "stop", 0)?;
        let r2p_free = Semaphore::create(base, "r2p_free", SLOT_COUNT as u32)?;
        let r2p_used = Semaphore::create(base, "r2p_used", 0)?;
        let p2r_free = Semaphore::create(base, "p2r_free", SLOT_COUNT as u32)?;
        let p2r_used = Semaphore::create(base, "p2r_used", 0)?;
        unsafe {
            std::ptr::copy_nonoverlapping(
                initial_header(std::process::id()).as_ptr(),
                mapping.view.as_ptr(),
                HEADER_BYTES,
            );
        }
        Ok(Self {
            mapping,
            stop,
            locally_stopped: AtomicBool::new(false),
            r2p_free,
            r2p_used,
            p2r_free,
            p2r_used,
        })
    }

    pub fn stop(&self) {
        if !self.locally_stopped.swap(true, Ordering::AcqRel) {
            let _ = self.stop.post();
        }
    }

    pub fn peer_process(&self) -> Result<Option<PeerProcess>, String> {
        // Python writes this once before publishing READY via the semaphore.
        let pid = unsafe {
            u32::from_le(std::ptr::read_unaligned(
                self.mapping.view.as_ptr().add(32).cast::<u32>(),
            ))
        };
        let peer = PeerProcess::open(pid)?;
        // READY guarantees Python has opened every object. Unlink the names
        // now; the kernel retains the resources until both processes close
        // them, including when either process subsequently crashes.
        self.mapping.unlink()?;
        for semaphore in [
            &self.stop,
            &self.r2p_free,
            &self.r2p_used,
            &self.p2r_free,
            &self.p2r_used,
        ] {
            semaphore.unlink()?;
        }
        Ok(Some(peer))
    }

    fn check_active(&self, peer: Option<&PeerProcess>) -> Result<(), String> {
        if self.locally_stopped.load(Ordering::Acquire) || self.stop.signaled()? {
            return Err("shared-memory session stopped".into());
        }
        if let Some(peer) = peer {
            if peer.exited()? {
                return Err("shared-memory backend process exited".into());
            }
        }
        Ok(())
    }

    fn acquire(
        &self,
        semaphore: &Semaphore,
        timeout: u32,
        peer: Option<&PeerProcess>,
    ) -> Result<bool, String> {
        let deadline = if timeout == u32::MAX {
            None
        } else {
            Some(Instant::now() + Duration::from_millis(timeout as u64))
        };
        loop {
            self.check_active(peer)?;
            let acquired = if timeout == 0 {
                semaphore.try_wait()?
            } else {
                let remaining = deadline
                    .map(|deadline| deadline.saturating_duration_since(Instant::now()))
                    .unwrap_or(WAIT_SLICE);
                if remaining.is_zero() {
                    return Ok(false);
                }
                semaphore.wait_slice(remaining.min(WAIT_SLICE))?
            };
            if acquired {
                // Preserve ownership if cancellation wins the race with a post.
                if let Err(error) = self.check_active(peer) {
                    semaphore.post()?;
                    return Err(error);
                }
                return Ok(true);
            }
            if timeout == 0 {
                return Ok(false);
            }
        }
    }

    pub fn write_message(
        &self,
        index: &mut usize,
        stream: u32,
        kind: u8,
        payload: &[u8],
    ) -> Result<(), String> {
        let header = message_header(stream, kind, payload.len())?;
        let mut parts = [header.as_slice(), payload];
        let mut part = 0;
        while part < parts.len() {
            if !self.acquire(&self.r2p_free, 15_000, None)? {
                return Err(
                    "shared-memory writer timed out waiting for backend to release a slot".into(),
                );
            }
            let slot = unsafe {
                self.mapping
                    .view
                    .as_ptr()
                    .add(HEADER_BYTES + *index * SLOT_BYTES)
            };
            let mut length = 0;
            while part < parts.len() && length < CHUNK_BYTES {
                let count = (CHUNK_BYTES - length).min(parts[part].len());
                unsafe {
                    std::ptr::copy_nonoverlapping(
                        parts[part].as_ptr(),
                        slot.add(4 + length),
                        count,
                    );
                }
                length += count;
                parts[part] = &parts[part][count..];
                if parts[part].is_empty() {
                    part += 1;
                }
            }
            unsafe {
                std::ptr::write_unaligned(slot.cast::<u32>(), (length as u32).to_le());
            }
            self.r2p_used.post()?;
            *index = (*index + 1) % SLOT_COUNT;
        }
        Ok(())
    }

    pub fn read_chunk<T>(
        &self,
        index: &mut usize,
        wait: bool,
        peer: Option<&PeerProcess>,
        consume: impl FnOnce(&[u8]) -> Result<T, String>,
    ) -> Result<Option<T>, String> {
        if !self.acquire(&self.p2r_used, if wait { u32::MAX } else { 0 }, peer)? {
            return Ok(None);
        }
        let slot = unsafe {
            self.mapping
                .view
                .as_ptr()
                .add(HEADER_BYTES + SLOT_COUNT * SLOT_BYTES + *index * SLOT_BYTES)
        };
        let length = unsafe { u32::from_le(std::ptr::read_unaligned(slot.cast::<u32>())) } as usize;
        let result = if length == 0 || length > CHUNK_BYTES {
            Err("shared-memory slot contains an invalid chunk length".into())
        } else {
            consume(unsafe { std::slice::from_raw_parts(slot.add(4), length) })
        };
        // Decoding failure must not strand a borrowed slot.
        self.p2r_free.post()?;
        *index = (*index + 1) % SLOT_COUNT;
        result.map(Some)
    }
}

impl Drop for NativeSession {
    fn drop(&mut self) {
        self.stop();
    }
}

pub struct PeerProcess {
    pid: libc::pid_t,
    pidfd: Option<OwnedFd>,
    start_time: Option<u64>,
}

fn process_start_time(pid: libc::pid_t) -> Result<Option<u64>, String> {
    let stat = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(failure("read peer process identity", error)),
    };
    // comm (field 2) may contain spaces and parentheses; split at its final ')'.
    let fields = stat
        .rsplit_once(')')
        .ok_or_else(|| "shared-memory peer process stat is malformed".to_string())?
        .1
        .split_whitespace()
        .collect::<Vec<_>>();
    if fields
        .first()
        .is_some_and(|state| matches!(*state, "Z" | "X" | "x"))
    {
        return Ok(None);
    }
    fields
        .get(19)
        .ok_or_else(|| "shared-memory peer process identity is missing".to_string())?
        .parse::<u64>()
        .map(Some)
        .map_err(|error| failure("parse peer process identity", error))
}

impl PeerProcess {
    fn open(pid: u32) -> Result<Self, String> {
        let pid = libc::pid_t::try_from(pid)
            .ok()
            .filter(|pid| *pid > 0)
            .ok_or_else(|| "shared-memory READY omitted a valid Python process id".to_string())?;
        let descriptor = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0u32) };
        let pidfd = if descriptor >= 0 {
            Some(unsafe { OwnedFd::from_raw_fd(descriptor as libc::c_int) })
        } else {
            match io::Error::last_os_error().raw_os_error() {
                Some(libc::ENOSYS | libc::EINVAL | libc::EPERM | libc::EACCES) => None,
                Some(libc::ESRCH) => {
                    return Err("shared-memory backend process exited".into());
                }
                _ => return Err(failure("pidfd_open(peer)", io::Error::last_os_error())),
            }
        };
        let start_time = if pidfd.is_none() {
            Some(
                process_start_time(pid)?
                    .ok_or_else(|| "shared-memory backend process exited".to_string())?,
            )
        } else {
            None
        };
        let peer = Self {
            pid,
            pidfd,
            start_time,
        };
        if peer.exited()? {
            return Err("shared-memory backend process exited".into());
        }
        Ok(peer)
    }

    fn exited(&self) -> Result<bool, String> {
        if let Some(pidfd) = &self.pidfd {
            let mut descriptor = libc::pollfd {
                fd: pidfd.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            loop {
                let result = unsafe { libc::poll(&mut descriptor, 1, 0) };
                if result >= 0 {
                    return Ok(result > 0);
                }
                if io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
                    return Err(failure("poll(peer pidfd)", io::Error::last_os_error()));
                }
            }
        }
        Ok(process_start_time(self.pid)? != self.start_time)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        process::Command,
        sync::{Arc, Barrier},
    };

    fn base() -> String {
        format!("baas-shm-rust-test-{}", uuid::Uuid::new_v4())
    }

    fn assert_missing(base: &str, suffix: Option<&str>) {
        let name = CString::new(match suffix {
            Some(suffix) => format!("/{base}_{suffix}"),
            None => format!("/{base}"),
        })
        .unwrap();
        if suffix.is_some() {
            let handle = unsafe { libc::sem_open(name.as_ptr(), 0) };
            assert_eq!(handle, libc::SEM_FAILED, "semaphore leaked");
        } else {
            let fd = unsafe { libc::shm_open(name.as_ptr(), libc::O_RDWR, 0) };
            assert_eq!(fd, -1, "shared-memory mapping leaked");
        }
        assert_eq!(
            io::Error::last_os_error().raw_os_error(),
            Some(libc::ENOENT)
        );
    }

    #[test]
    fn exclusive_creation_preserves_live_generation_and_drop_unlinks() {
        let base = base();
        let session = NativeSession::create(&base).unwrap();
        assert!(NativeSession::create(&base).is_err());
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        assert_eq!(
            unsafe { libc::fstat(session.mapping._fd.as_raw_fd(), stat.as_mut_ptr()) },
            0
        );
        assert_eq!(unsafe { stat.assume_init() }.st_mode & 0o777, 0o600);
        let header =
            unsafe { std::slice::from_raw_parts(session.mapping.view.as_ptr(), HEADER_BYTES) };
        assert_eq!(header, initial_header(std::process::id()));
        drop(session);
        assert_missing(&base, None);
        for suffix in ["stop", "r2p_free", "r2p_used", "p2r_free", "p2r_used"] {
            assert_missing(&base, Some(suffix));
        }
    }

    #[test]
    fn partial_creation_cleans_only_owned_resources() {
        let base = base();
        let collision = Semaphore::create(&base, "r2p_used", 0).unwrap();
        assert!(NativeSession::create(&base).is_err());
        assert_missing(&base, None);
        assert_missing(&base, Some("stop"));
        assert_missing(&base, Some("r2p_free"));
        collision.post().unwrap();
        assert!(collision.try_wait().unwrap());
        drop(collision);
        assert_missing(&base, Some("r2p_used"));
    }

    #[test]
    fn ready_unlinks_live_resources_and_old_drop_preserves_new_generation() {
        let base = base();
        let session = NativeSession::create(&base).unwrap();
        unsafe {
            std::ptr::write_unaligned(
                session.mapping.view.as_ptr().add(32).cast::<u32>(),
                std::process::id().to_le(),
            );
        }
        let peer = session.peer_process().unwrap().unwrap();
        assert_missing(&base, None);
        for suffix in ["stop", "r2p_free", "r2p_used", "p2r_free", "p2r_used"] {
            assert_missing(&base, Some(suffix));
        }
        session
            .write_message(&mut 0, 1, 2, b"still mapped")
            .unwrap();
        assert!(session.r2p_used.try_wait().unwrap());
        assert!(!peer.exited().unwrap());
        let next_generation = NativeSession::create(&base).unwrap();
        drop(session);
        assert!(NativeSession::create(&base).is_err());
        next_generation
            .write_message(&mut 0, 1, 2, b"new generation")
            .unwrap();
        drop(next_generation);
        assert_missing(&base, None);
        assert_missing(&base, Some("stop"));
    }

    #[test]
    fn stop_wakes_blocked_reader_and_full_ring_writer() {
        let session = Arc::new(NativeSession::create(&base()).unwrap());
        let mut index = 0;
        for _ in 0..SLOT_COUNT {
            session.write_message(&mut index, 1, 2, b"full").unwrap();
        }
        let (done, results) = std::sync::mpsc::channel();
        let started = Arc::new(Barrier::new(3));
        let reader = Arc::clone(&session);
        let reader_done = done.clone();
        let reader_started = Arc::clone(&started);
        let reader = std::thread::spawn(move || {
            reader_started.wait();
            let result = reader.read_chunk(&mut 0, true, None, |_| Ok(()));
            reader_done.send(result.map(|_| ())).unwrap();
        });
        let writer = Arc::clone(&session);
        let writer_started = Arc::clone(&started);
        let writer = std::thread::spawn(move || {
            writer_started.wait();
            done.send(writer.write_message(&mut index, 1, 2, b"blocked"))
                .unwrap();
        });
        started.wait();
        assert_eq!(
            results.recv_timeout(Duration::from_millis(100)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        );
        session.stop();
        session.stop();
        for _ in 0..2 {
            assert!(results
                .recv_timeout(Duration::from_secs(1))
                .unwrap()
                .unwrap_err()
                .contains("stopped"));
        }
        reader.join().unwrap();
        writer.join().unwrap();
    }

    #[test]
    fn bounded_wait_expires_without_spending_or_inventing_a_slot() {
        let session = NativeSession::create(&base()).unwrap();
        let started = Instant::now();
        assert!(!session.acquire(&session.p2r_used, 30, None).unwrap());
        assert!(started.elapsed() >= Duration::from_millis(30));
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(!session.p2r_used.try_wait().unwrap());
    }

    #[test]
    fn invalid_chunk_releases_slot_and_empty_read_is_nonblocking() {
        let session = NativeSession::create(&base()).unwrap();
        let mut index = 0;
        assert_eq!(
            session
                .read_chunk(&mut index, false, None, |_| Ok(()))
                .unwrap(),
            None
        );
        assert!(session.p2r_free.try_wait().unwrap());
        session.p2r_used.post().unwrap();
        assert!(session
            .read_chunk(&mut index, true, None, |_| Ok(()))
            .unwrap_err()
            .contains("invalid chunk"));
        assert_eq!(index, 1);
        for _ in 0..SLOT_COUNT {
            assert!(session.p2r_free.try_wait().unwrap());
        }
        assert!(!session.p2r_free.try_wait().unwrap());
    }

    #[test]
    fn process_exit_interrupts_reader_and_fallback_detects_exit() {
        let session = NativeSession::create(&base()).unwrap();
        let mut child = Command::new("sleep").arg("30").spawn().unwrap();
        let peer = PeerProcess::open(child.id()).unwrap();
        let fallback = PeerProcess {
            pid: child.id() as libc::pid_t,
            pidfd: None,
            start_time: process_start_time(child.id() as libc::pid_t).unwrap(),
        };
        assert!(!peer.exited().unwrap());
        assert!(!fallback.exited().unwrap());
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(session
            .read_chunk(&mut 0, true, Some(&peer), |_| Ok(()))
            .unwrap_err()
            .contains("process exited"));
        assert!(fallback.exited().unwrap());
    }
}
