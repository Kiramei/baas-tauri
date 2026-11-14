use self::portable_transaction::{
    apply_transaction, reject_link, rollback_transaction, runtime_name, stage_payload,
    Architecture, PackageKind, ReadySignal as Signal, Swap, SwapFileSystem,
};
#[path = "portable_transaction.rs"]
mod portable_transaction;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{Child, Command},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use windows::{
    core::PWSTR,
    Win32::{
        Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0},
        System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject, PROCESS_NAME_FORMAT,
            PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        },
    },
};

static PREPARING: Mutex<()> = Mutex::new(());
const HELPER_FLAG: &str = "--baas-client-update-helper";
const READY_FLAG: &str = "--baas-client-update-ready";
const ROLLBACK_FLAG: &str = "--baas-client-update-rollback";
const LOCK_NAME: &str = ".baas-client-update.lock";
pub const FIXED_ENDPOINTS: &[&str] = &[
    "https://cnb.cool/kiramei/baas-tauri/-/releases/download/updater/update-fixed-webview2-cnb.json",
    "https://gh-proxy.org/https://github.com/Kiramei/baas-tauri/releases/download/updater/update-fixed-webview2-proxy.json",
    "https://github.com/Kiramei/baas-tauri/releases/download/updater/update-fixed-webview2.json",
];

fn architecture() -> Result<Architecture, String> {
    match std::env::consts::ARCH {
        "x86_64" => Ok(Architecture::X64),
        "aarch64" => Ok(Architecture::Arm64),
        _ => Err("Portable updates are not available for this Windows architecture".into()),
    }
}
fn same_path(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left
            .to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy()),
        _ => false,
    }
}
fn fixed_runtime(app: &AppHandle) -> Result<Option<String>, String> {
    if let tauri::utils::config::WebviewInstallMode::FixedRuntime { path } =
        &app.config().bundle.windows.webview_install_mode
    {
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("Invalid fixed WebView2 runtime path")?;
        if !runtime_name(name, architecture()?) {
            return Err("Unsupported fixed WebView2 runtime directory".into());
        }
        return Ok(Some(name.to_string()));
    }
    Ok(None)
}
pub fn uses_fixed_runtime(app: &AppHandle) -> bool {
    matches!(
        app.config().bundle.windows.webview_install_mode,
        tauri::utils::config::WebviewInstallMode::FixedRuntime { .. }
    )
}

/// Backend data layout is deliberately independent from client distribution.
pub fn is_portable_client(app: &AppHandle) -> bool {
    if !matches!(
        tauri::utils::platform::bundle_type(),
        Some(tauri::utils::config::BundleType::Nsis)
    ) {
        return true;
    }
    let Ok(executable) = std::env::current_exe().and_then(|path| path.canonicalize()) else {
        return true;
    };
    let Some(parent) = executable.parent() else {
        return true;
    };
    let product = app.config().product_name.as_deref().unwrap_or("BAAS Tauri");
    let publisher = app
        .config()
        .bundle
        .publisher
        .as_deref()
        .unwrap_or("Kiramei");
    let key = format!(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{product}");
    for hive in [
        windows_registry::LOCAL_MACHINE,
        windows_registry::CURRENT_USER,
    ] {
        for view in [0x100, 0x200] {
            let Ok(registry) = hive.options().read().access(view).open(&key) else {
                continue;
            };
            let Ok(location) = registry.get_string("InstallLocation") else {
                continue;
            };
            let Ok(binary) = registry.get_string("MainBinaryName") else {
                continue;
            };
            let Ok(uninstaller) = registry.get_string("UninstallString") else {
                continue;
            };
            if registry.get_string("Publisher").ok().as_deref() != Some(publisher) {
                continue;
            }
            let directory = PathBuf::from(location.trim().trim_matches('"'));
            let uninstall = PathBuf::from(uninstaller.trim().trim_matches('"'));
            if Path::new(&binary).components().count() == 1
                && same_path(parent, &directory)
                && same_path(&executable, &directory.join(binary))
                && same_path(&uninstall, &directory.join("uninstall.exe"))
                && uninstall.is_file()
            {
                return false;
            }
        }
    }
    true
}
pub fn portable_target() -> Result<&'static str, String> {
    match architecture()? {
        Architecture::X64 => Ok("windows-x86_64-portable"),
        Architecture::Arm64 => Ok("windows-aarch64-portable"),
    }
}

