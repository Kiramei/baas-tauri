use crate::{
    common::{session_is_current, wait_for_completions},
    processor::{ScriptCommand, create_process_task, run_process_and_wait, spawn_process_task},
    threader::{ThreadLogStyle, ThreadOutput, create_thread_task, spawn_thread_task},
    types::{RendererEvent, TaskCompletion, TermState},
};

use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
        mpsc::Sender,
    },
    thread,
    time::Duration,
};

pub fn run_demo_flow(
    inner: Arc<Mutex<TermState>>,
    session_id: String,
    renderer_tx: Sender<RendererEvent>,
) {
    let (completion_tx, completion_rx) = mpsc::channel::<TaskCompletion>();

    let uv = create_process_task("uv-sync", "uv-sync", 1, "uv sync", uv_sync_script());
    let success = run_process_and_wait(
        &inner,
        &session_id,
        uv,
        &renderer_tx,
        &completion_tx,
        &completion_rx,
    );

    if success && session_is_current(&inner, &session_id) {
        let git = create_process_task(
            "git-sync",
            "git-sync",
            2,
            "Sub 1: Git Sync",
            git_sync_script(),
        );
        let wheels = create_process_task(
            "build-wheels",
            "build-wheels",
            2,
            "Sub 2: Build Wheels",
            build_wheels_script(),
        );

        let git_id = git.task_id.clone();
        let wheels_id = wheels.task_id.clone();
        let _ = renderer_tx.send(RendererEvent::BufferRegions {
            region_ids: vec![git.region_id.clone(), wheels.region_id.clone()],
        });
        let _ = spawn_process_task(&inner, &session_id, git, &renderer_tx, &completion_tx);
        let _ = spawn_process_task(&inner, &session_id, wheels, &renderer_tx, &completion_tx);

        let parallel_success =
            wait_for_completions(&completion_rx, vec![git_id, wheels_id]).unwrap_or(false);
        let _ = renderer_tx.send(RendererEvent::FlushRegions {
            region_ids: vec!["git-sync".to_string(), "build-wheels".to_string()],
        });

        if parallel_success && session_is_current(&inner, &session_id) {
            let asset_scan = create_thread_task(
                "asset-scan-thread",
                "asset-scan-thread",
                3,
                "Sub 1: Asset Scan Thread",
                "rust thread asset scan demo",
            );
            let symbol_cache = create_thread_task(
                "symbol-cache-thread",
                "symbol-cache-thread",
                3,
                "Sub 2: Symbol Cache Thread",
                "rust thread symbol cache demo",
            );

            let asset_scan_id = asset_scan.task_id.clone();
            let symbol_cache_id = symbol_cache.task_id.clone();
            let _ = renderer_tx.send(RendererEvent::BufferRegions {
                region_ids: vec![asset_scan.region_id.clone(), symbol_cache.region_id.clone()],
            });
            let _ = spawn_thread_task(
                &inner,
                &session_id,
                asset_scan,
                &renderer_tx,
                &completion_tx,
                asset_scan_args(),
                asset_scan_thread,
            );
            let _ = spawn_thread_task(
                &inner,
                &session_id,
                symbol_cache,
                &renderer_tx,
                &completion_tx,
                symbol_cache_args(),
                symbol_cache_thread,
            );

            let thread_success =
                wait_for_completions(&completion_rx, vec![asset_scan_id, symbol_cache_id])
                    .unwrap_or(false);
            let _ = renderer_tx.send(RendererEvent::FlushRegions {
                region_ids: vec![
                    "asset-scan-thread".to_string(),
                    "symbol-cache-thread".to_string(),
                ],
            });

            if !thread_success || !session_is_current(&inner, &session_id) {
                let _ = renderer_tx.send(RendererEvent::SessionFinished { success: false });
                return;
            }

            let docker = create_process_task(
                "docker-build",
                "docker-build",
                4,
                "Docker Build",
                docker_build_script(),
            );
            let docker_success = run_process_and_wait(
                &inner,
                &session_id,
                docker,
                &renderer_tx,
                &completion_tx,
                &completion_rx,
            );
            let _ = renderer_tx.send(RendererEvent::SessionFinished {
                success: docker_success,
            });
            return;
        }
    }

    if session_is_current(&inner, &session_id) {
        let _ = renderer_tx.send(RendererEvent::SessionFinished { success: false });
    }
}

struct ModuleGraphFrame {
    module_count: u16,
    edge_count: u16,
    cache_count: u16,
}

struct AssetScanArgs {
    heading: &'static str,
    paths: Vec<&'static str>,
    module_frames: Vec<ModuleGraphFrame>,
}

