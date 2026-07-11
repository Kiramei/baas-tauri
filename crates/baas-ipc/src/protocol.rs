use thiserror::Error;

pub const MAGIC: [u8; 8] = *b"BAASIPC\0";
pub const PROTOCOL_VERSION: u16 = 1;
pub const ABI_VERSION: u16 = 1;
pub const BYTE_ORDER: &str = "little";
pub const MAX_FRAME_LENGTH: u32 = 8 * 1024 * 1024;
pub const MAX_MESSAGE_LENGTH: u32 = 64 * 1024 * 1024;
pub const LIFECYCLE_STARTING: u32 = 1;
pub const LIFECYCLE_READY: u32 = 2;
pub const LIFECYCLE_STOPPED: u32 = 3;
pub const LIFECYCLE_FAILED: u32 = 4;
pub const SHARED_MEMORY_HEADER_LEN: usize = 124;
pub const FRAME_HEADER_LEN: usize = 40;
pub const RING_CONTROL_MAGIC: [u8; 8] = *b"BAASRNG\0";
pub const RING_CONTROL_BLOCK_LEN: usize = 64;

pub const CHANNEL_CONTROL: u16 = 0;
pub const CHANNEL_PROVIDER: u16 = 1;
pub const CHANNEL_SYNC: u16 = 2;
pub const CHANNEL_TRIGGER: u16 = 3;
pub const CHANNEL_REMOTE: u16 = 4;

pub const MESSAGE_KIND_OPEN_CHANNEL: u16 = 1;
pub const MESSAGE_KIND_CLOSE_CHANNEL: u16 = 2;
pub const MESSAGE_KIND_JSON: u16 = 3;
pub const MESSAGE_KIND_BYTES: u16 = 4;
pub const MESSAGE_KIND_ERROR: u16 = 5;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum IpcProtocolError {
    #[error("invalid shared memory header size")]
    InvalidSharedMemoryHeaderSize,
    #[error("shared memory header magic mismatch")]
    InvalidMagic,
    #[error("protocol version mismatch")]
    ProtocolVersionMismatch,
    #[error("invalid frame header size")]
    InvalidFrameHeaderSize,
    #[error("invalid ring control block size")]
    InvalidRingControlBlockSize,
    #[error("ring control block magic mismatch")]
    InvalidRingMagic,
    #[error("ring control block cursor is out of bounds")]
    InvalidRingCursor,
    #[error("payload length exceeds shared-memory frame limit")]
    FrameTooLarge,
    #[error("fragment count must be greater than zero")]
    EmptyFragmentSet,
    #[error("fragment index must be smaller than fragment count")]
    FragmentIndexOutOfRange,
    #[error("message length exceeds shared-memory message limit")]
    MessageTooLarge,
    #[error("fragment sequence is incomplete")]
    IncompleteFragments,
    #[error("fragment metadata does not match the first fragment")]
    FragmentMetadataMismatch,
    #[error("fragment index order is invalid")]
    FragmentOrderMismatch,
    #[error("unknown logical channel")]
    UnknownLogicalChannel,
    #[error("unknown message kind")]
    UnknownMessageKind,
}

pub fn logical_channel_id(name: &str) -> Result<u16, IpcProtocolError> {
    match name {
        "provider" => Ok(CHANNEL_PROVIDER),
        "sync" => Ok(CHANNEL_SYNC),
        "trigger" => Ok(CHANNEL_TRIGGER),
        "remote" => Ok(CHANNEL_REMOTE),
        "control" => Ok(CHANNEL_CONTROL),
        _ => Err(IpcProtocolError::UnknownLogicalChannel),
    }
}

pub fn logical_channel_name(channel_id: u16) -> Result<&'static str, IpcProtocolError> {
    match channel_id {
        CHANNEL_CONTROL => Ok("control"),
        CHANNEL_PROVIDER => Ok("provider"),
        CHANNEL_SYNC => Ok("sync"),
        CHANNEL_TRIGGER => Ok("trigger"),
        CHANNEL_REMOTE => Ok("remote"),
        _ => Err(IpcProtocolError::UnknownLogicalChannel),
    }
}

