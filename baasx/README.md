# baasx · Automation Terminal

**English** | [简体中文](README_zh.md)

baasx is BAAS's standalone terminal workbench for managing Blue Archive Auto Script profiles, tasks, schedules, devices, and runtime logs. The CLI runs independently of the Tauri desktop app and shares its headless service client and backend protocol.

The installed command is `baasx`, and the npm package is `@kiramei/baasx`. Source code lives in `baasx/`. Repository scripts use `bun run baasx`, `baasx:build`, and related names.

## Install

Install Node.js 18 or newer when using npm, Bun, pnpm, Yarn, or cnpm. Deno can run the package directly. Choose one installed tool:

```sh
# npm
npm install -g @kiramei/baasx

# Bun
bun add -g @kiramei/baasx

# pnpm
pnpm add -g @kiramei/baasx

# Yarn 1 (Classic)
yarn global add @kiramei/baasx

# cnpm
cnpm install -g @kiramei/baasx

# Deno
deno install -g -A npm:@kiramei/baasx
```

Run `baasx --help` or `baasx --demo --lang en` after installation. Ensure the chosen package manager's global executable directory is on PATH. If pnpm reports a missing global directory, run `pnpm setup` and reopen the terminal. Yarn 1 reports its executable directory with `yarn global bin`. Bun defaults to `~/.bun/bin`, which can be changed in its configuration.

Yarn 2 and newer do not have `yarn global`. To run temporarily:

```sh
yarn dlx --package @kiramei/baasx baasx --help
```

cnpm uses an npm mirror by default. A new version may take time to appear there. If the package is unavailable, use the npm command above.

Deno's `-A` grants all permissions to the launcher. Ensure Deno and its global executable directory (by default `~/.deno/bin`) are on PATH. Deno 2.9 and newer wait 24 hours after publication by default. To install immediately, add `--min-dep-age=0` to the command on Deno 2.9 or newer.

The registry package includes native programs and installer helpers for Windows x64, Linux x64, and Apple Silicon Mac. Rust is not required.

## Getting started from source

Running from source requires Bun 1.4.4+, Rust 1.95+ with Cargo, and your platform's C/C++ build toolchain. Run these commands from the repository root:

```bash
bun install --frozen-lockfile
bun run baasx --demo
bun run baasx --help
```

Running without a command opens the terminal workbench. `--demo` uses clearly marked, in-memory data to explore tasks, profiles, configuration editing, logs, and command packs without connecting to a real device. Demo changes do not persist between processes.

`bun run baasx` incrementally builds the headless Rust installation helper from the current source. A packaged Bun installation only requires Bun; a native executable distribution requires neither Bun nor Rust. See the distribution details below.

The workbench uses a growing and shrinking star, directional text sweeps while connecting or waiting, and a two-second color breath while executing. Effects share a clock and update only their small animation components. Selected long labels and the last visible long log line scroll horizontally. Set `BAAS_REDUCED_MOTION=1` to keep status indicators static; redirected output and `TERM=dumb` also disable motion. Narrow terminals place labels and details on separate lines; short terminals use a two-line header. Opening configuration without a selected profile first opens the profile picker, then returns to configuration automatically.

The workbench has overview, tasks, scheduler, profiles, logs, configuration, and command-pack pages. Use ↑/↓ to select, Enter to open or run, and Esc to go back. Shift+Tab switches pages; Ctrl+T opens tasks, Ctrl+P opens profiles, and Ctrl+L opens logs. Type `/` to search commands and Tab to complete them. Mouse clicks work on navigation, list entries, and confirmation buttons. The wheel scrolls the current list, logs, installation steps, or long confirmation details. Labels, descriptions, and log lines scroll horizontally when they exceed the available width, with display-width handling for Chinese text, combining characters, and emoji.

The BAASX brand and connection header keep the same layout across pages and only compact for smaller terminals. The footer uses the last terminal row without reserving a blank line below it.

Use `/reload` or Ctrl+R to reload the entire terminal interface, like the desktop client’s Reload action: reset page and input state, reread settings and command packs, reconnect, and return to the overview. The local backend and its running tasks stay alive. This reloads the workbench within the current executable; the one-shot `baasx reload` command still reloads command packs.