fn asset_scan_args() -> AssetScanArgs {
    AssetScanArgs {
        heading: "Starting in-process asset scan worker...",
        paths: vec!["src", "src/components", "src/types", "src-tauri/src"],
        module_frames: vec![
            ModuleGraphFrame {
                module_count: 4,
                edge_count: 18,
                cache_count: 32,
            },
            ModuleGraphFrame {
                module_count: 7,
                edge_count: 41,
                cache_count: 86,
            },
            ModuleGraphFrame {
                module_count: 9,
                edge_count: 64,
                cache_count: 128,
            },
        ],
    }
}

fn symbol_cache_args() -> SymbolCacheArgs {
    SymbolCacheArgs {
        spinner_label: "warming symbol cache",
        spinner_success: "symbol cache warm",
        spinner_details: vec![
            "reading manifests",
            "deduplicating paths",
            "allocating shards",
        ],
        progress_label: "indexing symbols",
        progress_success: "asset index complete: 128 symbols cached",
        progress_total: 100,
        progress_width: 30,
        progress_steps: vec![
            ProgressStep {
                value: 10,
                detail: "bootstrapping",
                delay: Duration::from_millis(100),
            },
            ProgressStep {
                value: 20,
                detail: "building lookup table",
                delay: Duration::from_millis(120),
            },
            ProgressStep {
                value: 45,
                detail: "building lookup table",
                delay: Duration::from_millis(120),
            },
            ProgressStep {
                value: 70,
                detail: "building lookup table",
                delay: Duration::from_millis(120),
            },
            ProgressStep {
                value: 90,
                detail: "building lookup table",
                delay: Duration::from_millis(120),
            },
            ProgressStep {
                value: 100,
                detail: "building lookup table",
                delay: Duration::from_millis(120),
            },
        ],
    }
}

fn asset_scan_thread(
    output: ThreadOutput,
    cancelled: Arc<AtomicBool>,
    args: AssetScanArgs,
) -> Result<(), String> {
    let log = output.log();
    log.line(ThreadLogStyle::Info, args.heading);
    log.line(ThreadLogStyle::Plain, "Plain log output is available.");
    log.line(
        ThreadLogStyle::Error,
        "Error style sample: no errors detected.",
    );
    log.lines(
        ThreadLogStyle::Muted,
        [
            "Log wrapper demo: styled single-line output.",
            "Log wrapper demo: each helper owns terminal control details.",
        ],
    );

    let mut source_scan = log.line_repaint();
    for path in args.paths {
        if cancelled.load(Ordering::Relaxed) {
            source_scan.finish(ThreadLogStyle::Warning, "thread worker cancelled");
            return Ok(());
        }

        source_scan.render(ThreadLogStyle::Muted, format!("scanning {path}"));
        thread::sleep(Duration::from_millis(140));
    }
    source_scan.finish(ThreadLogStyle::Success, "source scan complete");

    let mut module_graph = log.block_repaint();
    for frame in args.module_frames {
        if cancelled.load(Ordering::Relaxed) {
            module_graph.render(ThreadLogStyle::Warning, ["thread worker cancelled"]);
            module_graph.finish();
            return Ok(());
        }

        let modules = format!("modules discovered: {}", frame.module_count);
        let edges = format!("dependency edges: {}", frame.edge_count);
        let cache = format!("cache candidates: {}", frame.cache_count);
        module_graph.render(
            ThreadLogStyle::Accent,
            [modules.as_str(), edges.as_str(), cache.as_str()],
        );
        thread::sleep(Duration::from_millis(180));
    }
    module_graph.finish();

    Ok(())
}

fn symbol_cache_thread(
    output: ThreadOutput,
    cancelled: Arc<AtomicBool>,
    args: SymbolCacheArgs,
) -> Result<(), String> {
    output.with_spinner(args.spinner_label, args.spinner_success, |spinner| {
        for detail in args.spinner_details {
            if cancelled.load(Ordering::Relaxed) {
                spinner.set_detail("cancelled");
                return Err("thread worker cancelled".to_string());
            }

            spinner.set_detail(detail);
            thread::sleep(Duration::from_millis(560));
        }

        Ok(())
    })?;

    output.with_progress_bar(
        args.progress_label,
        args.progress_total,
        args.progress_width,
        args.progress_success,
        |progress_bar| {
            let mut previous = 0;
            for step in args.progress_steps {
                if cancelled.load(Ordering::Relaxed) {
                    return Err("thread worker cancelled".to_string());
                }

                progress_bar.inc(step.value.saturating_sub(previous), step.detail);
                previous = step.value;
                thread::sleep(step.delay);
            }

            Ok(())
        },
    )?;

    Ok(())
}

struct SymbolCacheArgs {
    spinner_label: &'static str,
    spinner_success: &'static str,
    spinner_details: Vec<&'static str>,
    progress_label: &'static str,
    progress_success: &'static str,
    progress_total: u64,
    progress_width: usize,
    progress_steps: Vec<ProgressStep>,
}

