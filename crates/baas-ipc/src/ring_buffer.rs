use crate::protocol::{
    IpcProtocolError, RingControlBlock, FRAME_HEADER_LEN, RING_CONTROL_BLOCK_LEN,
};
use thiserror::Error;

const READ_CURSOR_OFFSET: usize = 20;
const WRITE_CURSOR_OFFSET: usize = 24;
const SEQUENCE_NUMBER_OFFSET: usize = 44;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RingBufferError {
    #[error("ring buffer capacity must be greater than zero")]
    EmptyCapacity,
    #[error("ring buffer queue is full")]
    QueueFull,
    #[error("not enough bytes are available")]
    NotEnoughData,
    #[error("shared ring region is too small")]
    InvalidRegion,
    #[error("shared ring packet length is invalid")]
    InvalidPacketLength,
    #[error(transparent)]
    Protocol(#[from] IpcProtocolError),
}

#[derive(Debug, Clone)]
pub struct SpscRingBuffer {
    buffer: Vec<u8>,
    read_cursor: usize,
    write_cursor: usize,
    len: usize,
}

pub struct SharedRingBuffer<'a> {
    region: &'a mut [u8],
}

impl<'a> SharedRingBuffer<'a> {
    pub fn initialize(
        region: &'a mut [u8],
        generation_id_low: u64,
        generation_id_high: u64,
    ) -> Result<Self, RingBufferError> {
        if region.len() <= RING_CONTROL_BLOCK_LEN + 1 {
            return Err(RingBufferError::InvalidRegion);
        }
        let capacity = (region.len() - RING_CONTROL_BLOCK_LEN) as u32;
        let block = RingControlBlock::new(capacity, generation_id_low, generation_id_high);
        region[..RING_CONTROL_BLOCK_LEN].copy_from_slice(&block.encode()?);
        region[RING_CONTROL_BLOCK_LEN..].fill(0);
        Ok(Self { region })
    }

    pub fn open(region: &'a mut [u8]) -> Result<Self, RingBufferError> {
        if region.len() <= RING_CONTROL_BLOCK_LEN + 1 {
            return Err(RingBufferError::InvalidRegion);
        }
        let block = RingControlBlock::decode(&region[..RING_CONTROL_BLOCK_LEN])?;
        if block.capacity as usize != region.len() - RING_CONTROL_BLOCK_LEN {
            return Err(RingBufferError::InvalidRegion);
        }
        Ok(Self { region })
    }

    pub fn control_block(&self) -> Result<RingControlBlock, RingBufferError> {
        Ok(RingControlBlock::decode(
            &self.region[..RING_CONTROL_BLOCK_LEN],
        )?)
    }

    pub fn available_read(&self) -> Result<usize, RingBufferError> {
        let block = self.control_block()?;
        Ok(available_read(block))
    }

    pub fn available_write(&self) -> Result<usize, RingBufferError> {
        let block = self.control_block()?;
        let capacity = block.capacity as usize;
        Ok(capacity - available_read(block) - 1)
    }

    pub fn write_packet(&mut self, payload: &[u8]) -> Result<(), RingBufferError> {
        self.write_packet_parts(payload.len(), &[payload])
    }

    fn write_packet_parts(
        &mut self,
        payload_len: usize,
        parts: &[&[u8]],
    ) -> Result<(), RingBufferError> {
        if parts.iter().map(|part| part.len()).sum::<usize>() != payload_len {
            return Err(RingBufferError::InvalidPacketLength);
        }
        let packet_len = payload_len + 4;
        if packet_len > self.available_write()? {
            return Err(RingBufferError::QueueFull);
        }
        self.write_bytes(&(payload_len as u32).to_le_bytes())?;
        for part in parts {
            self.write_bytes(part)?;
        }
        let block = self.control_block()?;
        self.write_u64(
            SEQUENCE_NUMBER_OFFSET,
            block.sequence_number.wrapping_add(1),
        );
        Ok(())
    }

    pub fn read_packet(&mut self, max_payload_len: usize) -> Result<Vec<u8>, RingBufferError> {
        if self.available_read()? < 4 {
            return Err(RingBufferError::NotEnoughData);
        }
        let len_bytes = self.peek_bytes(4)?;
        let payload_len = u32::from_le_bytes(len_bytes.try_into().unwrap()) as usize;
        if payload_len > max_payload_len {
            return Err(RingBufferError::InvalidPacketLength);
        }
        if payload_len + 4 > self.available_read()? {
            return Err(RingBufferError::NotEnoughData);
        }
        let _ = self.read_bytes(4)?;
        self.read_bytes(payload_len)
    }

