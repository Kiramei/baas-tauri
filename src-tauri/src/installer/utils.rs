use std::io::{BufReader, Read};
use std::process::Child;
use tauri::{AppHandle, Emitter};

pub fn log_stream(app: &AppHandle, child: &mut Child) {
    // Create BufReader to read the process output line by line
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    capture_stream(app, stdout);
    capture_stream(app, stderr);
}

fn capture_stream(app: &AppHandle, std_stream: impl Read + Send + 'static) {
    let read_buffer = BufReader::new(std_stream);
    let _app = app.clone();
    std::thread::spawn(move || {
        let mut line = Vec::new(); // Temporary storage for the line

        // Read bytes from the reader stream
        for byte in read_buffer.bytes() {
            match byte {
                Ok(b) => {
                    // If the byte is valid, append it to the line buffer
                    line.push(b);
                    if b == b'\n' {
                        // When a newline byte is found, convert the buffer to a string
                        match String::from_utf8(line.clone()) {
                            Ok(valid_str) => {
                                // If valid UTF-8, process the line
                                emit_log(&_app, &valid_str, "info");
                            }
                            Err(_) => {
                                // If the line is not valid UTF-8, report the issue
                                eprintln!("Found invalid UTF-8 byte, skipping.");
                            }
                        }
                        // Clear the line buffer for the next line
                        line.clear();
                    }
                }
                Err(e) => {
                    // Handle any I/O errors that occur while reading the stream
                    eprintln!("Error reading stream: {}", e);
                }
            }
        }
    });
}

pub fn emit_log(app: &AppHandle, message: &str, level: &str) {
    let _ = app.emit(
        "installer://log",
        serde_json::json!({
            "message": message,
            "level": level,
        }),
    );
}
