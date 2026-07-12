use baas_ipc::{
    protocol::{EncodedFrame, FrameHeader, MESSAGE_KIND_BYTES, RING_CONTROL_BLOCK_LEN},
    ring_buffer::SharedRingBuffer,
};
use std::time::Instant;

fn main() {
    println!("payload_bytes,iterations,roundtrip_us,throughput_mib_s");
    for (payload_size, iterations) in [(1024, 20_000), (64 * 1024, 2_000), (1024 * 1024, 200)] {
        let mut region = vec![0_u8; RING_CONTROL_BLOCK_LEN + payload_size * 2 + 1024];
        let mut ring = SharedRingBuffer::initialize(&mut region, 1, 2).unwrap();
        let frame = EncodedFrame {
            header: FrameHeader {
                frame_version: 1,
                logical_channel_id: 4,
                stream_id: 1,
                message_kind: MESSAGE_KIND_BYTES,
                flags: 0,
                sequence_number: 1,
                correlation_id: 0,
                payload_length: payload_size as u32,
                fragment_index: 0,
                fragment_count: 1,
            },
            payload: vec![0xA5; payload_size],
        };
        let started = Instant::now();
        for _ in 0..iterations {
            ring.write_frame(&frame).unwrap();
            let received = ring.read_frame(payload_size).unwrap();
            assert_eq!(received.payload.len(), payload_size);
        }
        let elapsed = started.elapsed();
        let roundtrip_us = elapsed.as_secs_f64() * 1_000_000.0 / iterations as f64;
        let throughput = payload_size as f64 * iterations as f64 * 2.0
            / (1024.0 * 1024.0)
            / elapsed.as_secs_f64();
        println!("{payload_size},{iterations},{roundtrip_us:.3},{throughput:.2}");
    }
}
