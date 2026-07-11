pub mod lane;
pub mod native;
pub mod protocol;
pub mod ring_buffer;

pub use lane::{BackpressureAction, IpcLane, LanePolicy};
pub use protocol::{
    fragment_payload, reassemble_frames, EncodedFrame, FrameHeader, IpcProtocolError,
    SharedMemoryHeader, ABI_VERSION, BYTE_ORDER, FRAME_HEADER_LEN, LIFECYCLE_FAILED,
    LIFECYCLE_READY, LIFECYCLE_STARTING, LIFECYCLE_STOPPED, MAGIC, MAX_FRAME_LENGTH,
    MAX_MESSAGE_LENGTH, PROTOCOL_VERSION, SHARED_MEMORY_HEADER_LEN,
};
pub use ring_buffer::{RingBufferError, SpscRingBuffer};