pub fn validate_message_kind(message_kind: u16) -> Result<(), IpcProtocolError> {
    match message_kind {
        MESSAGE_KIND_OPEN_CHANNEL
        | MESSAGE_KIND_CLOSE_CHANNEL
        | MESSAGE_KIND_JSON
        | MESSAGE_KIND_BYTES
        | MESSAGE_KIND_ERROR => Ok(()),
        _ => Err(IpcProtocolError::UnknownMessageKind),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RingControlBlock {
    pub magic: [u8; 8],
    pub abi_version: u16,
    pub header_size: u16,
    pub flags: u32,
    pub capacity: u32,
    pub read_cursor: u32,
    pub write_cursor: u32,
    pub generation_id_low: u64,
    pub generation_id_high: u64,
    pub sequence_number: u64,
    pub dropped_frames: u64,
    pub reserved: u32,
}

impl RingControlBlock {
    pub fn new(capacity: u32, generation_id_low: u64, generation_id_high: u64) -> Self {
        Self {
            magic: RING_CONTROL_MAGIC,
            abi_version: ABI_VERSION,
            header_size: RING_CONTROL_BLOCK_LEN as u16,
            flags: 0,
            capacity,
            read_cursor: 0,
            write_cursor: 0,
            generation_id_low,
            generation_id_high,
            sequence_number: 0,
            dropped_frames: 0,
            reserved: 0,
        }
    }

    pub fn encode(self) -> Result<[u8; RING_CONTROL_BLOCK_LEN], IpcProtocolError> {
        self.validate()?;
        let mut out = [0_u8; RING_CONTROL_BLOCK_LEN];
        out[0..8].copy_from_slice(&self.magic);
        out[8..10].copy_from_slice(&self.abi_version.to_le_bytes());
        out[10..12].copy_from_slice(&self.header_size.to_le_bytes());
        out[12..16].copy_from_slice(&self.flags.to_le_bytes());
        out[16..20].copy_from_slice(&self.capacity.to_le_bytes());
        out[20..24].copy_from_slice(&self.read_cursor.to_le_bytes());
        out[24..28].copy_from_slice(&self.write_cursor.to_le_bytes());
        out[28..36].copy_from_slice(&self.generation_id_low.to_le_bytes());
        out[36..44].copy_from_slice(&self.generation_id_high.to_le_bytes());
        out[44..52].copy_from_slice(&self.sequence_number.to_le_bytes());
        out[52..60].copy_from_slice(&self.dropped_frames.to_le_bytes());
        out[60..64].copy_from_slice(&self.reserved.to_le_bytes());
        Ok(out)
    }

    pub fn decode(input: &[u8]) -> Result<Self, IpcProtocolError> {
        if input.len() != RING_CONTROL_BLOCK_LEN {
            return Err(IpcProtocolError::InvalidRingControlBlockSize);
        }
        let block = Self {
            magic: input[0..8].try_into().unwrap(),
            abi_version: u16::from_le_bytes([input[8], input[9]]),
            header_size: u16::from_le_bytes([input[10], input[11]]),
            flags: u32::from_le_bytes(input[12..16].try_into().unwrap()),
            capacity: u32::from_le_bytes(input[16..20].try_into().unwrap()),
            read_cursor: u32::from_le_bytes(input[20..24].try_into().unwrap()),
            write_cursor: u32::from_le_bytes(input[24..28].try_into().unwrap()),
            generation_id_low: u64::from_le_bytes(input[28..36].try_into().unwrap()),
            generation_id_high: u64::from_le_bytes(input[36..44].try_into().unwrap()),
            sequence_number: u64::from_le_bytes(input[44..52].try_into().unwrap()),
            dropped_frames: u64::from_le_bytes(input[52..60].try_into().unwrap()),
            reserved: u32::from_le_bytes(input[60..64].try_into().unwrap()),
        };
        block.validate()?;
        Ok(block)
    }

    fn validate(&self) -> Result<(), IpcProtocolError> {
        if self.magic != RING_CONTROL_MAGIC {
            return Err(IpcProtocolError::InvalidRingMagic);
        }
        if self.abi_version != ABI_VERSION || self.header_size as usize != RING_CONTROL_BLOCK_LEN {
            return Err(IpcProtocolError::ProtocolVersionMismatch);
        }
        if self.read_cursor > self.capacity || self.write_cursor > self.capacity {
            return Err(IpcProtocolError::InvalidRingCursor);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SharedMemoryHeader {
    pub magic: [u8; 8],
    pub protocol_version: u16,
    pub abi_version: u16,
    pub header_size: u32,
    pub total_size: u32,
    pub generation_id_low: u64,
    pub generation_id_high: u64,
    pub owner_pid: u32,
    pub peer_pid: u32,
    pub lifecycle_state: u32,
    pub last_error_code: u32,
    pub owner_heartbeat_ns: u64,
    pub peer_heartbeat_ns: u64,
    pub rust_to_python_ring_offset: u32,
    pub rust_to_python_ring_length: u32,
    pub python_to_rust_ring_offset: u32,
    pub python_to_rust_ring_length: u32,
    pub control_lane_offset: u32,
    pub control_lane_length: u32,
    pub message_lane_offset: u32,
    pub message_lane_length: u32,
    pub bulk_lane_offset: u32,
    pub bulk_lane_length: u32,
    pub remote_lane_offset: u32,
    pub remote_lane_length: u32,
    pub last_error_offset: u32,
    pub last_error_length: u32,
}

impl SharedMemoryHeader {
    pub fn encode(self) -> Result<[u8; SHARED_MEMORY_HEADER_LEN], IpcProtocolError> {
        self.validate()?;
        let mut out = [0_u8; SHARED_MEMORY_HEADER_LEN];
        out[0..8].copy_from_slice(&self.magic);
        out[8..10].copy_from_slice(&self.protocol_version.to_le_bytes());
        out[10..12].copy_from_slice(&self.abi_version.to_le_bytes());
        out[12..16].copy_from_slice(&self.header_size.to_le_bytes());
        out[16..20].copy_from_slice(&self.total_size.to_le_bytes());
        out[20..28].copy_from_slice(&self.generation_id_low.to_le_bytes());
        out[28..36].copy_from_slice(&self.generation_id_high.to_le_bytes());
        out[36..40].copy_from_slice(&self.owner_pid.to_le_bytes());
        out[40..44].copy_from_slice(&self.peer_pid.to_le_bytes());
        out[44..48].copy_from_slice(&self.lifecycle_state.to_le_bytes());
        out[48..52].copy_from_slice(&self.last_error_code.to_le_bytes());
        out[52..60].copy_from_slice(&self.owner_heartbeat_ns.to_le_bytes());
        out[60..68].copy_from_slice(&self.peer_heartbeat_ns.to_le_bytes());
        out[68..72].copy_from_slice(&self.rust_to_python_ring_offset.to_le_bytes());
        out[72..76].copy_from_slice(&self.rust_to_python_ring_length.to_le_bytes());
        out[76..80].copy_from_slice(&self.python_to_rust_ring_offset.to_le_bytes());
        out[80..84].copy_from_slice(&self.python_to_rust_ring_length.to_le_bytes());
        out[84..88].copy_from_slice(&self.control_lane_offset.to_le_bytes());
        out[88..92].copy_from_slice(&self.control_lane_length.to_le_bytes());
        out[92..96].copy_from_slice(&self.message_lane_offset.to_le_bytes());
        out[96..100].copy_from_slice(&self.message_lane_length.to_le_bytes());
        out[100..104].copy_from_slice(&self.bulk_lane_offset.to_le_bytes());
        out[104..108].copy_from_slice(&self.bulk_lane_length.to_le_bytes());
        out[108..112].copy_from_slice(&self.remote_lane_offset.to_le_bytes());
        out[112..116].copy_from_slice(&self.remote_lane_length.to_le_bytes());
        out[116..120].copy_from_slice(&self.last_error_offset.to_le_bytes());
        out[120..124].copy_from_slice(&self.last_error_length.to_le_bytes());
        Ok(out)
    }

    pub fn decode(input: &[u8]) -> Result<Self, IpcProtocolError> {
        if input.len() != SHARED_MEMORY_HEADER_LEN {
            return Err(IpcProtocolError::InvalidSharedMemoryHeaderSize);
        }
        let header = Self {
            magic: input[0..8].try_into().unwrap(),
            protocol_version: u16::from_le_bytes([input[8], input[9]]),
            abi_version: u16::from_le_bytes([input[10], input[11]]),
            header_size: u32::from_le_bytes([input[12], input[13], input[14], input[15]]),
            total_size: u32::from_le_bytes([input[16], input[17], input[18], input[19]]),
            generation_id_low: u64::from_le_bytes(input[20..28].try_into().unwrap()),
            generation_id_high: u64::from_le_bytes(input[28..36].try_into().unwrap()),
            owner_pid: u32::from_le_bytes(input[36..40].try_into().unwrap()),
            peer_pid: u32::from_le_bytes(input[40..44].try_into().unwrap()),
            lifecycle_state: u32::from_le_bytes(input[44..48].try_into().unwrap()),
            last_error_code: u32::from_le_bytes(input[48..52].try_into().unwrap()),
            owner_heartbeat_ns: u64::from_le_bytes(input[52..60].try_into().unwrap()),
            peer_heartbeat_ns: u64::from_le_bytes(input[60..68].try_into().unwrap()),
            rust_to_python_ring_offset: u32::from_le_bytes(input[68..72].try_into().unwrap()),
            rust_to_python_ring_length: u32::from_le_bytes(input[72..76].try_into().unwrap()),
            python_to_rust_ring_offset: u32::from_le_bytes(input[76..80].try_into().unwrap()),
            python_to_rust_ring_length: u32::from_le_bytes(input[80..84].try_into().unwrap()),
            control_lane_offset: u32::from_le_bytes(input[84..88].try_into().unwrap()),
            control_lane_length: u32::from_le_bytes(input[88..92].try_into().unwrap()),
            message_lane_offset: u32::from_le_bytes(input[92..96].try_into().unwrap()),
            message_lane_length: u32::from_le_bytes(input[96..100].try_into().unwrap()),
            bulk_lane_offset: u32::from_le_bytes(input[100..104].try_into().unwrap()),
            bulk_lane_length: u32::from_le_bytes(input[104..108].try_into().unwrap()),
            remote_lane_offset: u32::from_le_bytes(input[108..112].try_into().unwrap()),
            remote_lane_length: u32::from_le_bytes(input[112..116].try_into().unwrap()),
            last_error_offset: u32::from_le_bytes(input[116..120].try_into().unwrap()),
            last_error_length: u32::from_le_bytes(input[120..124].try_into().unwrap()),
        };
        header.validate()?;
        Ok(header)
    }

    fn validate(&self) -> Result<(), IpcProtocolError> {
        if self.magic != MAGIC {
            return Err(IpcProtocolError::InvalidMagic);
        }
        if self.protocol_version != PROTOCOL_VERSION || self.abi_version != ABI_VERSION {
            return Err(IpcProtocolError::ProtocolVersionMismatch);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameHeader {
    pub frame_version: u16,
    pub logical_channel_id: u16,
    pub stream_id: u16,
    pub message_kind: u16,
    pub flags: u32,
    pub sequence_number: u64,
    pub correlation_id: u64,
    pub payload_length: u32,
    pub fragment_index: u32,
    pub fragment_count: u32,
}

impl FrameHeader {
    pub fn encode(self) -> Result<[u8; FRAME_HEADER_LEN], IpcProtocolError> {
        self.validate()?;
        let mut out = [0_u8; FRAME_HEADER_LEN];
        out[0..2].copy_from_slice(&self.frame_version.to_le_bytes());
        out[2..4].copy_from_slice(&self.logical_channel_id.to_le_bytes());
        out[4..6].copy_from_slice(&self.stream_id.to_le_bytes());
        out[6..8].copy_from_slice(&self.message_kind.to_le_bytes());
        out[8..12].copy_from_slice(&self.flags.to_le_bytes());
        out[12..20].copy_from_slice(&self.sequence_number.to_le_bytes());
        out[20..28].copy_from_slice(&self.correlation_id.to_le_bytes());
        out[28..32].copy_from_slice(&self.payload_length.to_le_bytes());
        out[32..36].copy_from_slice(&self.fragment_index.to_le_bytes());
        out[36..40].copy_from_slice(&self.fragment_count.to_le_bytes());
        Ok(out)
    }

    pub fn decode(input: &[u8]) -> Result<Self, IpcProtocolError> {
        if input.len() != FRAME_HEADER_LEN {
            return Err(IpcProtocolError::InvalidFrameHeaderSize);
        }
        let frame = Self {
            frame_version: u16::from_le_bytes([input[0], input[1]]),
            logical_channel_id: u16::from_le_bytes([input[2], input[3]]),
            stream_id: u16::from_le_bytes([input[4], input[5]]),
            message_kind: u16::from_le_bytes([input[6], input[7]]),
            flags: u32::from_le_bytes([input[8], input[9], input[10], input[11]]),
            sequence_number: u64::from_le_bytes([
                input[12], input[13], input[14], input[15], input[16], input[17], input[18],
                input[19],
            ]),
            correlation_id: u64::from_le_bytes([
                input[20], input[21], input[22], input[23], input[24], input[25], input[26],
                input[27],
            ]),
            payload_length: u32::from_le_bytes([input[28], input[29], input[30], input[31]]),
            fragment_index: u32::from_le_bytes([input[32], input[33], input[34], input[35]]),
            fragment_count: u32::from_le_bytes([input[36], input[37], input[38], input[39]]),
        };
        frame.validate()?;
        Ok(frame)
    }

    fn validate(&self) -> Result<(), IpcProtocolError> {
        logical_channel_name(self.logical_channel_id)?;
        validate_message_kind(self.message_kind)?;
        if self.payload_length > MAX_FRAME_LENGTH {
            return Err(IpcProtocolError::FrameTooLarge);
        }
        if self.fragment_count == 0 {
            return Err(IpcProtocolError::EmptyFragmentSet);
        }
        if self.fragment_index >= self.fragment_count {
            return Err(IpcProtocolError::FragmentIndexOutOfRange);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodedFrame {
    pub header: FrameHeader,
    pub payload: Vec<u8>,
}

#[allow(clippy::too_many_arguments)]
pub fn fragment_payload(
    logical_channel_id: u16,
    stream_id: u16,
    message_kind: u16,
    flags: u32,
    sequence_number: u64,
    correlation_id: u64,
    payload: &[u8],
    max_payload_per_frame: usize,
) -> Result<Vec<EncodedFrame>, IpcProtocolError> {
    if payload.len() > MAX_MESSAGE_LENGTH as usize {
        return Err(IpcProtocolError::MessageTooLarge);
    }
    if max_payload_per_frame == 0 || max_payload_per_frame > MAX_FRAME_LENGTH as usize {
        return Err(IpcProtocolError::FrameTooLarge);
    }
    let fragment_count = if payload.is_empty() {
        1
    } else {
        payload.len().div_ceil(max_payload_per_frame)
    };
    let mut frames = Vec::with_capacity(fragment_count);
    for index in 0..fragment_count {
        let start = index * max_payload_per_frame;
        let end = (start + max_payload_per_frame).min(payload.len());
        let chunk = if payload.is_empty() {
            Vec::new()
        } else {
            payload[start..end].to_vec()
        };
        let header = FrameHeader {
            frame_version: 1,
            logical_channel_id,
            stream_id,
            message_kind,
            flags,
            sequence_number,
            correlation_id,
            payload_length: chunk.len() as u32,
            fragment_index: index as u32,
            fragment_count: fragment_count as u32,
        };
        header.encode()?;
        frames.push(EncodedFrame {
            header,
            payload: chunk,
        });
    }
    Ok(frames)
}

pub fn reassemble_frames(frames: &[EncodedFrame]) -> Result<Vec<u8>, IpcProtocolError> {
    let Some(first) = frames.first() else {
        return Err(IpcProtocolError::IncompleteFragments);
    };
    let expected_count = first.header.fragment_count as usize;
    if frames.len() != expected_count {
        return Err(IpcProtocolError::IncompleteFragments);
    }
    let mut payload = Vec::new();
    for (index, frame) in frames.iter().enumerate() {
        if frame.header.logical_channel_id != first.header.logical_channel_id
            || frame.header.stream_id != first.header.stream_id
            || frame.header.message_kind != first.header.message_kind
            || frame.header.sequence_number != first.header.sequence_number
            || frame.header.correlation_id != first.header.correlation_id
            || frame.header.fragment_count != first.header.fragment_count
        {
            return Err(IpcProtocolError::FragmentMetadataMismatch);
        }
        if frame.header.fragment_index as usize != index {
            return Err(IpcProtocolError::FragmentOrderMismatch);
        }
        if frame.header.payload_length as usize != frame.payload.len() {
            return Err(IpcProtocolError::InvalidFrameHeaderSize);
        }
        payload.extend_from_slice(&frame.payload);
        if payload.len() > MAX_MESSAGE_LENGTH as usize {
            return Err(IpcProtocolError::MessageTooLarge);
        }
    }
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHARED_MEMORY_HEADER_HEX: &str = concat!(
        "4241415349504300010001007c0000000010000008070605040302011817161514131211",
        "64000000c800000002000000000000002c01000000000000900100000000000000020000",
        "000400000006000000040000000200008000000080020000800300000006000000040000",
        "000a000000040000000f000000000000",
    );
    const FRAME_HEADER_HEX: &str =
        "0100020003000400050000000600000000000000070000000000000008000000090000000a000000";
    const RING_CONTROL_BLOCK_HEX: &str = concat!(
        "42414153524e470001004000000000000700000000000000000000000807060504030201",
        "18171615141312110000000000000000000000000000000000000000",
    );
    const FRAGMENT_HEADER_HEXES: [&str; 3] = [
        "01000200030004000500000006000000000000000700000000000000030000000000000003000000",
        "01000200030004000500000006000000000000000700000000000000030000000100000003000000",
        "01000200030004000500000006000000000000000700000000000000020000000200000003000000",
    ];

    #[test]
    fn frame_header_round_trips_little_endian() {
        let frame = FrameHeader {
            frame_version: 1,
            logical_channel_id: 2,
            stream_id: 3,
            message_kind: 4,
            flags: 5,
            sequence_number: 6,
            correlation_id: 7,
            payload_length: 8,
            fragment_index: 9,
            fragment_count: 10,
        };

        let encoded = frame.encode().unwrap();
        assert_eq!(encoded.len(), FRAME_HEADER_LEN);
        assert_eq!(FrameHeader::decode(&encoded).unwrap(), frame);
        assert_eq!(hex(&encoded), FRAME_HEADER_HEX);
    }

    #[test]
    fn rejects_oversized_frame() {
        let frame = FrameHeader {
            frame_version: 1,
            logical_channel_id: 1,
            stream_id: 0,
            message_kind: 1,
            flags: 0,
            sequence_number: 0,
            correlation_id: 0,
            payload_length: MAX_FRAME_LENGTH + 1,
            fragment_index: 0,
            fragment_count: 1,
        };

        assert_eq!(frame.encode(), Err(IpcProtocolError::FrameTooLarge));
    }

    #[test]
    fn rejects_invalid_fragment_bounds() {
        let frame = FrameHeader {
            frame_version: 1,
            logical_channel_id: 1,
            stream_id: 0,
            message_kind: 1,
            flags: 0,
            sequence_number: 0,
            correlation_id: 0,
            payload_length: 0,
            fragment_index: 1,
            fragment_count: 1,
        };

        assert_eq!(
            frame.encode(),
            Err(IpcProtocolError::FragmentIndexOutOfRange)
        );
    }

    #[test]
    fn shared_memory_header_round_trips() {
        let header = SharedMemoryHeader {
            magic: MAGIC,
            protocol_version: PROTOCOL_VERSION,
            abi_version: ABI_VERSION,
            header_size: SHARED_MEMORY_HEADER_LEN as u32,
            total_size: 4096,
            generation_id_low: 0x0102_0304_0506_0708,
            generation_id_high: 0x1112_1314_1516_1718,
            owner_pid: 100,
            peer_pid: 200,
            lifecycle_state: LIFECYCLE_READY,
            last_error_code: 0,
            owner_heartbeat_ns: 300,
            peer_heartbeat_ns: 400,
            rust_to_python_ring_offset: 512,
            rust_to_python_ring_length: 1024,
            python_to_rust_ring_offset: 1536,
            python_to_rust_ring_length: 1024,
            control_lane_offset: 512,
            control_lane_length: 128,
            message_lane_offset: 640,
            message_lane_length: 896,
            bulk_lane_offset: 1536,
            bulk_lane_length: 1024,
            remote_lane_offset: 2560,
            remote_lane_length: 1024,
            last_error_offset: 3840,
            last_error_length: 0,
        };

        let encoded = header.encode().unwrap();

        assert_eq!(encoded.len(), SHARED_MEMORY_HEADER_LEN);
        assert_eq!(hex(&encoded), SHARED_MEMORY_HEADER_HEX);
        assert_eq!(SharedMemoryHeader::decode(&encoded).unwrap(), header);
    }

    #[test]
    fn shared_memory_header_rejects_protocol_version_mismatch() {
        let mut encoded = hex_bytes(SHARED_MEMORY_HEADER_HEX);
        encoded[8..10].copy_from_slice(&(PROTOCOL_VERSION + 1).to_le_bytes());

        assert_eq!(
            SharedMemoryHeader::decode(&encoded),
            Err(IpcProtocolError::ProtocolVersionMismatch)
        );
    }

    #[test]
    fn ring_control_block_round_trips() {
        let block = RingControlBlock::new(7, 0x0102_0304_0506_0708, 0x1112_1314_1516_1718);

        let encoded = block.encode().unwrap();

        assert_eq!(encoded.len(), RING_CONTROL_BLOCK_LEN);
        assert_eq!(hex(&encoded), RING_CONTROL_BLOCK_HEX);
        assert_eq!(RingControlBlock::decode(&encoded).unwrap(), block);
    }

    #[test]
    fn ring_control_block_rejects_abi_version_mismatch() {
        let mut encoded = hex_bytes(RING_CONTROL_BLOCK_HEX);
        encoded[8..10].copy_from_slice(&(ABI_VERSION + 1).to_le_bytes());

        assert_eq!(
            RingControlBlock::decode(&encoded),
            Err(IpcProtocolError::ProtocolVersionMismatch)
        );
    }

    #[test]
    fn fragments_and_reassembles_payload() {
        let frames = fragment_payload(2, 3, 4, 5, 6, 7, b"abcdefgh", 3).unwrap();

        assert_eq!(frames.len(), 3);
        assert_eq!(frames[0].payload, b"abc");
        assert_eq!(frames[1].payload, b"def");
        assert_eq!(frames[2].payload, b"gh");
        assert!(frames.iter().all(|frame| frame.header.fragment_count == 3));
        assert_eq!(
            frames
                .iter()
                .map(|frame| hex(&frame.header.encode().unwrap()))
                .collect::<Vec<_>>(),
            FRAGMENT_HEADER_HEXES
                .iter()
                .map(|value| value.to_string())
                .collect::<Vec<_>>()
        );
        assert_eq!(reassemble_frames(&frames).unwrap(), b"abcdefgh");
    }

    #[test]
    fn fragments_empty_payload_as_single_empty_frame() {
        let frames = fragment_payload(2, 3, 4, 5, 6, 7, b"", 3).unwrap();

        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].payload, b"");
        assert_eq!(frames[0].header.fragment_count, 1);
        assert_eq!(reassemble_frames(&frames).unwrap(), b"");
    }

    #[test]
    fn rejects_oversized_message() {
        let payload = vec![0_u8; MAX_MESSAGE_LENGTH as usize + 1];

        assert_eq!(
            fragment_payload(2, 3, 4, 5, 6, 7, &payload, 1024),
            Err(IpcProtocolError::MessageTooLarge)
        );
    }

    #[test]
    fn reassembly_rejects_missing_fragment() {
        let mut frames = fragment_payload(2, 3, 4, 5, 6, 7, b"abcdefgh", 3).unwrap();
        frames.pop();

        assert_eq!(
            reassemble_frames(&frames),
            Err(IpcProtocolError::IncompleteFragments)
        );
    }

    #[test]
    fn reassembly_rejects_metadata_mismatch() {
        let mut frames = fragment_payload(2, 3, 4, 5, 6, 7, b"abcdefgh", 3).unwrap();
        frames[1].header.correlation_id = 99;

        assert_eq!(
            reassemble_frames(&frames),
            Err(IpcProtocolError::FragmentMetadataMismatch)
        );
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    fn hex_bytes(value: &str) -> Vec<u8> {
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|chunk| {
                let pair = std::str::from_utf8(chunk).unwrap();
                u8::from_str_radix(pair, 16).unwrap()
            })
            .collect()
    }
}
