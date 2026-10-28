use std::{
    ffi::CString,
    sync::{Mutex, OnceLock},
};

use jni::{
    objects::{JByteArray, JClass},
    sys::jbyteArray,
    JNIEnv,
};
use openh264::{decoder::Decoder, formats::YUVSource};

static DECODER: OnceLock<Mutex<Option<Decoder>>> = OnceLock::new();

#[link(name = "log")]
unsafe extern "C" {
    fn __android_log_write(priority: i32, tag: *const i8, text: *const i8) -> i32;
}

fn android_log(message: &str) {
    let Ok(tag) = CString::new("BaasOpenH264") else {
        return;
    };
    let Ok(text) = CString::new(message) else {
        return;
    };
    unsafe { __android_log_write(4, tag.as_ptr(), text.as_ptr()) };
}

fn decoder_slot() -> &'static Mutex<Option<Decoder>> {
    DECODER.get_or_init(|| Mutex::new(None))
}

fn new_decoder() -> Result<Decoder, openh264::Error> {
    Decoder::new()
}

/// Decodes one Annex-B H.264 packet in software and returns packed RGB pixels.
#[no_mangle]
pub extern "system" fn Java_io_github_kiramei_baas_1tauri_BaasHeadlessVirtualDisplay_decodeH264(
    env: JNIEnv,
    _class: JClass,
    data: JByteArray,
) -> jbyteArray {
    let packet = match env.convert_byte_array(&data) {
        Ok(packet) => packet,
        Err(_) => return std::ptr::null_mut(),
    };
    let mut slot = match decoder_slot().lock() {
        Ok(slot) => slot,
        Err(_) => return std::ptr::null_mut(),
    };
    if slot.is_none() {
        *slot = match new_decoder() {
            Ok(decoder) => Some(decoder),
            Err(error) => {
                android_log(&format!("decoder initialization failed: {error}"));
                return std::ptr::null_mut();
            }
        };
    }
    let decoded = match slot.as_mut().expect("decoder initialized").decode(&packet) {
        Ok(Some(decoded)) => decoded,
        Ok(None) => return std::ptr::null_mut(),
        Err(error) => {
            android_log(&format!("decode failed: {error}"));
            *slot = None;
            return std::ptr::null_mut();
        }
    };
    let mut rgb = vec![0_u8; decoded.rgb8_len()];
    decoded.write_rgb8(&mut rgb);
    env.byte_array_from_slice(&rgb)
        .map(JByteArray::into_raw)
        .unwrap_or(std::ptr::null_mut())
}

#[no_mangle]
pub extern "system" fn Java_io_github_kiramei_baas_1tauri_BaasHeadlessVirtualDisplay_resetH264Decoder(
    _env: JNIEnv,
    _class: JClass,
) {
    if let Ok(mut slot) = decoder_slot().lock() {
        *slot = None;
    }
}
