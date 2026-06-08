use portable_pty::{Child, MasterPty};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, atomic::AtomicBool, mpsc::Sender},
};

#[derive(Clone, Default)]
pub struct Manager {
    inner: Arc<Mutex<State>>,
}

#[derive(Default)]
pub struct State {
    pub current_session_id: Option<String>,
    pub tasks: HashMap<String, Arc<TaskHandle>>,
    pub renderer_tx: Option<Sender<RendererEvent>>,
    pub rows: u16,
    pub cols: u16,
}

#[derive(Clone)]
pub struct TaskCompletion {
    pub task_id: String,
    pub success: bool,
}

pub enum TaskHandle {
    Process {
        child: Arc<Mutex<Box<dyn Child + Send>>>,
        master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    },
    Thread {
        cancel: Arc<AtomicBool>,
    },
}

#[derive(Clone)]
pub struct TaskSpec {
    pub task_id: String,
    pub region_id: String,
    pub step_index: u8,
    pub step_total: u8,
    pub name: String,
    pub command: String,
    pub program: String,
    pub args: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetadata {
    session_id: String,
    status: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStartedPayload {
    session_id: String,
    status: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardLogPayload {
    pub session_id: String,
    pub chunk: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStartedPayload {
    pub session_id: String,
    pub task_id: String,
    pub region_id: String,
    pub step_index: u8,
    pub step_total: u8,
    pub name: String,
    pub command: String,
    pub status: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatusPayload {
    pub session_id: String,
    pub task_id: String,
    pub region_id: String,
    pub status: String,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFinishedPayload {
    pub session_id: String,
    pub success: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardClearedPayload {
    pub session_id: Option<String>,
}

#[derive(Clone)]
pub enum RendererEvent {
    BufferRegions {
        region_ids: Vec<String>,
    },
    TaskStarted(TaskSpec),
    Output {
        task_id: String,
        region_id: String,
        chunk: Vec<u8>,
    },
    TaskFinished {
        task_id: String,
        region_id: String,
        status: String,
        exit_code: Option<i32>,
        error: Option<String>,
    },
    SessionFinished {
        success: bool,
    },
    FlushRegions {
        region_ids: Vec<String>,
    },
    Shutdown,
}