pub fn validate_download(app: &AppHandle, url: &url::Url) -> Result<(), String> {
    let name = url
        .path_segments()
        .and_then(|mut parts| parts.next_back())
        .ok_or("Missing portable package filename")?;
    portable_transaction::validate_package_name(
        name,
        if uses_fixed_runtime(app) {
            PackageKind::FixedWebview
        } else {
            PackageKind::RawExe
        },
        architecture()?,
    )
}

fn hex_digest(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hash_file(path: &Path) -> Result<String, String> {
    reject_link(path)?;
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hash = Sha256::new();
    let mut bytes = [0_u8; 64 * 1024];
    loop {
        let size = file.read(&mut bytes).map_err(|error| error.to_string())?;
        if size == 0 {
            break;
        }
        hash.update(&bytes[..size]);
    }
    Ok(hex_digest(&hash.finalize()))
}
fn hash_tree(path: &Path) -> Result<String, String> {
    reject_link(path)?;
    if path.is_file() {
        return hash_file(path);
    }
    if !path.is_dir() {
        return Err("Portable component is not a regular file or directory".into());
    }
    fn visit(
        root: &Path,
        path: &Path,
        entries: &mut Vec<(String, String)>,
        depth: usize,
    ) -> Result<(), String> {
        if depth > 32 {
            return Err("Portable component nesting exceeds the safe limit".into());
        }
        reject_link(path)?;
        if entries.len() > portable_transaction::MAX_ARCHIVE_ENTRIES {
            return Err("Portable component has too many files".into());
        }
        for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
            let path = entry.map_err(|error| error.to_string())?.path();
            reject_link(&path)?;
            if path.is_dir() {
                visit(root, &path, entries, depth + 1)?;
            } else if path.is_file() {
                entries.push((
                    path.strip_prefix(root)
                        .map_err(|error| error.to_string())?
                        .to_string_lossy()
                        .replace('\\', "/"),
                    hash_file(&path)?,
                ));
            } else {
                return Err("Portable component contains a special file".into());
            }
        }
        Ok(())
    }
    let mut entries = Vec::new();
    visit(path, path, &mut entries, 0)?;
    entries.sort();
    let mut hash = Sha256::new();
    for (name, value) in entries {
        hash.update((name.len() as u64).to_le_bytes());
        hash.update(name.as_bytes());
        hash.update(value.as_bytes());
    }
    Ok(hex_digest(&hash.finalize()))
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| error.to_string())
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    swap: Swap,
    old: Option<String>,
    new: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Plan {
    nonce: String,
    parent_pid: u32,
    executable: PathBuf,
    helper: PathBuf,
    original_sha: String,
    stage: PathBuf,
    private: PathBuf,
    version: String,
    arch: String,
    args: Vec<String>,
    entries: Vec<Entry>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Outcome {
    nonce: String,
    completed: bool,
    error: Option<String>,
}
fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    reject_link(path)?;
    if fs::metadata(path).map_err(|error| error.to_string())?.len() > 4 * 1024 * 1024 {
        return Err("Portable update plan is too large".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}
fn load_plan(path: &Path, hash: &str, nonce: &str) -> Result<Plan, String> {
    if hash_file(path)? != hash {
        return Err("Portable update plan changed".into());
    }
    let plan: Plan = read_json(path)?;
    if plan.nonce != nonce
        || nonce.len() != 32
        || !nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Invalid portable update nonce".into());
    }
    let root = plan
        .executable
        .parent()
        .ok_or("Portable executable has no parent")?;
    for path in [&plan.executable, &plan.helper, &plan.stage, &plan.private] {
        if !path.is_absolute()
            || path
                .components()
                .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
        {
            return Err("Portable update path must be absolute and normalized".into());
        }
    }
    reject_link(root)?;
    reject_link(&plan.private)?;
    reject_link(&plan.stage)?;
    if plan.stage != root.join(format!(".baas-client-update-{nonce}"))
        || plan.helper != plan.private.join("helper.exe")
        || path != plan.private.join("plan.json")
        || plan.private.file_name().and_then(|name| name.to_str()) != Some(nonce)
        || plan.entries.is_empty()
        || plan.entries.len() > 4
    {
        return Err("Portable update ownership/path mismatch".into());
    }
    let arch = match plan.arch.as_str() {
        "x64" => Architecture::X64,
        "arm64" => Architecture::Arm64,
        _ => return Err("Unknown portable architecture".into()),
    };
    let mut targets = std::collections::HashSet::new();
    for entry in &plan.entries {
        let name = entry
            .swap
            .target
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("Invalid client component name")?;
        if entry.swap.target.parent() != Some(root)
            || (!same_path(&entry.swap.target, &plan.executable)
                && entry.swap.target != plan.executable
                && name != "WebView2Loader.dll"
                && !runtime_name(name, arch))
            || entry.swap.backup.parent() != Some(plan.stage.join("backup").as_path())
            || !targets.insert(entry.swap.target.clone())
        {
            return Err("Portable transaction attempts to change an unmanaged component".into());
        }
        if let Some(staged) = &entry.swap.staged {
            if !staged.starts_with(plan.stage.join("payload"))
                || staged
                    .components()
                    .any(|part| matches!(part, Component::ParentDir))
            {
                return Err("Portable staging path escaped its payload".into());
            }
        }
    }
    let lock: Signal = read_json(&root.join(LOCK_NAME))?;
    if lock.nonce != nonce || lock.pid != plan.parent_pid || lock.version != plan.version {
        return Err("Portable update no longer owns the directory lock".into());
    }
    Ok(plan)
}

struct Disk;
impl SwapFileSystem for Disk {
    fn exists(&self, path: &Path) -> Result<bool, String> {
        match fs::symlink_metadata(path) {
            Ok(_) => {
                reject_link(path)?;
                Ok(true)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.to_string()),
        }
    }
    fn rename(&mut self, from: &Path, to: &Path) -> Result<(), String> {
        reject_link(from)?;
        reject_link(to.parent().ok_or("Missing portable component parent")?)?;
        if self.exists(to)? {
            return Err("Portable destination is already occupied".into());
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match fs::rename(from, to) {
                Ok(()) => return Ok(()),
                Err(error) if Instant::now() >= deadline => return Err(error.to_string()),
                Err(_) => thread::sleep(Duration::from_millis(100)),
            }
        }
    }
}
struct Process(HANDLE);
impl Drop for Process {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}
fn process_image(process: &Process) -> Result<PathBuf, String> {
    let mut name = vec![0_u16; 32768];
    let mut len = name.len() as u32;
    unsafe {
        QueryFullProcessImageNameW(
            process.0,
            PROCESS_NAME_FORMAT(0),
            PWSTR(name.as_mut_ptr()),
            &mut len,
        )
    }
    .map_err(|error| error.to_string())?;
    Ok(PathBuf::from(String::from_utf16_lossy(
        &name[..len as usize],
    )))
}
fn parent_handle(plan: &Plan) -> Result<Process, String> {
    if plan.parent_pid == std::process::id() {
        return Err("Portable helper cannot wait for itself".into());
    }
    let process = Process(
        unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                false,
                plan.parent_pid,
            )
        }
        .map_err(|error| error.to_string())?,
    );
    let image = process_image(&process)?;
    if !same_path(&image, &plan.executable) {
        return Err("Portable update parent identity mismatch".into());
    }
    Ok(process)
}
fn clean_stage(plan: &Plan) {
    let _ = fs::remove_dir_all(&plan.stage);
    if let Some(root) = plan.executable.parent() {
        if read_json::<Signal>(&root.join(LOCK_NAME)).is_ok_and(|signal| signal.nonce == plan.nonce)
        {
            let _ = fs::remove_file(root.join(LOCK_NAME));
        }
    }
}
fn start_client(
    plan: &Plan,
    plan_path: &Path,
    plan_hash: &str,
    rollback: bool,
) -> Result<Child, String> {
    Command::new(&plan.executable)
        .current_dir(plan.executable.parent().unwrap())
        .args(&plan.args)
        .arg(if rollback { ROLLBACK_FLAG } else { READY_FLAG })
        .arg(plan_path)
        .arg(plan_hash)
        .arg(&plan.nonce)
        .spawn()
        .map_err(|error| error.to_string())
}

