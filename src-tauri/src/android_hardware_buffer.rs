use std::{ffi::c_void, ptr, slice, sync::OnceLock};

use jni::{
    objects::{JByteBuffer, JClass, JObject},
    sys::jint,
    JNIEnv,
};

#[repr(C)]
#[derive(Default)]
struct AHardwareBufferDescription {
    width: u32,
    height: u32,
    layers: u32,
    format: u32,
    usage: u64,
    stride: u32,
    reserved0: u32,
    reserved1: u64,
}

#[repr(C)]
struct AHardwareBuffer {
    _private: [u8; 0],
}

#[link(name = "dl")]
unsafe extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const std::ffi::c_char) -> *mut c_void;
}

struct HardwareBufferApi {
    from_java:
        unsafe extern "C" fn(*mut jni::sys::JNIEnv, jni::sys::jobject) -> *mut AHardwareBuffer,
    describe: unsafe extern "C" fn(*const AHardwareBuffer, *mut AHardwareBufferDescription),
    acquire: unsafe extern "C" fn(*mut AHardwareBuffer),
    lock: unsafe extern "C" fn(
        *mut AHardwareBuffer,
        u64,
        i32,
        *const c_void,
        *mut *mut c_void,
    ) -> i32,
    unlock: unsafe extern "C" fn(*mut AHardwareBuffer, *mut i32) -> i32,
    release: unsafe extern "C" fn(*mut AHardwareBuffer),
}

// Android preserves a different RTLD_DEFAULT ABI on 32-bit targets.
#[cfg(target_pointer_width = "64")]
const RTLD_DEFAULT: *mut c_void = ptr::null_mut();
#[cfg(target_pointer_width = "32")]
const RTLD_DEFAULT: *mut c_void = usize::MAX as *mut c_void;

fn hardware_buffer_api() -> Option<&'static HardwareBufferApi> {
    static API: OnceLock<Option<HardwareBufferApi>> = OnceLock::new();
    API.get_or_init(|| {
        // These NDK symbols exist only on API 26+. Resolve them lazily so our
        // minSdk 24 library can still load and use the Java plane-buffer fallback.
        macro_rules! load {
            ($name:literal, $signature:ty) => {{
                // libandroid is already loaded by Tauri's Android runtime.
                let symbol = unsafe { dlsym(RTLD_DEFAULT, concat!($name, "\0").as_ptr().cast()) };
                if symbol.is_null() {
                    return None;
                }
                // SAFETY: the signature matches the named NDK hardware_buffer API.
                unsafe { std::mem::transmute::<*mut c_void, $signature>(symbol) }
            }};
        }
        Some(HardwareBufferApi {
            from_java: load!(
                "AHardwareBuffer_fromHardwareBuffer",
                unsafe extern "C" fn(
                    *mut jni::sys::JNIEnv,
                    jni::sys::jobject,
                ) -> *mut AHardwareBuffer
            ),
            describe: load!(
                "AHardwareBuffer_describe",
                unsafe extern "C" fn(*const AHardwareBuffer, *mut AHardwareBufferDescription)
            ),
            acquire: load!(
                "AHardwareBuffer_acquire",
                unsafe extern "C" fn(*mut AHardwareBuffer)
            ),
            lock: load!(
                "AHardwareBuffer_lock",
                unsafe extern "C" fn(
                    *mut AHardwareBuffer,
                    u64,
                    i32,
                    *const c_void,
                    *mut *mut c_void,
                ) -> i32
            ),
            unlock: load!(
                "AHardwareBuffer_unlock",
                unsafe extern "C" fn(*mut AHardwareBuffer, *mut i32) -> i32
            ),
            release: load!(
                "AHardwareBuffer_release",
                unsafe extern "C" fn(*mut AHardwareBuffer)
            ),
        })
    })
    .as_ref()
}

const CPU_READ_OFTEN: u64 = 3;

/// Copies a synchronized RGBA hardware buffer into a Java direct ByteBuffer.
#[no_mangle]
pub extern "system" fn Java_io_github_kiramei_baas_1tauri_BaasHeadlessVirtualDisplay_copyHardwareBuffer(
    env: JNIEnv,
    _class: JClass,
    hardware_buffer: JObject,
    destination: JByteBuffer,
) -> jint {
    let Some(api) = hardware_buffer_api() else {
        return -1;
    };
    let native = unsafe { (api.from_java)(env.get_raw(), hardware_buffer.as_raw()) };
    if native.is_null() {
        return -1;
    }
    // `fromHardwareBuffer` only lends the Java object's reference. Hold our
    // own reference while locking/copying so Image.close()/display teardown
    // cannot free the buffer underneath this native call.
    unsafe { (api.acquire)(native) };

    let mut description = AHardwareBufferDescription::default();
    unsafe { (api.describe)(native, &mut description) };
    let bytes_to_copy = description
        .stride
        .checked_mul(description.height)
        .and_then(|pixels| pixels.checked_mul(4))
        .map(|bytes| bytes as usize)
        .unwrap_or(0);
    let destination_capacity = match env.get_direct_buffer_capacity(&destination) {
        Ok(capacity) => capacity,
        Err(_) => {
            unsafe { (api.release)(native) };
            return -2;
        }
    };
    if bytes_to_copy == 0 || bytes_to_copy > destination_capacity {
        unsafe { (api.release)(native) };
        return -3;
    }

    let mut source_address: *mut c_void = ptr::null_mut();
    let lock_result =
        unsafe { (api.lock)(native, CPU_READ_OFTEN, -1, ptr::null(), &mut source_address) };
    if lock_result != 0 || source_address.is_null() {
        unsafe { (api.release)(native) };
        return -4;
    }

    let result = match env.get_direct_buffer_address(&destination) {
        Ok(destination_address) => {
            let source =
                unsafe { slice::from_raw_parts(source_address.cast::<u8>(), bytes_to_copy) };
            let destination_slice =
                unsafe { slice::from_raw_parts_mut(destination_address, destination_capacity) };
            destination_slice[..bytes_to_copy].copy_from_slice(source);
            bytes_to_copy as jint
        }
        Err(_) => -5,
    };
    unsafe {
        (api.unlock)(native, ptr::null_mut());
        (api.release)(native);
    }
    result
}
