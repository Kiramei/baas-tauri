//! Cross-platform shared-memory wire constants, also implemented in the Python backend.
pub const HEADER_BYTES: usize = 256;
pub const SLOT_COUNT: usize = 64;
pub const SLOT_BYTES: usize = 65_536;
pub const CHUNK_BYTES: usize = SLOT_BYTES - 4;
pub const MAX_PAYLOAD_BYTES: usize = 64 * 1024 * 1024;
pub const REGION_BYTES: usize = HEADER_BYTES + 2 * SLOT_COUNT * SLOT_BYTES;
pub const MESSAGE_HEADER_BYTES: usize = 9;

pub fn initial_header(owner_pid: u32) -> [u8; HEADER_BYTES] {
    let mut header = [0; HEADER_BYTES];
    header[..8].copy_from_slice(b"BAASSHM1");
    for (offset, value) in [
        (8, 1),
        (12, HEADER_BYTES as u32),
        (16, SLOT_COUNT as u32),
        (20, SLOT_BYTES as u32),
        (24, MAX_PAYLOAD_BYTES as u32),
        (28, owner_pid),
    ] {
        header[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
    header
}

pub fn message_header(
    stream: u32,
    kind: u8,
    length: usize,
) -> Result<[u8; MESSAGE_HEADER_BYTES], String> {
    if !(1..=4).contains(&kind) || length > MAX_PAYLOAD_BYTES {
        return Err("shared-memory message has invalid kind or exceeds 64 MiB".into());
    }
    let mut header = [0; MESSAGE_HEADER_BYTES];
    header[..4].copy_from_slice(&stream.to_le_bytes());
    header[4] = kind;
    header[5..9].copy_from_slice(&(length as u32).to_le_bytes());
    Ok(header)
}

/// Incremental byte-stream decoder. A slot is a chunk, never a message boundary.
/// The final buffer is already BPIP-shaped for the raw WebView bridge.
#[derive(Default)]
pub struct Decoder {
    header: [u8; MESSAGE_HEADER_BYTES],
    header_len: usize,
    stream: u32,
    remaining: usize,
    frame: Vec<u8>,
}

impl Decoder {
    pub fn push(&mut self, mut chunk: &[u8]) -> Result<Vec<(u32, Vec<u8>)>, String> {
        let mut messages = Vec::new();
        while !chunk.is_empty() {
            if self.header_len < MESSAGE_HEADER_BYTES {
                let count = (MESSAGE_HEADER_BYTES - self.header_len).min(chunk.len());
                self.header[self.header_len..self.header_len + count]
                    .copy_from_slice(&chunk[..count]);
                self.header_len += count;
                chunk = &chunk[count..];
                if self.header_len < MESSAGE_HEADER_BYTES {
                    break;
                }
                self.stream = u32::from_le_bytes(self.header[..4].try_into().unwrap());
                let kind = self.header[4];
                self.remaining = u32::from_le_bytes(self.header[5..9].try_into().unwrap()) as usize;
                message_header(self.stream, kind, self.remaining)?;
                self.frame = Vec::with_capacity(10 + self.remaining);
                self.frame.extend_from_slice(b"BPIP\x01");
                self.frame.push(kind);
                self.frame
                    .extend_from_slice(&(self.remaining as u32).to_le_bytes());
            }
            let count = self.remaining.min(chunk.len());
            self.frame.extend_from_slice(&chunk[..count]);
            self.remaining -= count;
            chunk = &chunk[count..];
            if self.remaining == 0 {
                messages.push((self.stream, std::mem::take(&mut self.frame)));
                self.header_len = 0;
            }
        }
        Ok(messages)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn messages_reassemble_across_every_header_split_and_large_payload() {
        let payload = vec![0xA5; 1_048_576];
        let mut wire = message_header(42, 2, payload.len()).unwrap().to_vec();
        wire.extend_from_slice(&payload);
        wire.extend_from_slice(&message_header(7, 3, 0).unwrap());
        for split in 1..=MESSAGE_HEADER_BYTES {
            let mut decoder = Decoder::default();
            let mut decoded = decoder.push(&wire[..split]).unwrap();
            for chunk in wire[split..].chunks(CHUNK_BYTES) {
                decoded.extend(decoder.push(chunk).unwrap());
            }
            assert_eq!(decoded.len(), 2);
            assert_eq!(decoded[0].0, 42);
            assert_eq!(&decoded[0].1[10..], payload.as_slice());
            assert_eq!(decoded[1].0, 7);
            assert_eq!(decoded[1].1.len(), 10);
        }
    }
    #[test]
    fn rejects_invalid_kinds_and_oversized_headers_without_payload_allocation() {
        for (kind, length) in [(0, 1), (5, 1), (2, MAX_PAYLOAD_BYTES + 1)] {
            let mut wire = [0; 9];
            wire[4] = kind;
            wire[5..].copy_from_slice(&(length as u32).to_le_bytes());
            assert!(Decoder::default().push(&wire).is_err());
        }
    }
}
