use std::{fmt, time::Duration};
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum NativeIpcError {
    #[error("shared-memory region size must be greater than zero")]
    InvalidRegionSize,
    #[error("operation timed out")]
    TimedOut,
    #[error("native IPC is not implemented on this platform")]
    UnsupportedPlatform,
    #[error("{operation} failed: {message}")]
    Platform {
        operation: &'static str,
        message: String,
    },
}

#[cfg(windows)]
mod windows_impl {
    use super::{fmt, Duration, NativeIpcError};
    use std::{ffi::c_void, ptr::NonNull};
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT},
            System::{
                Memory::{
                    CreateFileMappingW, MapViewOfFile, OpenFileMappingW, UnmapViewOfFile,
                    FILE_MAP_ALL_ACCESS, MEMORY_MAPPED_VIEW_ADDRESS, PAGE_READWRITE,
                },
                Threading::{
                    CreateEventW, OpenEventW, SetEvent, WaitForSingleObject, EVENT_MODIFY_STATE,
                    SYNCHRONIZATION_SYNCHRONIZE,
                },
            },
        },
    };

    #[derive(Debug)]
    pub struct SharedMemoryRegion {
        handle: HANDLE,
        view: NonNull<u8>,
        len: usize,
        name: String,
    }

    unsafe impl Send for SharedMemoryRegion {}
    unsafe impl Sync for SharedMemoryRegion {}

    impl SharedMemoryRegion {
        pub fn create(name: &str, len: usize) -> Result<Self, NativeIpcError> {
            if len == 0 {
                return Err(NativeIpcError::InvalidRegionSize);
            }
            let name_wide = wide_null(name);
            let size = u64::try_from(len).map_err(|error| NativeIpcError::Platform {
                operation: "CreateFileMappingW",
                message: error.to_string(),
            })?;
            let handle = unsafe {
                CreateFileMappingW(
                    INVALID_HANDLE_VALUE,
                    None,
                    PAGE_READWRITE,
                    (size >> 32) as u32,
                    size as u32,
                    PCWSTR(name_wide.as_ptr()),
                )
            }
            .map_err(|error| platform_error("CreateFileMappingW", error))?;
            Self::map_handle(handle, name, len)
        }

        pub fn open(name: &str, len: usize) -> Result<Self, NativeIpcError> {
            if len == 0 {
                return Err(NativeIpcError::InvalidRegionSize);
            }
            let name_wide = wide_null(name);
            let handle = unsafe {
                OpenFileMappingW(FILE_MAP_ALL_ACCESS.0, false, PCWSTR(name_wide.as_ptr()))
            }
            .map_err(|error| platform_error("OpenFileMappingW", error))?;
            Self::map_handle(handle, name, len)
        }

        pub fn as_slice(&self) -> &[u8] {
            unsafe { std::slice::from_raw_parts(self.view.as_ptr(), self.len) }
        }

        pub fn as_mut_slice(&mut self) -> &mut [u8] {
            unsafe { std::slice::from_raw_parts_mut(self.view.as_ptr(), self.len) }
        }

        pub fn len(&self) -> usize {
            self.len
        }

        pub fn is_empty(&self) -> bool {
            self.len == 0
        }

        pub fn name(&self) -> &str {
            &self.name
        }

        fn map_handle(handle: HANDLE, name: &str, len: usize) -> Result<Self, NativeIpcError> {
            let view = unsafe { MapViewOfFile(handle, FILE_MAP_ALL_ACCESS, 0, 0, len) };
            let Some(view) = NonNull::new(view.Value as *mut u8) else {
                unsafe {
                    let _ = CloseHandle(handle);
                }
                return Err(NativeIpcError::Platform {
                    operation: "MapViewOfFile",
                    message: windows::core::Error::from_thread().message().to_string(),
                });
            };
            Ok(Self {
                handle,
                view,
                len,
                name: name.to_string(),
            })
        }
    }

    impl Drop for SharedMemoryRegion {
        fn drop(&mut self) {
            unsafe {
                let _ = UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS {
                    Value: self.view.as_ptr() as *mut c_void,
                });
                let _ = CloseHandle(self.handle);
            }
        }
    }

    pub struct NotificationEvent {
        handle: HANDLE,
        name: String,
    }

    unsafe impl Send for NotificationEvent {}
    unsafe impl Sync for NotificationEvent {}

    impl fmt::Debug for NotificationEvent {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter
                .debug_struct("NotificationEvent")
                .field("name", &self.name)
                .finish_non_exhaustive()
        }
    }

    impl NotificationEvent {
        pub fn create(name: &str) -> Result<Self, NativeIpcError> {
            let name_wide = wide_null(name);
            let handle = unsafe { CreateEventW(None, false, false, PCWSTR(name_wide.as_ptr())) }
                .map_err(|error| platform_error("CreateEventW", error))?;
            Ok(Self {
                handle,
                name: name.to_string(),
            })
        }

        pub fn open(name: &str) -> Result<Self, NativeIpcError> {
            let name_wide = wide_null(name);
            let handle = unsafe {
                OpenEventW(
                    SYNCHRONIZATION_SYNCHRONIZE | EVENT_MODIFY_STATE,
                    false,
                    PCWSTR(name_wide.as_ptr()),
                )
            }
            .map_err(|error| platform_error("OpenEventW", error))?;
            Ok(Self {
                handle,
                name: name.to_string(),
            })
        }

        pub fn set(&self) -> Result<(), NativeIpcError> {
            unsafe { SetEvent(self.handle) }.map_err(|error| platform_error("SetEvent", error))
        }

        pub fn wait(&self, timeout: Duration) -> Result<(), NativeIpcError> {
            let millis = timeout.as_millis().min(u128::from(u32::MAX)) as u32;
            let result = unsafe { WaitForSingleObject(self.handle, millis) };
            if result == WAIT_OBJECT_0 {
                Ok(())
            } else if result == WAIT_TIMEOUT {
                Err(NativeIpcError::TimedOut)
            } else {
                Err(NativeIpcError::Platform {
                    operation: "WaitForSingleObject",
                    message: windows::core::Error::from_thread().message().to_string(),
                })
            }
        }
    }

    impl Drop for NotificationEvent {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.handle);
            }
        }
    }

    fn platform_error(operation: &'static str, error: windows::core::Error) -> NativeIpcError {
        NativeIpcError::Platform {
            operation,
            message: error.message().to_string(),
        }
    }

    fn wide_null(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }
}