struct ProgressStep {
    value: u64,
    detail: &'static str,
    delay: Duration,
}

#[cfg(not(windows))]
fn shell_script(script: &str, display: &str) -> ScriptCommand {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    ScriptCommand {
        program: shell,
        args: vec!["-lc".to_string(), script.to_string()],
        display: display.to_string(),
        cwd: ".".to_string(),
        env: vec![],
        detached: false,
        detached_pid_file: None,
    }
}

#[cfg(windows)]
fn shell_script(script: &str, display: &str) -> ScriptCommand {
    let program = if std::process::Command::new("pwsh")
        .arg("-NoLogo")
        .arg("-NoProfile")
        .arg("-Command")
        .arg("$PSVersionTable.PSVersion")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
    {
        "pwsh"
    } else {
        "powershell.exe"
    };

    ScriptCommand {
        program: program.to_string(),
        args: vec![
            "-NoLogo".to_string(),
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-Command".to_string(),
            script.to_string(),
        ],
        display: display.to_string(),
        cwd: ".".to_string(),
        env: vec![],
        detached: false,
        detached_pid_file: None,
    }
}

#[cfg(not(windows))]
fn uv_sync_script() -> ScriptCommand {
    shell_script(
        r#"
printf '\033[36mResolving dependencies with uv...\033[0m\n'
for p in 10 25 45 70 90 100; do
  printf '\r\033[2Kdownloading package metadata %3s%% |' "$p"
  blocks=$((p / 5))
  i=0
  while [ "$i" -lt "$blocks" ]; do printf '#'; i=$((i + 1)); done
  while [ "$i" -lt 20 ]; do printf '-'; i=$((i + 1)); done
  printf '|'
  sleep 0.12
done
printf '\nPreparing wheels\n'
for p in 30 60 100; do printf '\r\033[2Kinstalling dependencies %s%%' "$p"; sleep 0.16; done
printf '\n\033[32muv sync complete: 42 packages installed\033[0m\n'
"#,
        "shell -lc uv sync demo",
    )
}

#[cfg(windows)]
fn uv_sync_script() -> ScriptCommand {
    shell_script(
        r##"
Write-Host "`e[36mResolving dependencies with uv...`e[0m"
foreach ($p in 10,25,45,70,90,100) {
  Write-Host -NoNewline "`r`e[2Kdownloading package metadata $p% |"
  $blocks = [Math]::Floor($p / 5)
  Write-Host -NoNewline ("#" * $blocks)
  Write-Host -NoNewline ("-" * (20 - $blocks))
  Write-Host -NoNewline "|"
  Start-Sleep -Milliseconds 120
}
Write-Host ""
Write-Host "Preparing wheels"
foreach ($p in 30,60,100) { Write-Host -NoNewline "`r`e[2Kinstalling dependencies $p%"; Start-Sleep -Milliseconds 160 }
Write-Host ""
Write-Host "`e[32muv sync complete: 42 packages installed`e[0m"
"##,
        "powershell uv sync demo",
    )
}

#[cfg(not(windows))]
fn git_sync_script() -> ScriptCommand {
    shell_script(
        r#"
printf 'Fetching origin/main\n'
for n in 1200 4200 7600 11000 12581; do
  printf '\r\033[2KReceiving objects: %s/12581 (%s%%)' "$n" $((n * 100 / 12581))
  sleep 0.15
done
printf '\n'
for n in 1200 3400 6400 8312; do
  printf '\r\033[2KResolving deltas: %s%% (%s/8312)' $((n * 100 / 8312)) "$n"
  sleep 0.14
done
printf ', done.\n\033[32mGit sync complete\033[0m\n'
"#,
        "shell -lc git sync demo",
    )
}

#[cfg(windows)]
fn git_sync_script() -> ScriptCommand {
    shell_script(
        r##"
Write-Host "Fetching origin/main"
foreach ($n in 1200,4200,7600,11000,12581) {
  $pct = [Math]::Floor($n * 100 / 12581)
  Write-Host -NoNewline "`r`e[2KReceiving objects: $n/12581 ($pct%)"
  Start-Sleep -Milliseconds 150
}
Write-Host ""
foreach ($n in 1200,3400,6400,8312) {
  $pct = [Math]::Floor($n * 100 / 8312)
  Write-Host -NoNewline "`r`e[2KResolving deltas: $pct% ($n/8312)"
  Start-Sleep -Milliseconds 140
}
Write-Host ", done."
Write-Host "`e[32mGit sync complete`e[0m"
"##,
        "powershell git sync demo",
    )
}

