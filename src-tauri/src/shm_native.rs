//! Fixed-slot ownership uses native interprocess semaphores, including their
//! publication barrier. Neither language rewrites a peer-owned shared cursor.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "linux")]
pub use linux::*;
#[cfg(windows)]
pub use windows::*;