#[cfg(windows)]
pub use windows_impl::{NotificationEvent, SharedMemoryRegion};

#[cfg(all(unix, not(target_os = "android"), not(target_os = "ios")))]
mod posix_impl {
    use super::{fmt, Duration, NativeIpcError};
    use std::{
        ffi::CString,
        ptr::NonNull,
        thread,
        time::{Duration as StdDuration, Instant},
    };

    #[derive(Debug)]
    pub struct SharedMemoryRegion {
        fd: libc::c_int,
        view: NonNull<u8>,
        len: usize,
        name: String,
        owner: bool,
    }

    unsafe impl Send for SharedMemoryRegion {}
    unsafe impl Sync for SharedMemoryRegion {}

    impl SharedMemoryRegion {
        pub fn create(name: &str, len: usize) -> Result<Self, NativeIpcError> {
            if len == 0 {
                return Err(NativeIpcError::InvalidRegionSize);
            }
            let name_c = c_name(name, "shm_open")?;
            let fd = unsafe {
                libc::shm_open(
                    name_c.as_ptr(),
                    libc::O_CREAT | libc::O_EXCL | libc::O_RDWR,
                    0o600,
                )
            };
            if fd < 0 {
                return Err(last_os_error("shm_open"));
            }
            let len_i64 = i64::try_from(len).map_err(|error| NativeIpcError::Platform {
                operation: "ftruncate",
                message: error.to_string(),
            })?;
            if unsafe { libc::ftruncate(fd, len_i64 as libc::off_t) } != 0 {
                let error = last_os_error("ftruncate");
                unsafe {
                    libc::close(fd);
                    libc::shm_unlink(name_c.as_ptr());
                }
                return Err(error);
            }
            Self::map_fd(fd, name, len, true)
        }

        pub fn open(name: &str, len: usize) -> Result<Self, NativeIpcError> {
            if len == 0 {
                return Err(NativeIpcError::InvalidRegionSize);
            }
            let name_c = c_name(name, "shm_open")?;
            let fd = unsafe { libc::shm_open(name_c.as_ptr(), libc::O_RDWR, 0o600) };
            if fd < 0 {
                return Err(last_os_error("shm_open"));
            }
            Self::map_fd(fd, name, len, false)
        }

        pub fn as_slice(&self) -> &[u8] {
            unsafe { std::slice::from_raw_parts(self.view.as_ptr(), self.len) }
        }

        pub fn as_mut_slice(&mut self) -> &mut [u8] {
            unsafe { std::slice::from_raw_parts_mut(self.view.as_ptr(), self.len) }
        }

        pub fn len(&self) -> usize {
            self.len
        }

        pub fn is_empty(&self) -> bool {
            self.len == 0
        }

        pub fn name(&self) -> &str {
            &self.name
        }