#[cfg(not(windows))]
fn build_wheels_script() -> ScriptCommand {
    shell_script(
        r#"
printf '\033[35mBuilding wheels for local packages\033[0m\n'
sleep 0.1
printf '  \033[34mCompiling\033[0m core v0.1.0\n'
sleep 0.18
printf '  \033[34mCompiling\033[0m api v0.1.0\n'
sleep 0.18
printf '  \033[34mCompiling\033[0m worker v0.1.0\n'
sleep 0.18
printf '  \033[34mCompiling\033[0m frontend v0.1.0\n'
sleep 0.18
printf '\033[33mwarning:\033[0m build cache reused for native-extension\n'
sleep 0.14
printf '\033[32mSuccessfully built 4 wheels\033[0m\n'
"#,
        "shell -lc build wheels demo",
    )
}

#[cfg(windows)]
fn build_wheels_script() -> ScriptCommand {
    shell_script(
        r##"
Write-Host "`e[35mBuilding wheels for local packages`e[0m"
Start-Sleep -Milliseconds 100
Write-Host "  `e[34mCompiling`e[0m core v0.1.0"
Start-Sleep -Milliseconds 180
Write-Host "  `e[34mCompiling`e[0m api v0.1.0"
Start-Sleep -Milliseconds 180
Write-Host "  `e[34mCompiling`e[0m worker v0.1.0"
Start-Sleep -Milliseconds 180
Write-Host "  `e[34mCompiling`e[0m frontend v0.1.0"
Start-Sleep -Milliseconds 180
Write-Host "`e[33mwarning:`e[0m build cache reused for native-extension"
Start-Sleep -Milliseconds 140
Write-Host "`e[32mSuccessfully built 4 wheels`e[0m"
"##,
        "powershell build wheels demo",
    )
}

#[cfg(not(windows))]
fn docker_build_script() -> ScriptCommand {
    shell_script(
        r#"
printf '\033[36m#0 building with default docker driver\033[0m\n'
sleep 0.12
printf '[1/6] FROM docker.io/library/rust:1-bookworm\n'
sleep 0.12
printf '\r\033[2K => 100%% FROM docker.io/library/rust:1-bookworm\n'
sleep 0.12
printf '[2/6] COPY Cargo.toml Cargo.lock ./\n'
sleep 0.12
printf '\r\033[2K => 100%% COPY Cargo.toml Cargo.lock ./\n'
sleep 0.12
printf '[3/6] RUN cargo fetch\n'
for p in 25 50 75 100; do printf '\r\033[2K => %s%% RUN cargo fetch' "$p"; sleep 0.1; done
printf '\n[4/6] COPY src ./src\n'
sleep 0.12
printf ' => 100%% COPY src ./src\n'
sleep 0.12
printf '[5/6] RUN cargo build --release\n'
for p in 20 40 70 100; do printf '\r\033[2K => %s%% RUN cargo build --release' "$p"; sleep 0.12; done
printf '\n[6/6] exporting image layers\n'
for p in 25 50 100; do printf '\r\033[2K => %s%% exporting image layers' "$p"; sleep 0.12; done
printf '\n\033[32mDocker build complete in 3.4s\033[0m\n'
"#,
        "shell -lc docker build demo",
    )
}

#[cfg(windows)]
fn docker_build_script() -> ScriptCommand {
    shell_script(
        r##"
Write-Host "`e[36m#0 building with default docker driver`e[0m"
Start-Sleep -Milliseconds 120
Write-Host "[1/6] FROM docker.io/library/rust:1-bookworm"
Start-Sleep -Milliseconds 120
Write-Host "`r`e[2K => 100% FROM docker.io/library/rust:1-bookworm"
Start-Sleep -Milliseconds 120
Write-Host "[2/6] COPY Cargo.toml Cargo.lock ./"
Start-Sleep -Milliseconds 120
Write-Host "`r`e[2K => 100% COPY Cargo.toml Cargo.lock ./"
Start-Sleep -Milliseconds 120
Write-Host "[3/6] RUN cargo fetch"
foreach ($p in 25,50,75,100) { Write-Host -NoNewline "`r`e[2K => $p% RUN cargo fetch"; Start-Sleep -Milliseconds 100 }
Write-Host ""
Write-Host "[4/6] COPY src ./src"
Start-Sleep -Milliseconds 120
Write-Host " => 100% COPY src ./src"
Start-Sleep -Milliseconds 120
Write-Host "[5/6] RUN cargo build --release"
foreach ($p in 20,40,70,100) { Write-Host -NoNewline "`r`e[2K => $p% RUN cargo build --release"; Start-Sleep -Milliseconds 120 }
Write-Host ""
Write-Host "[6/6] exporting image layers"
foreach ($p in 25,50,100) { Write-Host -NoNewline "`r`e[2K => $p% exporting image layers"; Start-Sleep -Milliseconds 120 }
Write-Host ""
Write-Host "`e[32mDocker build complete in 3.4s`e[0m"
"##,
        "powershell docker build demo",
    )
}
