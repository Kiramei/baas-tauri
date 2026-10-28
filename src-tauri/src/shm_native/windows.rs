//! Fixed-slot ownership uses Win32 semaphores, including their publication barrier.
//! Neither language reads or rewrites a peer-owned shared cursor.
use crate::shm_protocol::*;
use std::{ffi::c_void, ptr::NonNull};
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{
            CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE, INVALID_HANDLE_VALUE,
            WAIT_OBJECT_0, WAIT_TIMEOUT,
        },
        System::{
            Memory::{
                CreateFileMappingW, MapViewOfFile, UnmapViewOfFile, FILE_MAP_ALL_ACCESS,
                MEMORY_MAPPED_VIEW_ADDRESS, PAGE_READWRITE,
            },
            Threading::{
                CreateEventW, CreateSemaphoreW, OpenProcess, ReleaseSemaphore, SetEvent,
                WaitForMultipleObjects, PROCESS_SYNCHRONIZE,
            },
        },
    },
};

struct Handle(HANDLE);
unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn failure(operation: &str, error: impl std::fmt::Display) -> String {
    format!("shared memory {operation}: {error}")
}

pub struct NativeSession {
    _mapping: Handle,
    view: NonNull<u8>,
    stop: Handle,
    r2p_free: Handle,
    r2p_used: Handle,
    p2r_free: Handle,
    p2r_used: Handle,
}
// A producer may only write a slot after acquiring free, a consumer may only
// borrow it after acquiring used. The two directions occupy disjoint ranges.
unsafe impl Send for NativeSession {}
unsafe impl Sync for NativeSession {}

impl NativeSession {
    pub fn create(base: &str) -> Result<Self, String> {
        if base.is_empty()
            || base.len() > 120
            || !base
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        {
            return Err("shared-memory name must be an ASCII identifier".into());
        }
        let name = format!("Local\\{base}");
        let mapping_name = wide(&name);
        let mapping = Handle(
            unsafe {
                CreateFileMappingW(
                    INVALID_HANDLE_VALUE,
                    None,
                    PAGE_READWRITE,
                    0,
                    REGION_BYTES as u32,
                    PCWSTR(mapping_name.as_ptr()),
                )
            }
            .map_err(|error| failure("CreateFileMappingW", error))?,
        );
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            return Err("shared-memory generation already exists".into());
        }
        let mapped = unsafe { MapViewOfFile(mapping.0, FILE_MAP_ALL_ACCESS, 0, 0, REGION_BYTES) };
        let view = NonNull::new(mapped.Value as *mut u8)
            .ok_or_else(|| failure("MapViewOfFile", windows::core::Error::from_thread()))?;
        let create = || -> Result<Self, String> {
            let stop_name = wide(&format!("{name}_stop"));
            let stop = Handle(
                unsafe { CreateEventW(None, true, false, PCWSTR(stop_name.as_ptr())) }
                    .map_err(|e| failure("CreateEventW", e))?,
            );
            let semaphore = |suffix: &str, initial: i32| -> Result<Handle, String> {
                let full = wide(&format!("{name}_{suffix}"));
                let handle = Handle(
                    unsafe {
                        CreateSemaphoreW(None, initial, SLOT_COUNT as i32, PCWSTR(full.as_ptr()))
                    }
                    .map_err(|e| failure("CreateSemaphoreW", e))?,
                );
                if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
                    return Err("shared-memory semaphore generation already exists".into());
                }
                Ok(handle)
            };
            let r2p_free = semaphore("r2p_free", SLOT_COUNT as i32)?;
            let r2p_used = semaphore("r2p_used", 0)?;
            let p2r_free = semaphore("p2r_free", SLOT_COUNT as i32)?;
            let p2r_used = semaphore("p2r_used", 0)?;
            unsafe {
                std::ptr::copy_nonoverlapping(
                    initial_header(std::process::id()).as_ptr(),
                    view.as_ptr(),
                    HEADER_BYTES,
                );
            }
            Ok(Self {
                _mapping: mapping,
                view,
                stop,
                r2p_free,
                r2p_used,
                p2r_free,
                p2r_used,
            })
        };
        // Constructing handles can fail after mapping. Unmap that orphan on error.
        match create() {
            Ok(session) => Ok(session),
            Err(error) => {
                unsafe {
                    let _ = UnmapViewOfFile(mapped);
                }
                Err(error)
            }
        }
    }

    pub fn stop(&self) {
        unsafe {
            let _ = SetEvent(self.stop.0);
        }
    }
    pub fn peer_process(&self) -> Result<Option<PeerProcess>, String> {
        // Python writes this once before publishing READY via the semaphore.
        let pid = unsafe { std::ptr::read_unaligned(self.view.as_ptr().add(32).cast::<u32>()) };
        if pid == 0 {
            return Err("shared-memory READY omitted the Python process id".into());
        }
        let process = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) }
            .map_err(|error| failure("OpenProcess(peer)", error))?;
        Ok(Some(PeerProcess(Handle(process))))
    }
    fn acquire(
        &self,
        semaphore: &Handle,
        timeout: u32,
        peer: Option<&PeerProcess>,
    ) -> Result<bool, String> {
        let handles = [
            self.stop.0,
            semaphore.0,
            peer.map(|peer| peer.0 .0).unwrap_or_default(),
        ];
        let result = unsafe {
            WaitForMultipleObjects(
                &handles[..if peer.is_some() { 3 } else { 2 }],
                false,
                timeout,
            )
        };
        if result == WAIT_OBJECT_0 {
            Err("shared-memory session stopped".into())
        } else if result.0 == WAIT_OBJECT_0.0 + 1 {
            Ok(true)
        } else if peer.is_some() && result.0 == WAIT_OBJECT_0.0 + 2 {
            Err("shared-memory backend process exited".into())
        } else if result == WAIT_TIMEOUT {
            Ok(false)
        } else {
            Err(failure(
                "WaitForMultipleObjects",
                windows::core::Error::from_thread(),
            ))
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
                ReleaseSemaphore(self.r2p_used.0, 1, None)
                    .map_err(|e| failure("ReleaseSemaphore(used)", e))?;
            }
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
        // Release even if decoding failed; session failure will wake all waiters.
        unsafe {
            ReleaseSemaphore(self.p2r_free.0, 1, None)
                .map_err(|e| failure("ReleaseSemaphore(free)", e))?;
        }
        *index = (*index + 1) % SLOT_COUNT;
        result.map(Some)
    }
}
pub struct PeerProcess(Handle);
impl Drop for NativeSession {
    fn drop(&mut self) {
        self.stop();
        unsafe {
            let _ = UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS {
                Value: self.view.as_ptr() as *mut c_void,
            });
        }
    }
}
