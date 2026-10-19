"""Reproduce the archived receiver's fragmentation gap without restoring the app.

Run: python scripts/audit-archived-shm.py
Requires the archived commit locally and Rust dependencies in the Cargo cache.
The old remote branch has been retired; a saved Git bundle can restore its commit
with `git fetch <archive.bundle> refs/remotes/origin/archive/shared-memory-wip-20260712`.
The receiver probe injects explicit 64 KiB fragments. It does not claim that the
default Python sender fragments a 100 KiB response. The archived Rust sender does
fragment at 64 KiB; its default peer's reassembly must be audited separately.
The ring example measures the in-process ring algorithm, not IPC or WebView speed.
"""

from pathlib import Path
import argparse
import json
import subprocess


HARNESS = r'''
#![allow(dead_code)]
use baas_ipc::protocol::{self, EncodedFrame, CHANNEL_SYNC, MESSAGE_KIND_BYTES, MESSAGE_KIND_JSON};
use baas_ipc::ring_buffer::SharedRingBuffer;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug)]
struct BackendIpcMessage {
    channel: String, name: String, stream_id: u16, kind: String,
    sequence_number: u64, json: Option<Value>, bytes: Option<Vec<u8>>,
}

include!("include/archived_backend_message_from_frame.rs");

fn through_archived_ring(payload: &[u8], kind: u16) -> Vec<EncodedFrame> {
    let frames = protocol::fragment_payload(CHANNEL_SYNC, 0, kind, 0, 1, 0, payload, 64 * 1024).unwrap();
    let mut region = vec![0; protocol::RING_CONTROL_BLOCK_LEN + payload.len() + 4096];
    let mut ring = SharedRingBuffer::initialize(&mut region, 1, 2).unwrap();
    for frame in &frames { ring.write_frame(frame).unwrap(); }
    let mut received = Vec::new();
    loop {
        match ring.read_frame(protocol::MAX_FRAME_LENGTH as usize) {
            Ok(frame) => received.push(frame),
            Err(baas_ipc::RingBufferError::NotEnoughData) => break,
            Err(error) => panic!("ring failed: {error}"),
        }
    }
    received
}

fn reassembled_frame(frames: &[EncodedFrame]) -> EncodedFrame {
    let payload = protocol::reassemble_frames(frames).unwrap();
    let mut header = frames[0].header.clone();
    header.fragment_index = 0;
    header.fragment_count = 1;
    header.payload_length = payload.len() as u32;
    EncodedFrame { header, payload }
}

fn main() {
    let names = HashMap::new();
    let json_payload = serde_json::to_vec(&serde_json::json!({"data": "x".repeat(100_000)})).unwrap();
    let json_frames = through_archived_ring(&json_payload, MESSAGE_KIND_JSON);
    let json_results: Vec<_> = json_frames.iter().cloned()
        .map(|frame| backend_message_from_frame(frame, &names)).collect();
    assert!(json_results.iter().all(Result::is_err));
    let restored_json = backend_message_from_frame(reassembled_frame(&json_frames), &names).unwrap();
    assert_eq!(restored_json.json.unwrap()["data"].as_str().unwrap().len(), 100_000);

    let binary_payload: Vec<_> = (0..100_000).map(|index| (index % 251) as u8).collect();
    let binary_frames = through_archived_ring(&binary_payload, MESSAGE_KIND_BYTES);
    let binary_messages: Vec<_> = binary_frames.iter().cloned()
        .map(|frame| backend_message_from_frame(frame, &names).unwrap()).collect();
    assert_eq!(binary_messages.len(), 2);
    let restored_binary = backend_message_from_frame(reassembled_frame(&binary_frames), &names).unwrap();
    assert_eq!(restored_binary.bytes.unwrap(), binary_payload);

    println!("{}", serde_json::to_string_pretty(&serde_json::json!({
        "jsonPayloadBytes": json_payload.len(),
        "jsonFragments": json_frames.len(),
        "archivedJsonMessagesAccepted": json_results.iter().filter(|result| result.is_ok()).count(),
        "archivedJsonErrors": json_results.iter().map(|result| result.as_ref().unwrap_err()).collect::<Vec<_>>(),
        "binaryPayloadBytes": binary_payload.len(),
        "archivedBinaryMessageSizes": binary_messages.iter().map(|message| message.bytes.as_ref().unwrap().len()).collect::<Vec<_>>(),
        "expectedBinaryMessages": 1,
        "reassembledJsonAndBinaryMatch": true,
    })).unwrap());
}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", default="ccb75a4194f7d25cae00a5a0bb83011975644ad7")
    parser.add_argument("--out-dir", default=".codex_tmp/shared-memory-audit")
    args = parser.parse_args()
    repository = Path(__file__).resolve().parent.parent
    archived_commit = subprocess.run(
        ["git", "cat-file", "-e", f"{args.ref}^{{commit}}"],
        cwd=repository, capture_output=True,
    )
    if archived_commit.returncode:
        parser.error(
            "The historical snapshot is missing from this clone. Fetch it from the saved "
            "Git bundle and retry, or use --ref to select an available archived snapshot."
        )
    output = (repository / args.out_dir).resolve()
    output.mkdir(parents=True, exist_ok=True)

    def git_show(path):
        return subprocess.check_output(["git", "show", f"{args.ref}:{path}"], cwd=repository)

    files = subprocess.check_output(
        ["git", "ls-tree", "-r", "--name-only", args.ref, "crates/baas-ipc"],
        cwd=repository, text=True,
    ).splitlines()
    for source in files:
        destination = output / Path(source).relative_to("crates/baas-ipc")
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(git_show(source))
    manifest = output / "Cargo.toml"
    manifest.write_text(
        manifest.read_text(encoding="utf-8")
        + '\n[dev-dependencies]\nserde_json = "1"\n\n[workspace]\n', encoding="utf-8",
    )
    backend = git_show("src-tauri/src/backend_ipc_commands.rs").decode("utf-8")
    if ".min(64 * 1024)" not in backend:
        raise RuntimeError("Archive Rust sender's 64 KiB fragment threshold has changed")
    start = backend.index("fn backend_message_from_frame(")
    end = backend.index("\nfn resolve_stream_id(", start)
    (output / "examples/include").mkdir(exist_ok=True)
    (output / "examples/include/archived_backend_message_from_frame.rs").write_text(
        backend[start:end], encoding="utf-8",
    )
    # Keep the included function outside Cargo's automatic example discovery.
    (output / "examples/fragment_audit.rs").write_text(HARNESS, encoding="utf-8")
    commands = {
        "fragmentAudit": ["cargo", "run", "--offline", "--release", "--example", "fragment_audit"],
        "ringAlgorithmBenchmark": ["cargo", "run", "--offline", "--release", "--example", "ring_benchmark"],
    }
    report = {
        "archiveRef": args.ref,
        "archiveCommit": subprocess.check_output(["git", "rev-parse", args.ref], cwd=repository, text=True).strip(),
        "fragmentAuditScope": "Explicit fragmented input to archived Rust receiver; not the default Python-to-Rust 100 KiB response path",
        "archivedRustSenderFragmentBytes": 65536,
        "productionDirectionToAudit": "Rust-to-Python commands above 64 KiB; Python receiver must reassemble fragments",
        "ringBenchmarkScope": "in-process ring algorithm only; not cross-process IPC or WebView delivery",
    }
    for key, command in commands.items():
        completed = subprocess.run(command, cwd=output, text=True, capture_output=True, check=True)
        report[key] = json.loads(completed.stdout) if key == "fragmentAudit" else completed.stdout.strip()
    result = json.dumps(report, indent=2, ensure_ascii=False)
    (output / "audit-results.json").write_text(result + "\n", encoding="utf-8")
    print(result)


if __name__ == "__main__":
    main()