        fn map_fd(
            fd: libc::c_int,
            name: &str,
            len: usize,
            owner: bool,
        ) -> Result<Self, NativeIpcError> {
            let view = unsafe {
                libc::mmap(
                    std::ptr::null_mut(),
                    len,
                    libc::PROT_READ | libc::PROT_WRITE,
                    libc::MAP_SHARED,
                    fd,
                    0,
                )
            };
            if view == libc::MAP_FAILED {
                let error = last_os_error("mmap");
                unsafe {
                    libc::close(fd);
                    if owner {
                        if let Ok(name_c) = c_name(name, "shm_unlink") {
                            libc::shm_unlink(name_c.as_ptr());
                        }
                    }
                }
                return Err(error);
            }
            let Some(view) = NonNull::new(view.cast::<u8>()) else {
                unsafe {
                    libc::munmap(view, len);
                    libc::close(fd);
                }
                return Err(NativeIpcError::Platform {
                    operation: "mmap",
                    message: "mmap returned a null address".to_string(),
                });
            };
            Ok(Self {
                fd,
                view,
                len,
                name: name.to_string(),
                owner,
            })
        }
    }

    impl Drop for SharedMemoryRegion {
        fn drop(&mut self) {
            unsafe {
                libc::munmap(self.view.as_ptr().cast(), self.len);
                libc::close(self.fd);
                if self.owner {
                    if let Ok(name_c) = c_name(&self.name, "shm_unlink") {
                        libc::shm_unlink(name_c.as_ptr());
                    }
                }
            }
        }
    }

    pub struct NotificationEvent {
        sem: NonNull<libc::sem_t>,
        name: String,
        owner: bool,
    }

    unsafe impl Send for NotificationEvent {}
    unsafe impl Sync for NotificationEvent {}

    impl fmt::Debug for NotificationEvent {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter
                .debug_struct("NotificationEvent")
                .field("name", &self.name)
                .finish_non_exhaustive()
        }
    }

    impl NotificationEvent {
        pub fn create(name: &str) -> Result<Self, NativeIpcError> {
            let name_c = c_name(name, "sem_open")?;
            let sem =
                unsafe { libc::sem_open(name_c.as_ptr(), libc::O_CREAT | libc::O_EXCL, 0o600, 0) };
            if sem == libc::SEM_FAILED {
                return Err(last_os_error("sem_open"));
            }
            Ok(Self {
                sem: NonNull::new(sem).ok_or_else(|| NativeIpcError::Platform {
                    operation: "sem_open",
                    message: "sem_open returned null".to_string(),
                })?,
                name: name.to_string(),
                owner: true,
            })
        }

        pub fn open(name: &str) -> Result<Self, NativeIpcError> {
            let name_c = c_name(name, "sem_open")?;
            let sem = unsafe { libc::sem_open(name_c.as_ptr(), 0) };
            if sem == libc::SEM_FAILED {
                return Err(last_os_error("sem_open"));
            }
            Ok(Self {
                sem: NonNull::new(sem).ok_or_else(|| NativeIpcError::Platform {
                    operation: "sem_open",
                    message: "sem_open returned null".to_string(),
                })?,
                name: name.to_string(),
                owner: false,
            })
        }

        pub fn set(&self) -> Result<(), NativeIpcError> {
            if unsafe { libc::sem_post(self.sem.as_ptr()) } == 0 {
                Ok(())
            } else {
                Err(last_os_error("sem_post"))
            }
        }

        pub fn wait(&self, timeout: Duration) -> Result<(), NativeIpcError> {
            let deadline = Instant::now() + timeout;
            loop {
                if unsafe { libc::sem_trywait(self.sem.as_ptr()) } == 0 {
                    return Ok(());
                }
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::EINTR) {
                    continue;
                }
                if error.raw_os_error() != Some(libc::EAGAIN) {
                    return Err(NativeIpcError::Platform {
                        operation: "sem_trywait",
                        message: error.to_string(),
                    });
                }
                let now = Instant::now();
                if now >= deadline {
                    return Err(NativeIpcError::TimedOut);
                }
                let remaining = deadline.saturating_duration_since(now);
                thread::sleep(remaining.min(StdDuration::from_millis(10)));
            }
        }
    }

    impl Drop for NotificationEvent {
        fn drop(&mut self) {
            unsafe {
                libc::sem_close(self.sem.as_ptr());
                if self.owner {
                    if let Ok(name_c) = c_name(&self.name, "sem_unlink") {
                        libc::sem_unlink(name_c.as_ptr());
                    }
                }
            }
        }
    }

    fn c_name(name: &str, operation: &'static str) -> Result<CString, NativeIpcError> {
        CString::new(name).map_err(|error| NativeIpcError::Platform {
            operation,
            message: error.to_string(),
        })
    }

    fn last_os_error(operation: &'static str) -> NativeIpcError {
        NativeIpcError::Platform {
            operation,
            message: std::io::Error::last_os_error().to_string(),
        }
    }
}