Interactive confirmations select Yes by default. Enter confirms; `n` or the arrow keys select Cancel; Esc cancels the current action. You can also click either button. Running a task opens its live logs. At terminal widths of at least 110 columns, a log pane can appear beside the workspace. Drag its vertical divider left or right to resize the panes; each side keeps a minimum width, and terminal resizing preserves the split ratio. Narrower terminals use the logs page. Scrolling upward pauses following, and returning to the bottom resumes it.

First launch lets you choose a language and a connection mode: install a local BAAS service environment or connect to an existing service. In the workbench, `/install` and `/local` manage the local environment, while `/connect` connects to an existing service. Check the installation progress and backend status for the actual result of installation or device tasks.

Local installation reuses the desktop installation core and installs the `dev` service channel from `Kiramei/baas-dev`, which supports `main.service.py` and local pipes. The environment defaults to `<CLI config directory>/runtime` and includes a private Python runtime, the BAAS backend, OCR, and runtime dependencies. The CLI requires this service protocol and rejects the legacy `blue_archive_auto_script` GUI `stable` channel before installation. The desktop app keeps its own stable-channel default, installation directory, and settings.

Installation requires confirmation in the interface, even with `--yes`. Local prebuilt OCR currently supports Windows x64, Linux x64, and macOS ARM64.

Installation and updates use a Docker BuildKit-style step view. Each step shows its number, state, elapsed time, and an available progress bar or transfer count. Running steps expand to show recent logs; completed steps collapse and can be clicked to reopen their log tail. Use the wheel to scroll steps and PageUp/PageDown to change pages. Esc cancels an active installation or update and returns to the workbench after completion. Step results remain visible when finished. Progress and download output refresh in place within the same step list.

The interface supports Chinese, English, Japanese, Korean, German, French, and Russian. Switch with `/language` or pass `--lang en`. `BAAS_LANG` and the system locale can also supply the default language. The terminal respects `NO_COLOR` / `--no-color`, handles Chinese text in narrow layouts, and sanitizes control sequences.

## Configuration and scheduling

`/config` first shows the configuration categories used by the desktop client, then their fields. Only fields both supplied by the current backend and editable in the desktop client appear. Internal caches, asset counters, and similar JSON data are excluded from generic editing. Field and option labels reuse the desktop's seven-language resources. Display labels are separate from the underlying values sent to the backend, so changing the interface language does not change server enum values.

Editors use switches, single-choice and multiple-choice selectors, numbers, text, lists, or row tables according to the field. Numeric fields validate ranges and integer requirements. Related fields, such as café invitations, crafting stages, emulator instances, and team modes, appear according to the current configuration. Student, item, and stage options come from backend catalog data; the server type remains read-only. Push-notification credentials are hidden, and redacted placeholders cannot be saved back into the configuration.

Crafting priorities and student preferences show the actual saved order with numbered entries; higher entries have higher priority. Select with ↑/↓ and reorder with ←/→ or the Move up/Move down buttons. Use Space or the row buttons to add/remove an item, `/` to search long lists, and Ctrl+S to save. The `<` / `>` shortcuts remain available.

Lesson counts and area-level priorities appear in separate tables, covering the backend's full area catalog even when an older profile has shorter arrays. New areas default to one lesson; existing zero counts and priority order are preserved. Click `[-]` / `[+]` or press `-` / `+` to adjust counts, or Enter to edit a value. Open a priority cell to reorder its levels. Shop configuration first asks which shop to edit; configuration search still finds individual goods directly. Numeric bounds use plain text, and fields supporting all/max counts offer those modes as selectable options.

Sweep and progression plans use rows for chapters, stages, counts, and related values. Allowlists support adding and removing entries; team attributes use the desktop client's existing editable cells. In ordinary row editors, use `+` to add a row and Backspace/Delete to remove one. Single-value editors save with Enter. Cancellation, validation errors, and concurrent-edit conflicts do not submit changes; failures retain the current draft. Command-line and command-pack `config_set` actions use the same field allowlist, types, options, and conditional validation.

Open One-off tasks from `/tasks`, or use `/oneoff`, to run normal/hard progression, main/group/mini stories, and event stories, missions, and challenges. These operations use the existing single-task confirmation and are not added to the daily `/start` schedule. Direct commands such as `/run start_explore_activity_story` use the same backend task IDs.

