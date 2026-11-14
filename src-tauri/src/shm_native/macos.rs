//! macOS POSIX mappings and named semaphores for the shared slot protocol.
//! Slot publication is synchronized by sem_post/sem_trywait, on ARM and Intel.
use crate::shm_protocol::*;
use sha2::{Digest, Sha256};
use std::{
    ffi::CString,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    ptr::NonNull,
    sync::atomic::{AtomicU32, Ordering},
    time::{Duration, Instant},
};

fn failure(operation: &str) -> String {
    format!(
        "shared memory {operation}: {}",
        std::io::Error::last_os_error()
    )
}

fn object_name(base: &str) -> Result<CString, String> {
    if base.is_empty()
        || base.len() > 120
        || !base
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("shared-memory name must be an ASCII identifier".into());
    }
    // Darwin semaphore names must fit in 31 bytes, including each suffix.
    let hash = Sha256::digest(base.as_bytes());
    let digest: String = hash[..10].iter().map(|b| format!("{b:02x}")).collect();
    Ok(CString::new(format!("/baas_{digest}")).unwrap())
}

struct MappingName(CString, bool);
impl Drop for MappingName {
    fn drop(&mut self) {
        if self.1 {
            unsafe {
                libc::shm_unlink(self.0.as_ptr());
            }
        }
    }
}

struct Semaphore {
    handle: NonNull<libc::sem_t>,
    name: CString,
    linked: bool,
}
// POSIX semaphore operations are process- and thread-safe.
unsafe impl Send for Semaphore {}
unsafe impl Sync for Semaphore {}
impl Semaphore {
    fn create(base: &CString, suffix: &str, count: u32) -> Result<Self, String> {
        let name = CString::new(format!("{}{suffix}", base.to_str().unwrap())).unwrap();
        let raw = unsafe {
            libc::sem_open(
                name.as_ptr(),
                libc::O_CREAT | libc::O_EXCL,
                0o600 as libc::c_uint,
                count as libc::c_uint,
            )
        };
        if raw == libc::SEM_FAILED {
            return Err(failure("sem_open"));
        }
        Ok(Self {
            handle: NonNull::new(raw).ok_or("sem_open returned null")?,
            name,
            linked: true,
        })
    }
    fn post(&self) -> Result<(), String> {
        if unsafe { libc::sem_post(self.handle.as_ptr()) } != 0 {
            return Err(failure("sem_post"));
        }
        Ok(())
    }
    fn unlink(&self) {
        unsafe {
            libc::sem_unlink(self.name.as_ptr());
        }
    }
}
impl Drop for Semaphore {
    fn drop(&mut self) {
        if self.linked {
            self.unlink();
        }
        unsafe {
            libc::sem_close(self.handle.as_ptr());
        }
    }
}

pub struct NativeSession {
    _fd: OwnedFd,
    name: MappingName,
    view: NonNull<u8>,
    r2p_free: Semaphore,
    r2p_used: Semaphore,
    p2r_free: Semaphore,
    p2r_used: Semaphore,
}
// A producer writes only acquired free slots; a consumer borrows only used slots.
unsafe impl Send for NativeSession {}
unsafe impl Sync for NativeSession {}

