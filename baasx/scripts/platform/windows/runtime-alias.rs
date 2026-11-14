// Legacy executable inside release packages. Inherit argv, environment, working
// directory and stdio, including the lease protocol's long-lived stdin pipe.
use std::{
    env,
    ffi::c_void,
    io, mem,
    process::{self, Command},
    ptr,
};

type Handle = *mut c_void;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;

#[repr(C)]
#[derive(Default)]
struct BasicLimits {
    process_time: i64,
    job_time: i64,
    flags: u32,
    minimum_working_set: usize,
    maximum_working_set: usize,
    active_process_limit: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

#[repr(C)]
#[derive(Default)]
struct ExtendedLimits {
    basic: BasicLimits,
    io_counters: [u64; 6],
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory: usize,
    peak_job_memory: usize,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> Handle;
    fn SetInformationJobObject(job: Handle, class: i32, data: *const c_void, size: u32) -> i32;
    fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
    fn GetCurrentProcess() -> Handle;
    fn SetConsoleCtrlHandler(
        handler: Option<unsafe extern "system" fn(u32) -> i32>,
        add: i32,
    ) -> i32;
}

// The helper handles console signals itself. The launcher must survive Ctrl+C
// long enough to relay its child's cancellation exit code.
unsafe extern "system" fn keep_parent_alive(event: u32) -> i32 {
    i32::from(event == 0 || event == 1)
}

fn forward() -> io::Result<i32> {
    let target = env::current_exe()?.with_file_name("baasx-runtime.exe");
    // Non-inheritable handle intentionally lives until the launcher exits.
    // Assign before spawn so even termination during startup cannot orphan the child.
    unsafe {
        let job = CreateJobObjectW(ptr::null_mut(), ptr::null());
        if job.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut limits = ExtendedLimits::default();
        limits.basic.flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            (&raw const limits).cast(),
            mem::size_of::<ExtendedLimits>() as u32,
        ) == 0
            || AssignProcessToJobObject(job, GetCurrentProcess()) == 0
        {
            return Err(io::Error::last_os_error());
        }
        // Non-console GUI parents may start us with no console attached.
        SetConsoleCtrlHandler(Some(keep_parent_alive), 1);
    }
    Ok(Command::new(target)
        .args(env::args_os().skip(1))
        .status()?
        .code()
        .unwrap_or(1))
}

fn main() {
    match forward() {
        Ok(code) => process::exit(code),
        Err(error) => {
            eprintln!("Cannot start baasx-runtime.exe: {error}");
            process::exit(1);
        }
    }
}