`/scheduler` edits the current profile's actual task schedule. It also supports enabling or disabling all tasks, resetting execution times, and choosing the default state for newly added tasks: `on`, `off`, or `default`. Each task exposes these fields:

| Field                    | Meaning and input                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `enabled`                | Enable/disable switch                                                                                                  |
| `next_tick`              | Next execution time: local date and time, ISO date, Unix seconds, or `now`; `立即` also means ready to run immediately |
| `priority`               | Integer; lower values have higher priority                                                                             |
| `interval`               | Nonnegative integer seconds; `0` uses daily reset times                                                                |
| `daily_reset`            | Daily reset rows with hours, minutes, and seconds                                                                      |
| `disabled_time_range`    | Start and end of disabled periods; periods crossing midnight are split into two                                        |
| `pre_task` / `post_task` | Ordered prerequisite/follow-up tasks, selected from other existing tasks without duplicates                            |

Saving a schedule checks the field values read earlier and rejects overwriting concurrent changes. The task list and overview show the current task, waiting queue, enabled-task count, and next scheduled execution. Schedule data refreshes when a run ends.

## Updating the local environment

Use `/update` in the workbench to check and update the environment. For scripts, `check-update` reads local backend and OCR repository versions, and `update` applies available updates:

```bash
bun run baasx --json check-update
bun run baasx --yes update
bun run baasx --dry-run update
```

Updates target a fully installed local `dev` environment managed by the CLI. Before updating, baasx checks every profile in the backend owned by this CLI instance. Any active task, scheduler, or waiting queue prevents the update. Once idle, the private backend stops, dependencies update, and the installation is checked again. If the workbench was connected to the local backend, it restarts and reconnects afterward. The installation lock also prevents replacement while another CLI instance holds a runtime lease.

External services selected by `--server` / `--pipe` are outside the local update target and are neither stopped nor modified. `check-update` only checks, `--dry-run update` only previews, and `--read-only` rejects applying updates.

## Connecting to an existing service

```bash
# Start a service from a baas-dev checkout that supports Service mode.
python main.service.py --host 127.0.0.1 --port 8190

# Use /connect in the workbench to enter the service login key in a hidden prompt.
bun run baasx --server ws://127.0.0.1:8190
```

Scripts provide the service key through `BAAS_KEY`:

```bash
export BAAS_KEY='your-service-login-key'
bun run baasx --server ws://127.0.0.1:8190 profiles
bun run baasx --profile default_config tasks
bun run baasx --profile default_config --json status
```

The CLI shares the desktop app's pinned signing public key, authentication, and encrypted application channel. When connecting to an uninitialized service, the first key entered initializes that service. For a self-hosted service with a different signing public key, pass `--server-key <public-key>` or set `BAAS_SERVER_SIGN_PUBLIC_KEY` explicitly.

Local pipes to an existing backend are also supported. On Unix, use a socket accessible to the current user; on Windows, use a named-pipe path:

```bash
python main.service.py --host 127.0.0.1 --pipe-name /tmp/baasx.sock
bun run baasx --pipe /tmp/baasx.sock profiles
bun run baasx --pipe /tmp/baasx.sock --profile default_config status
```

## Script commands

| Command                                             | Purpose                                                  |
| --------------------------------------------------- | -------------------------------------------------------- |
| `profiles` / `use <ID-or-unique-name>`              | List and select profiles                                 |
| `status` / `tasks`                                  | Inspect runtime status, actual task names, and schedules |
| `run <task>`                                        | Submit a single task for the selected profile            |
| `start` / `stop`                                    | Start the scheduler / stop the current run               |
| `wait [run_id]`                                     | Wait for the current or specified run                    |
| `logs [count]` / `watch`                            | Read logs / continuously monitor status                  |
| `config get [/path]`                                | Read configuration using a JSON Pointer                  |
| `config set /path '<JSON>'`                         | Change an existing field in the editable allowlist       |
| `devices` / `doctor`                                | Detect ADB devices / check the service                   |
| `packs` / `pack <name>`                             | List and execute independent command packs               |
| `settings show` / `settings set` / `settings unset` | Manage nonsensitive preferences                          |
| `init` / `connect [URL]`                            | Save connection preferences / connect to a service       |
| `check-update` / `update`                           | Check / update the CLI-managed local environment         |