    pub fn write_frame(
        &mut self,
        frame: &crate::protocol::EncodedFrame,
    ) -> Result<(), RingBufferError> {
        let header = frame.header.encode()?;
        self.write_packet_parts(
            FRAME_HEADER_LEN + frame.payload.len(),
            &[&header, &frame.payload],
        )
    }

    pub fn read_frame(
        &mut self,
        max_payload_len: usize,
    ) -> Result<crate::protocol::EncodedFrame, RingBufferError> {
        if self.available_read()? < 4 {
            return Err(RingBufferError::NotEnoughData);
        }
        let packet_len = u32::from_le_bytes(self.peek_bytes(4)?.try_into().unwrap()) as usize;
        if packet_len < FRAME_HEADER_LEN || packet_len > FRAME_HEADER_LEN + max_payload_len {
            return Err(RingBufferError::InvalidPacketLength);
        }
        if packet_len + 4 > self.available_read()? {
            return Err(RingBufferError::NotEnoughData);
        }
        let _ = self.read_bytes(4)?;
        let header_bytes = self.read_bytes(FRAME_HEADER_LEN)?;
        let header = crate::protocol::FrameHeader::decode(&header_bytes)?;
        let payload = self.read_bytes(packet_len - FRAME_HEADER_LEN)?;
        if payload.len() != header.payload_length as usize {
            return Err(RingBufferError::InvalidPacketLength);
        }
        Ok(crate::protocol::EncodedFrame { header, payload })
    }

    fn write_bytes(&mut self, payload: &[u8]) -> Result<(), RingBufferError> {
        let mut block = self.control_block()?;
        let capacity = block.capacity as usize;
        let data = &mut self.region[RING_CONTROL_BLOCK_LEN..];
        let cursor = block.write_cursor as usize;
        let first_len = payload.len().min(capacity - cursor);
        data[cursor..cursor + first_len].copy_from_slice(&payload[..first_len]);
        let remaining = payload.len() - first_len;
        if remaining > 0 {
            data[..remaining].copy_from_slice(&payload[first_len..]);
        }
        block.write_cursor = ((cursor + payload.len()) % capacity) as u32;
        self.write_u32(WRITE_CURSOR_OFFSET, block.write_cursor);
        Ok(())
    }

    fn read_bytes(&mut self, len: usize) -> Result<Vec<u8>, RingBufferError> {
        if len > self.available_read()? {
            return Err(RingBufferError::NotEnoughData);
        }
        let mut block = self.control_block()?;
        let capacity = block.capacity as usize;
        let data = &self.region[RING_CONTROL_BLOCK_LEN..];
        let cursor = block.read_cursor as usize;
        let first_len = len.min(capacity - cursor);
        let mut output = vec![0_u8; len];
        output[..first_len].copy_from_slice(&data[cursor..cursor + first_len]);
        let remaining = len - first_len;
        if remaining > 0 {
            output[first_len..].copy_from_slice(&data[..remaining]);
        }
        block.read_cursor = ((cursor + len) % capacity) as u32;
        self.write_u32(READ_CURSOR_OFFSET, block.read_cursor);
        Ok(output)
    }

    fn peek_bytes(&self, len: usize) -> Result<Vec<u8>, RingBufferError> {
        if len > self.available_read()? {
            return Err(RingBufferError::NotEnoughData);
        }
        let block = self.control_block()?;
        let capacity = block.capacity as usize;
        let data = &self.region[RING_CONTROL_BLOCK_LEN..];
        let cursor = block.read_cursor as usize;
        let first_len = len.min(capacity - cursor);
        let mut output = vec![0_u8; len];
        output[..first_len].copy_from_slice(&data[cursor..cursor + first_len]);
        let remaining = len - first_len;
        if remaining > 0 {
            output[first_len..].copy_from_slice(&data[..remaining]);
        }
        Ok(output)
    }