impl NativeSession {
    pub fn create(base: &str) -> Result<Self, String> {
        let name = object_name(base)?;
        let raw = unsafe {
            libc::shm_open(
                name.as_ptr(),
                libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
                0o600,
            )
        };
        if raw < 0 {
            return Err(failure("shm_open"));
        }
        let fd = unsafe { OwnedFd::from_raw_fd(raw) };
        let name = MappingName(name, true);
        if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
            return Err(failure("fcntl"));
        }
        if unsafe { libc::ftruncate(fd.as_raw_fd(), REGION_BYTES as libc::off_t) } != 0 {
            return Err(failure("ftruncate"));
        }
        let raw = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                REGION_BYTES,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED,
                fd.as_raw_fd(),
                0,
            )
        };
        if raw == libc::MAP_FAILED {
            return Err(failure("mmap"));
        }
        let view = NonNull::new(raw.cast::<u8>()).unwrap();
        let create = || -> Result<Self, String> {
            let r2p_free = Semaphore::create(&name.0, "_rf", SLOT_COUNT as u32)?;
            let r2p_used = Semaphore::create(&name.0, "_ru", 0)?;
            let p2r_free = Semaphore::create(&name.0, "_pf", SLOT_COUNT as u32)?;
            let p2r_used = Semaphore::create(&name.0, "_pu", 0)?;
            unsafe {
                std::ptr::copy_nonoverlapping(
                    initial_header(std::process::id()).as_ptr(),
                    view.as_ptr(),
                    HEADER_BYTES,
                );
            }
            Ok(Self {
                _fd: fd,
                name,
                view,
                r2p_free,
                r2p_used,
                p2r_free,
                p2r_used,
            })
        };
        match create() {
            Ok(session) => Ok(session),
            Err(error) => {
                unsafe {
                    libc::munmap(raw, REGION_BYTES);
                }
                Err(error)
            }
        }
    }

    fn stopped(&self) -> &AtomicU32 {
        // Aligned shared stop word, disjoint from the immutable wire header.
        unsafe { &*self.view.as_ptr().add(36).cast::<AtomicU32>() }
    }
    pub fn stop(&self) {
        self.stopped().store(1, Ordering::Release);
    }

    pub fn peer_process(&self) -> Result<Option<PeerProcess>, String> {
        let pid = unsafe { std::ptr::read_unaligned(self.view.as_ptr().add(32).cast::<u32>()) };
        if pid == 0 {
            return Err("shared-memory READY omitted the Python process id".into());
        }
        let peer = PeerProcess::new(pid)?;
        // Python unlinks names after attaching all handles, before publishing READY.
        Ok(Some(peer))
    }

    fn acquire(
        &self,
        semaphore: &Semaphore,
        timeout: u32,
        peer: Option<&PeerProcess>,
    ) -> Result<bool, String> {
        let start = Instant::now();
        loop {
            if self.stopped().load(Ordering::Acquire) != 0 {
                return Err("shared-memory session stopped".into());
            }
            if let Some(peer) = peer {
                if peer.exited()? {
                    return Err("shared-memory backend process exited".into());
                }
            }
            if unsafe { libc::sem_trywait(semaphore.handle.as_ptr()) } == 0 {
                if self.stopped().load(Ordering::Acquire) != 0 {
                    return Err("shared-memory session stopped".into());
                }
                return Ok(true);
            }
            let errno = std::io::Error::last_os_error().raw_os_error();
            if !matches!(errno, Some(libc::EAGAIN | libc::EINTR)) {
                return Err(failure("sem_trywait"));
            }
            if timeout != u32::MAX && start.elapsed() >= Duration::from_millis(timeout as u64) {
                return Ok(false);
            }
            // Darwin has no POSIX sem_timedwait. Bound stop/death detection latency
            // without busy spinning or leaving an uninterruptible sem_wait worker.
            std::thread::sleep(Duration::from_millis(1));
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
            let slot = unsafe { self.view.as_ptr().add(HEADER_BYTES + *index * SLOT_BYTES) };
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
            self.view
                .as_ptr()
                .add(HEADER_BYTES + SLOT_COUNT * SLOT_BYTES + *index * SLOT_BYTES)
        };
        let length = unsafe { u32::from_le(std::ptr::read_unaligned(slot.cast::<u32>())) } as usize;
        let result = if length == 0 || length > CHUNK_BYTES {
            Err("shared-memory slot contains an invalid chunk length".into())
        } else {
            consume(unsafe { std::slice::from_raw_parts(slot.add(4), length) })
        };
        self.p2r_free.post()?;
        *index = (*index + 1) % SLOT_COUNT;
        result.map(Some)
    }
}

pub struct PeerProcess {
    queue: OwnedFd,
}
impl PeerProcess {
    fn new(pid: u32) -> Result<Self, String> {
        let raw = unsafe { libc::kqueue() };
        if raw < 0 {
            return Err(failure("kqueue"));
        }
        let queue = unsafe { OwnedFd::from_raw_fd(raw) };
        if unsafe { libc::fcntl(raw, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
            return Err(failure("fcntl(kqueue)"));
        }
        let event = libc::kevent {
            ident: pid as _,
            filter: libc::EVFILT_PROC,
            flags: libc::EV_ADD | libc::EV_ENABLE,
            fflags: libc::NOTE_EXIT,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        if unsafe { libc::kevent(raw, &event, 1, std::ptr::null_mut(), 0, std::ptr::null()) } < 0 {
            return Err(failure("kevent(peer)"));
        }
        Ok(Self { queue })
    }
    fn exited(&self) -> Result<bool, String> {
        let mut event: libc::kevent = unsafe { std::mem::zeroed() };
        let timeout = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        let result = unsafe {
            libc::kevent(
                self.queue.as_raw_fd(),
                std::ptr::null(),
                0,
                &mut event,
                1,
                &timeout,
            )
        };
        if result < 0 {
            if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                return Ok(false);
            }
            return Err(failure("kevent(peer poll)"));
        }
        Ok(result > 0)
    }
}
impl Drop for NativeSession {
    fn drop(&mut self) {
        self.stop();
        let unlinked = unsafe { std::ptr::read_volatile(self.view.as_ptr().add(40).cast::<u32>()) };
        if unlinked != 0 {
            // Never unlink a later generation which reused these now-free names.
            self.name.1 = false;
            for sem in [
                &mut self.r2p_free,
                &mut self.r2p_used,
                &mut self.p2r_free,
                &mut self.p2r_used,
            ] {
                sem.linked = false;
            }
        }
        unsafe {
            libc::munmap(self.view.as_ptr().cast(), REGION_BYTES);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_generation_drop_does_not_unlink_reused_names() {
        let base = format!("baas-shm-test-{}", uuid::Uuid::new_v4());
        let old = NativeSession::create(&base).unwrap();
        // Model an attached peer removing public names before publishing READY.
        unsafe {
            libc::shm_unlink(old.name.0.as_ptr());
        }
        for sem in [&old.r2p_free, &old.r2p_used, &old.p2r_free, &old.p2r_used] {
            sem.unlink();
        }
        unsafe {
            std::ptr::write_volatile(old.view.as_ptr().add(40).cast::<u32>(), 1);
        }
        let next = NativeSession::create(&base).unwrap();
        drop(old);
        assert!(NativeSession::create(&base).is_err());
        drop(next);
        assert!(NativeSession::create(&base).is_ok());
    }
}