Piped or redirected input requires an explicit command. With no command, the CLI reports an error instead of interpreting the input text.

When connected to an external service, `start` / `run` normally only acknowledge that the backend accepted the request, returning `completed: false` and an available `run_id`. `--wait` waits for that same run to reach a terminal state; `--follow` displays its logs and waits for it to finish:

```bash
bun run baasx --profile default_config --yes --wait --follow run explore_normal_task
bun run baasx --profile default_config --wait-timeout 120 wait <run_id>
bun run baasx --profile default_config --follow logs 50
```

In local-installation mode, one-shot scripts automatically wait for runs initiated by `run`, `start`, or a command pack before stopping their private backend. The default wait is up to 24 hours and can be overridden with `--wait-timeout`. The default wait limit for an external service is 300 seconds. The interactive workbench keeps its backend running until you exit.

When a run ends, the result has `completed: true`, and `succeeded` is determined by `exit_code`. Unverifiable outcomes are never reported as successful. `--wait-timeout` accepts 1–86400 seconds; a timeout exits with code `124`. Reconnection restores the connection and reads status or logs without replaying mutations. A task that is already running is not submitted again.

Ctrl+C cancels the current wait, request, or monitor; an idle workbench exits. Closing the CLI, canceling a local wait, or timing out a local wait stops the backend and child processes launched by that CLI instance. External services connected through `--server` / `--pipe` and their submitted tasks keep running. To keep a service running independently, start it yourself and connect the CLI to it. A successful health check does not establish successful authentication or device-task execution.

Direct `/start` (CLI `start`) starts the scheduler immediately without confirmation or `--yes`. Other mutations and command packs ask for confirmation, with Yes selected by default in the workbench. `--yes` skips ordinary action confirmations and is required for other noninteractive mutation scripts. First installation still requires confirmation in the interface. `--read-only` applies to both direct commands and command packs. Configuration changes read a snapshot and check for conflicts instead of overwriting concurrent edits automatically.

`--dry-run` previews mutations and the complete command-pack plan without executing pack steps. Preflight checks may read actual profiles, tasks, and configuration fields:

```bash
bun run baasx --profile default_config --dry-run start
bun run baasx --profile default_config --dry-run pack daily-wait
```

`--json` emits machine-readable results; continuous monitoring emits individual JSON events. Ordinary commands emit one JSON document, with progress messages on stderr.

## Independent command packs

Command packs are separate from desktop plugin packages. The built-in `briefing` reads status and tasks, `connection-check` checks the service and devices, `daily` starts the existing schedule, and `daily-wait` starts it and waits up to 120 seconds for that run.

Save custom packs to `<CLI config directory>/commands/*.json`, then run them from the command-pack page or with `pack my-check`:

```json
{
  "id": "my-sensei",
  "name": "My Schale commands",
  "description": "Check the current profile",
  "version": 1,
  "commands": [
    {
      "name": "my-check",
      "description": "Read status and recent logs",
      "steps": [
        { "action": "status", "args": {} },
        { "action": "logs", "args": { "limit": 20 } }
      ]
    }
  ]
}
```

Allowed actions are `status`, `profiles`, `tasks`, `config_get`, `config_set`, `scheduler_start`, `scheduler_stop`, `task_run`, `devices`, `logs`, and `wait_run`. Profile-scoped steps accept `args.profile`. `wait_run` accepts `run_id` and `timeout_seconds`, an integer from 1 to 120.

The complete plan is checked before execution. An already active run, a rejected step, or a failed step stops subsequent execution. `--read-only` rejects a pack containing mutations before any of its steps run. Packs declare BAAS actions and do not execute JS, Python, or shell code. Duplicate commands, unknown arguments, and conflicts with built-in commands are errors. Use `packs/baas-core.json` as a reference, with distinct IDs and command names for your extensions.

## Configuration and packaging

baasx keeps the existing CLI configuration directory and `BAAS_*` environment variables, so existing settings and local environments do not need migration. Preferences are separate from the desktop app and default to `$XDG_CONFIG_HOME/baas/settings.json` or `~/.config/baas/settings.json`. Override the directory with `BAAS_CLI_HOME` / `--config-home`. Preferences support the server address, pipe, profile, language, connection mode, and command-pack directory; they do not store the key.