pub fn prepare(app: &AppHandle, bytes: Vec<u8>, version: String) -> Result<(), String> {
    let _preparing = PREPARING
        .try_lock()
        .map_err(|_| "A portable update is already being prepared")?;
    let executable = std::env::current_exe()
        .and_then(|path| path.canonicalize())
        .map_err(|error| error.to_string())?;
    let root = executable
        .parent()
        .ok_or("Portable client directory is unavailable")?;
    reject_link(root)?;
    reject_link(&executable)?;
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let private = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("client-update")
        .join(&nonce);
    fs::create_dir_all(private.parent().unwrap()).map_err(|error| error.to_string())?;
    reject_link(private.parent().unwrap())?;
    fs::create_dir(&private).map_err(|error| error.to_string())?;
    let stage = root.join(format!(".baas-client-update-{nonce}"));
    let signal = Signal {
        nonce: nonce.clone(),
        pid: std::process::id(),
        version: version.clone(),
    };
    if let Err(error) = write_new(
        &root.join(LOCK_NAME),
        &serde_json::to_vec(&signal).map_err(|error| error.to_string())?,
    ) {
        let _ = fs::remove_dir(&private);
        return Err(error);
    }
    let result = (|| {
        fs::create_dir(&stage).map_err(|error| error.to_string())?;
        fs::create_dir(stage.join("backup")).map_err(|error| error.to_string())?;
        let old_runtime = fixed_runtime(app)?;
        let payload = stage_payload(
            &bytes,
            &stage.join("payload"),
            if old_runtime.is_some() {
                PackageKind::FixedWebview
            } else {
                PackageKind::RawExe
            },
            architecture()?,
        )?;
        let mut swaps = Vec::new();
        if let Some((name, staged)) = payload.runtime {
            if old_runtime.as_deref() != Some(&name)
                && root
                    .join(&name)
                    .try_exists()
                    .map_err(|error| error.to_string())?
            {
                return Err("New WebView2 runtime destination is already occupied".into());
            }
            swaps.push(Swap {
                target: root.join(&name),
                staged: Some(staged),
                backup: stage.join("backup/runtime"),
            });
            if let Some(old) = &old_runtime {
                if old != &name {
                    swaps.push(Swap {
                        target: root.join(old),
                        staged: None,
                        backup: stage.join("backup/old-runtime"),
                    });
                }
            }
        }
        if let Some(loader) = payload.loader {
            swaps.push(Swap {
                target: root.join("WebView2Loader.dll"),
                staged: Some(loader),
                backup: stage.join("backup/loader.dll"),
            });
        }
        swaps.push(Swap {
            target: executable.clone(),
            staged: Some(payload.executable),
            backup: stage.join("backup/client.exe"),
        });
        let entries = swaps
            .into_iter()
            .map(|swap| {
                let old = if Disk.exists(&swap.target)? {
                    Some(hash_tree(&swap.target)?)
                } else {
                    None
                };
                let new = swap.staged.as_deref().map(hash_tree).transpose()?;
                Ok(Entry { swap, old, new })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let helper = private.join("helper.exe");
        fs::copy(&executable, &helper).map_err(|error| error.to_string())?;
        let original_sha = hash_file(&executable)?;
        if hash_file(&helper)? != original_sha {
            return Err("Portable helper copy verification failed".into());
        }
        let mut args = Vec::new();
        let mut input = std::env::args().skip(1);
        while let Some(arg) = input.next() {
            if arg == READY_FLAG || arg == ROLLBACK_FLAG {
                for _ in 0..3 {
                    input.next();
                }
            } else {
                args.push(arg);
            }
        }
        let plan = Plan {
            nonce: nonce.clone(),
            parent_pid: std::process::id(),
            executable: executable.clone(),
            helper: helper.clone(),
            original_sha,
            stage: stage.clone(),
            private: private.clone(),
            version,
            arch: if architecture()? == Architecture::X64 {
                "x64"
            } else {
                "arm64"
            }
            .into(),
            args,
            entries,
        };
        let path = private.join("plan.json");
        let encoded = serde_json::to_vec(&plan).map_err(|error| error.to_string())?;
        write_new(&path, &encoded)?;
        let digest = hex_digest(&Sha256::digest(&encoded));
        let mut helper = Command::new(helper)
            .arg(HELPER_FLAG)
            .arg(&path)
            .arg(&digest)
            .arg(&nonce)
            .spawn()
            .map_err(|error| error.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Ok(ready) = read_json::<Signal>(&private.join("ready.json")) {
                if ready.matches(&nonce, helper.id(), &plan.version) {
                    return Ok(());
                }
            }
            if helper
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_some()
                || Instant::now() >= deadline
            {
                let _ = helper.kill();
                let _ = helper.wait();
                let detail = read_json::<Outcome>(&private.join("result.json"))
                    .ok()
                    .and_then(|result| result.error)
                    .unwrap_or_else(|| {
                        "Portable update helper could not establish its ready handshake".into()
                    });
                return Err(detail);
            }
            thread::sleep(Duration::from_millis(50));
        }
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&stage);
        let _ = fs::remove_dir_all(&private);
        if read_json::<Signal>(&root.join(LOCK_NAME)).is_ok_and(|signal| signal.nonce == nonce) {
            let _ = fs::remove_file(root.join(LOCK_NAME));
        }
    }
    result
}

// This guard owns only the exact child handle created by this transaction.
struct LaunchedClient(Option<Child>);
impl Drop for LaunchedClient {
    fn drop(&mut self) {
        if let Some(child) = &mut self.0 {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn run_helper(path: &Path, digest: &str, nonce: &str) -> Result<(), String> {
    let plan = load_plan(path, digest, nonce)?;
    if !same_path(
        &std::env::current_exe().map_err(|error| error.to_string())?,
        &plan.helper,
    ) || hash_file(&plan.helper)? != plan.original_sha
    {
        return Err("Portable helper identity/hash mismatch".into());
    }
    let mut parent_exited = false;
    let result = (|| {
        let parent = parent_handle(&plan)?;
        for entry in &plan.entries {
            if let Some(staged) = &entry.swap.staged {
                if Some(hash_tree(staged)?) != entry.new {
                    return Err("Staged portable component changed".into());
                }
            }
        }
        write_new(
            &plan.private.join("ready.json"),
            &serde_json::to_vec(&Signal {
                nonce: nonce.into(),
                pid: std::process::id(),
                version: plan.version.clone(),
            })
            .map_err(|error| error.to_string())?,
        )?;
        if unsafe { WaitForSingleObject(parent.0, 60_000) } != WAIT_OBJECT_0 {
            return Err("Original client did not exit; portable update was not applied".into());
        }
        parent_exited = true;
        for entry in &plan.entries {
            let old = if Disk.exists(&entry.swap.target)? {
                Some(hash_tree(&entry.swap.target)?)
            } else {
                None
            };
            if old != entry.old {
                return Err("Installed portable component changed before replacement".into());
            }
        }
        let applied = apply_transaction(
            &mut Disk,
            &plan
                .entries
                .iter()
                .map(|entry| entry.swap.clone())
                .collect::<Vec<_>>(),
        )?;
        let launch = (|| -> Result<(), String> {
            let mut child = LaunchedClient(Some(start_client(&plan, path, digest, false)?));
            let deadline = Instant::now() + Duration::from_secs(90);
            loop {
                if child
                    .0
                    .as_mut()
                    .unwrap()
                    .try_wait()
                    .map_err(|error| error.to_string())?
                    .is_some()
                {
                    return Err("Updated client exited before its UI became ready".into());
                }
                if let Ok(ack) = read_json::<Signal>(&plan.private.join("ack.json")) {
                    if ack.matches(nonce, child.0.as_ref().unwrap().id(), &plan.version) {
                        child.0.take();
                        return Ok(());
                    }
                }
                if Instant::now() >= deadline {
                    return Err("Updated client did not acknowledge a ready UI; restoring the previous client".into());
                }
                thread::sleep(Duration::from_millis(100));
            }
        })();
        if let Err(error) = launch {
            rollback_transaction(&mut Disk, &applied)?;
            return Err(error);
        }
        clean_stage(&plan);
        Ok(())
    })();
    let outcome = Outcome {
        nonce: nonce.into(),
        completed: result.is_ok(),
        error: result.as_ref().err().cloned(),
    };
    let _ = write_new(
        &plan.private.join("result.json"),
        &serde_json::to_vec(&outcome).unwrap_or_default(),
    );
    if result.is_err() && !parent_exited {
        clean_stage(&plan);
    }
    if result.is_err() && parent_exited {
        let restored = plan.entries.iter().all(|entry| {
            let actual = if Disk.exists(&entry.swap.target).unwrap_or(false) {
                hash_tree(&entry.swap.target).ok()
            } else {
                None
            };
            actual == entry.old
        });
        if restored && hash_file(&plan.executable).ok().as_deref() == Some(&plan.original_sha) {
            clean_stage(&plan);
            let _ = start_client(&plan, path, digest, true);
        }
    }
    result
}

pub fn helper_mode() -> Option<i32> {
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some(HELPER_FLAG) {
        return None;
    }
    Some(
        if args.len() == 5 && run_helper(Path::new(&args[2]), &args[3], &args[4]).is_ok() {
            0
        } else {
            1
        },
    )
}

pub fn ready(app: &AppHandle) -> Result<serde_json::Value, String> {
    let args: Vec<_> = std::env::args().collect();
    let Some(index) = args
        .iter()
        .position(|arg| arg == READY_FLAG || arg == ROLLBACK_FLAG)
    else {
        return Ok(serde_json::json!({ "acknowledged": false }));
    };
    if args.len() <= index + 3 {
        return Err("Incomplete portable startup acknowledgement".into());
    }
    let path = PathBuf::from(&args[index + 1]);
    // Successful cleanup removes the lock/stage; read and authenticate the plan
    // directly for a rollback launch whose data has already been restored.
    if hash_file(&path)? != args[index + 2] {
        return Err("Portable startup plan hash mismatch".into());
    }
    let plan: Plan = read_json(&path)?;
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("client-update");
    let expected_private = cache_root.join(&plan.nonce);
    reject_link(&cache_root)?;
    reject_link(&expected_private)?;
    if plan.nonce.len() != 32
        || !plan.nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
        || plan.private != expected_private
        || path != expected_private.join("plan.json")
        || plan.helper != expected_private.join("helper.exe")
    {
        return Err("Portable startup cleanup ownership mismatch".into());
    }
    if plan.nonce != args[index + 3]
        || !same_path(
            &std::env::current_exe().map_err(|error| error.to_string())?,
            &plan.executable,
        )
    {
        return Err("Portable startup identity mismatch".into());
    }
    let rollback = args[index] == ROLLBACK_FLAG;
    if !rollback {
        let expected = plan
            .entries
            .iter()
            .find(|entry| entry.swap.target == plan.executable)
            .and_then(|entry| entry.new.as_deref())
            .ok_or("Missing portable client digest")?;
        if app.package_info().version.to_string() != plan.version
            || hash_file(&plan.executable)? != expected
        {
            return Err("Portable startup version/hash mismatch".into());
        }
        let signal = Signal {
            nonce: plan.nonce.clone(),
            pid: std::process::id(),
            version: plan.version.clone(),
        };
        if !plan.private.join("ack.json").exists() {
            write_new(
                &plan.private.join("ack.json"),
                &serde_json::to_vec(&signal).map_err(|error| error.to_string())?,
            )?;
        }
    } else if hash_file(&plan.executable)? != plan.original_sha {
        return Err("Rollback client identity mismatch".into());
    }
    let error = if rollback {
        read_json::<Outcome>(&plan.private.join("result.json"))
            .ok()
            .filter(|result| result.nonce == plan.nonce)
            .and_then(|result| result.error)
    } else {
        None
    };
    thread::spawn(move || {
        if let Ok(signal) = read_json::<Signal>(&plan.private.join("ready.json")) {
            if signal.nonce != plan.nonce {
                return;
            }
            if let Ok(handle) = unsafe {
                OpenProcess(
                    PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                    false,
                    signal.pid,
                )
            } {
                let process = Process(handle);
                if process_image(&process).is_ok_and(|image| same_path(&image, &plan.helper))
                    && unsafe { WaitForSingleObject(process.0, 30_000) } != WAIT_OBJECT_0
                {
                    return;
                }
            }
        }
        if read_json::<Outcome>(&plan.private.join("result.json"))
            .is_ok_and(|result| result.nonce == plan.nonce)
        {
            let _ = fs::remove_dir_all(plan.private);
        }
    });
    Ok(serde_json::json!({ "acknowledged": !rollback, "error": error }))
}