#[cfg(all(unix, not(target_os = "android"), not(target_os = "ios")))]
pub use posix_impl::{NotificationEvent, SharedMemoryRegion};

#[cfg(not(any(windows, all(unix, not(target_os = "android"), not(target_os = "ios")))))]
#[derive(Debug)]
pub struct SharedMemoryRegion;

#[cfg(not(any(windows, all(unix, not(target_os = "android"), not(target_os = "ios")))))]
impl SharedMemoryRegion {
    pub fn create(_name: &str, _len: usize) -> Result<Self, NativeIpcError> {
        Err(NativeIpcError::UnsupportedPlatform)
    }

    pub fn open(_name: &str, _len: usize) -> Result<Self, NativeIpcError> {
        Err(NativeIpcError::UnsupportedPlatform)
    }

    pub fn as_slice(&self) -> &[u8] {
        &[]
    }

    pub fn as_mut_slice(&mut self) -> &mut [u8] {
        &mut []
    }

    pub fn len(&self) -> usize {
        0
    }

    pub fn is_empty(&self) -> bool {
        true
    }

    pub fn name(&self) -> &str {
        ""
    }
}

#[cfg(not(any(windows, all(unix, not(target_os = "android"), not(target_os = "ios")))))]
#[derive(Debug)]
pub struct NotificationEvent;

#[cfg(not(any(windows, all(unix, not(target_os = "android"), not(target_os = "ios")))))]
impl NotificationEvent {
    pub fn create(_name: &str) -> Result<Self, NativeIpcError> {
        Err(NativeIpcError::UnsupportedPlatform)
    }

    pub fn open(_name: &str) -> Result<Self, NativeIpcError> {
        Err(NativeIpcError::UnsupportedPlatform)
    }

    pub fn set(&self) -> Result<(), NativeIpcError> {
        Err(NativeIpcError::UnsupportedPlatform)
    }

    pub fn wait(&self, _timeout: Duration) -> Result<(), NativeIpcError> {
        Err(NativeIpcError::UnsupportedPlatform)
    }
}

#[cfg(all(
    test,
    any(windows, all(unix, not(target_os = "android"), not(target_os = "ios")))
))]
mod tests {
    use super::*;
    use std::time::Duration;

    fn unique_name(kind: &str) -> String {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        if cfg!(windows) {
            format!("Local\\BAAS-test-{kind}-{nonce}")
        } else {
            let token = kind.chars().next().unwrap_or('x');
            format!("/bt_{token}_{nonce}")
        }
    }

    #[test]
    fn named_shared_memory_can_be_opened_by_name() {
        let name = unique_name("shm");
        let mut owner = SharedMemoryRegion::create(&name, 128).unwrap();
        owner.as_mut_slice()[0..4].copy_from_slice(b"BAAS");

        let peer = SharedMemoryRegion::open(&name, 128).unwrap();

        assert_eq!(owner.len(), 128);
        assert_eq!(owner.name(), name);
        assert_eq!(&peer.as_slice()[0..4], b"BAAS");
    }

    #[test]
    fn named_event_wakes_peer() {
        let name = unique_name("event");
        let owner = NotificationEvent::create(&name).unwrap();
        let peer = NotificationEvent::open(&name).unwrap();

        owner.set().unwrap();

        assert_eq!(peer.wait(Duration::from_secs(1)), Ok(()));
        assert_eq!(
            peer.wait(Duration::from_millis(1)),
            Err(NativeIpcError::TimedOut)
        );
    }
}

#[cfg(all(
    test,
    not(any(windows, all(unix, not(target_os = "android"), not(target_os = "ios"))))
))]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn native_ipc_reports_unsupported_platform() {
        assert!(matches!(
            SharedMemoryRegion::create("/baas-test-shm", 128),
            Err(NativeIpcError::UnsupportedPlatform)
        ));
        assert!(matches!(
            NotificationEvent::create("/baas-test-event"),
            Err(NativeIpcError::UnsupportedPlatform)
        ));

        let event = NotificationEvent;
        assert_eq!(event.set(), Err(NativeIpcError::UnsupportedPlatform));
        assert_eq!(
            event.wait(Duration::from_millis(1)),
            Err(NativeIpcError::UnsupportedPlatform)
        );
    }
}