Environment variables are `BAAS_SERVER`, `BAAS_PIPE`, `BAAS_PROFILE`, `BAAS_KEY`, `BAAS_SERVER_SIGN_PUBLIC_KEY`, `BAAS_LANG`, and `BAAS_CLI_HOME`. Connection precedence is command-line arguments, environment variables, then preferences. `use` saves the current profile; `--profile` affects only the current invocation. `BAAS_RUNTIME_HELPER` explicitly selects a built installation-helper path. Distributed packages do not invoke Cargo automatically.

```bash
npm exec --yes --package=bun@1.4.4-canary.20261105.1 -- bun run baasx:build
bun baasx/bin/baasx.mjs --demo

# Pinned slim compiler; no system Bun replacement. Targets need neither Bun nor Rust.
npm exec --yes --package=bun@1.4.4-canary.20261105.1 -- bun run baasx:binary
./baasx/dist/baasx --demo

npm exec --yes --package=bun@1.4.4-canary.20261105.1 -- bun run baasx:pack
bun add -g ./baasx/dist/baas-baasx-0.1.1.tgz
baasx --help
```

`baasx:build` builds the native Rust helper and `baasx/dist/baasx.js`. `baasx:binary` also generates `baasx/dist/baasx` (`baasx.exe` on Windows). Builds target the current operating system and architecture; build separately for each platform so that packages contain the correct helper.

The JS bundle is minified, and executables use ESM with a shallow bytecode cache to reduce startup parsing. The slim compiler is pinned in `baasx/package.json` to `bun@1.4.4-canary.20261105.1` (revision `b1007f117`); CI installs it in a temporary directory, and the build checks the full revision to reject other versions and floating canaries. Its [runtime trimming](https://bun.com/docs/compiler/size) is experimental: only unused build/test tools, image, database and related APIs are removed. JIT, WASM, Intl, networking, cryptography and process support remain; AOT is disabled. Tests exercise configuration and command packs in the compiled artifact. Stable Bun 1.4.4 does not support trimming, and upgrading alone does not guarantee a smaller executable. Use `bun run baasx:binary --no-trim` to fall back to the full runtime. A compiler without trimming support fails explicitly rather than silently producing a larger release.

Both distribution formats must include the installation helper:

- The Bun package contains `bin/baasx.mjs`, `dist/baasx.js`, `runtime/baas-cli-runtime` (with `.exe` on Windows), command packs, and license files. `bun run baasx:pack` first runs the `prepack` build, then invokes `bun pm pack --ignore-scripts` to generate the `.tgz`.
- Native executable distributions keep `baasx` / `baasx.exe` beside `runtime/baas-cli-runtime` / `runtime/baas-cli-runtime.exe`. Keep the `runtime` directory when copying the executable. The build script copies the helper into both `baasx/runtime` and `baasx/dist/runtime` for the two distribution formats.

CI checks and builds on Windows, Linux, and macOS. Uploaded build artifacts contain the Bun `.tgz` package and native `.tar.gz` distribution, each with its platform's installation helper, both README languages, and the license. Extract the appropriate archive and preserve its directory structure and executable permissions. Users of these packages do not need a Rust toolchain to install the BAAS environment on first launch.


## Development and verification

```bash
bun run baasx:check
bun run baasx:test
bunx eslint baasx/src baasx/tests baasx/packages/baas-client/src baasx/packages/baas-client/tests
```

`workspace-view.tsx` implements the terminal interface, `terminal.ts` handles terminal and mouse protocols, and `field-editor.tsx` supplies typed editors. `configuration.ts` and `scheduler.ts` define editable fields, validation, and serialization. `workspace.ts` controls the workbench, `index.ts` implements script commands, `actions.ts` defines the shared action boundary, and `monitor.ts` correlates runs and follows logs. `runtime.ts` wraps the local installation helper, `installation.ts` retains bounded step progress and logs, and `installation-view.tsx` presents per-step progress and log tails. `baasx/packages/baas-client` is the shared headless client.

Tests cover socket framing, signed and encrypted connections, confirmation and read-only behavior, command-pack preflight checks, run correlation, log recovery, configuration allowlists and types, schedule conflicts, seven-language text, mouse protocols, terminal sanitization, structured installation progress, and CLI subprocesses. Simulated checks do not replace acceptance testing of actual game tasks; connect a device and verify them with your intended configuration.
