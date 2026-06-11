use baas_term::{
    processor::{ScriptCommand, create_process_task},
    threader::{ThreadLogStyle, ThreadOutput, create_thread_task},
    types::{DashboardLogPayload, RendererEvent, SessionMetadata, TaskStartedPayload},
};
use serde_json::json;
use std::sync::mpsc;

fn recv_output(rx: &mpsc::Receiver<RendererEvent>) -> String {
    match rx.recv().unwrap() {
        RendererEvent::Output { chunk, .. } => String::from_utf8(chunk).unwrap(),
        _ => panic!("expected output event"),
    }
}

#[test]
fn public_process_task_constructor_preserves_command_metadata() {
    let spec = create_process_task(
        "task",
        "region",
        1,
        "Build",
        ScriptCommand {
            program: "cargo".to_string(),
            args: vec!["test".to_string()],
            display: "cargo test".to_string(),
        },
    );

    assert_eq!(spec.task_id, "task");
    assert_eq!(spec.region_id, "region");
    assert_eq!(spec.step_index, 1);
    assert_eq!(spec.step_total, 4);
    assert_eq!(spec.name, "Build");
    assert_eq!(spec.command, "cargo test");
    assert_eq!(spec.program, "cargo");
    assert_eq!(spec.args, ["test"]);
}

#[test]
fn public_thread_task_constructor_preserves_display_metadata() {
    let spec = create_thread_task("task", "region", 3, "Scan", "scan assets");

    assert_eq!(spec.task_id, "task");
    assert_eq!(spec.region_id, "region");
    assert_eq!(spec.step_index, 3);
    assert_eq!(spec.step_total, 4);
    assert_eq!(spec.name, "Scan");
    assert_eq!(spec.command, "scan assets");
    assert!(spec.program.is_empty());
    assert!(spec.args.is_empty());
}

#[test]
fn public_thread_output_helpers_emit_renderer_output_events() {
    let (tx, rx) = mpsc::channel();
    let output = ThreadOutput {
        task_id: "task".to_string(),
        region_id: "region".to_string(),
        tx,
    };

    output.write("raw");
    output.log().line(ThreadLogStyle::Info, "info");

    assert_eq!(recv_output(&rx), "raw");
    assert_eq!(recv_output(&rx), "\x1b[36minfo\x1b[0m\r\n");
}

#[test]
fn public_payloads_serialize_with_camel_case_fields() {
    assert_eq!(
        serde_json::to_value(SessionMetadata {
            session_id: "session".to_string(),
            status: "running".to_string(),
        })
        .unwrap(),
        json!({
            "sessionId": "session",
            "status": "running"
        })
    );

    assert_eq!(
        serde_json::to_value(DashboardLogPayload {
            session_id: "session".to_string(),
            chunk: "hello".to_string(),
        })
        .unwrap(),
        json!({
            "sessionId": "session",
            "chunk": "hello"
        })
    );

    assert_eq!(
        serde_json::to_value(TaskStartedPayload {
            session_id: "session".to_string(),
            task_id: "task".to_string(),
            region_id: "region".to_string(),
            step_index: 2,
            step_total: 4,
            name: "Task".to_string(),
            command: "run".to_string(),
            status: "running".to_string(),
        })
        .unwrap(),
        json!({
            "sessionId": "session",
            "taskId": "task",
            "regionId": "region",
            "stepIndex": 2,
            "stepTotal": 4,
            "name": "Task",
            "command": "run",
            "status": "running"
        })
    );
}