    fn write_u32(&mut self, offset: usize, value: u32) {
        self.region[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn write_u64(&mut self, offset: usize, value: u64) {
        self.region[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }
}

fn available_read(block: RingControlBlock) -> usize {
    let read = block.read_cursor as usize;
    let write = block.write_cursor as usize;
    let capacity = block.capacity as usize;
    if write >= read {
        write - read
    } else {
        capacity - read + write
    }
}

impl SpscRingBuffer {
    pub fn new(capacity: usize) -> Result<Self, RingBufferError> {
        if capacity == 0 {
            return Err(RingBufferError::EmptyCapacity);
        }
        Ok(Self {
            buffer: vec![0; capacity],
            read_cursor: 0,
            write_cursor: 0,
            len: 0,
        })
    }

    pub fn capacity(&self) -> usize {
        self.buffer.len()
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn available_write(&self) -> usize {
        self.capacity() - self.len
    }

    pub fn write(&mut self, payload: &[u8]) -> Result<(), RingBufferError> {
        if payload.len() > self.available_write() {
            return Err(RingBufferError::QueueFull);
        }
        for byte in payload {
            self.buffer[self.write_cursor] = *byte;
            self.write_cursor = (self.write_cursor + 1) % self.capacity();
        }
        self.len += payload.len();
        Ok(())
    }

    pub fn read(&mut self, len: usize) -> Result<Vec<u8>, RingBufferError> {
        if len > self.len {
            return Err(RingBufferError::NotEnoughData);
        }
        let mut out = Vec::with_capacity(len);
        for _ in 0..len {
            out.push(self.buffer[self.read_cursor]);
            self.read_cursor = (self.read_cursor + 1) % self.capacity();
        }
        self.len -= len;
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{fragment_payload, FRAME_HEADER_LEN, RING_CONTROL_BLOCK_LEN};

    #[test]
    fn writes_and_reads_empty_payload() {
        let mut ring = SpscRingBuffer::new(4).unwrap();

        ring.write(&[]).unwrap();

        assert_eq!(ring.read(0).unwrap(), b"");
        assert_eq!(ring.len(), 0);
    }

    #[test]
    fn wraps_around_capacity_boundary() {
        let mut ring = SpscRingBuffer::new(5).unwrap();

        ring.write(b"abcd").unwrap();
        assert_eq!(ring.read(3).unwrap(), b"abc");
        ring.write(b"efgh").unwrap();

        assert_eq!(ring.read(5).unwrap(), b"defgh");
    }

    #[test]
    fn rejects_queue_full_without_mutating_existing_bytes() {
        let mut ring = SpscRingBuffer::new(4).unwrap();

        ring.write(b"abc").unwrap();
        assert_eq!(ring.write(b"de"), Err(RingBufferError::QueueFull));

        assert_eq!(ring.read(3).unwrap(), b"abc");
    }

    #[test]
    fn rejects_read_past_available_data() {
        let mut ring = SpscRingBuffer::new(4).unwrap();
        ring.write(b"ab").unwrap();

        assert_eq!(ring.read(3), Err(RingBufferError::NotEnoughData));
    }

    #[test]
    fn shared_ring_writes_and_reads_packet() {
        let mut region = vec![0_u8; RING_CONTROL_BLOCK_LEN + 16];
        let mut ring = SharedRingBuffer::initialize(&mut region, 1, 2).unwrap();

        ring.write_packet(b"hello").unwrap();

        assert_eq!(ring.available_read().unwrap(), 9);
        assert_eq!(ring.read_packet(16).unwrap(), b"hello");
        assert_eq!(ring.available_read().unwrap(), 0);
    }

    #[test]
    fn shared_ring_wraps_packet_across_data_boundary() {
        let mut region = vec![0_u8; RING_CONTROL_BLOCK_LEN + 12];
        let mut ring = SharedRingBuffer::initialize(&mut region, 1, 2).unwrap();

        ring.write_packet(b"ab").unwrap();
        assert_eq!(ring.read_packet(8).unwrap(), b"ab");
        ring.write_packet(b"cde").unwrap();

        assert_eq!(ring.read_packet(8).unwrap(), b"cde");
    }

    #[test]
    fn shared_ring_rejects_packet_when_queue_full() {
        let mut region = vec![0_u8; RING_CONTROL_BLOCK_LEN + 10];
        let mut ring = SharedRingBuffer::initialize(&mut region, 1, 2).unwrap();

        assert_eq!(
            ring.write_packet(b"abcdef"),
            Err(RingBufferError::QueueFull)
        );
        assert_eq!(ring.available_read().unwrap(), 0);
    }

    #[test]
    fn shared_ring_round_trips_encoded_frame() {
        let mut region = vec![0_u8; RING_CONTROL_BLOCK_LEN + 128];
        let mut ring = SharedRingBuffer::initialize(&mut region, 1, 2).unwrap();
        let frame = fragment_payload(2, 3, 4, 5, 6, 7, b"abc", 8)
            .unwrap()
            .remove(0);

        ring.write_frame(&frame).unwrap();

        assert_eq!(
            ring.available_read().unwrap(),
            4 + FRAME_HEADER_LEN + frame.payload.len()
        );
        assert_eq!(ring.read_frame(8).unwrap(), frame);
    }
}
