# BAAS CLI · 自动化终端

BAAS 的独立终端工作台，直接管理 Blue Archive Auto Script 的配置档、任务、调度、设备和运行日志。CLI 与 Tauri 桌面端独立运行，共享无界面服务客户端和后端协议。

## 开始使用

从源码运行需要 Bun 1.3+、Rust 1.95+（含 Cargo）和本机 C/C++ 编译工具链。在仓库根目录执行：

```bash
bun install --frozen-lockfile
bun run cli --demo
bun run cli --help
```

无参数进入终端工作台。`--demo` 使用明确标记的内存数据，可体验任务、配置档、配置修改、日志与指令包，不连接真实设备。演示数据不跨进程保留。

`bun run cli` 会增量构建与当前源码匹配的无界面 Rust 安装组件。已打包的 Bun 包只需 Bun；本机可执行发行包无需 Bun 或 Rust，见下方分发说明。

工作台包含总览、任务、配置档、日志、配置和指令包页面。用 ↑/↓ 选择、Enter 打开或运行、Esc 返回；Shift+Tab 切换页面，Ctrl+T 打开任务、Ctrl+P 打开配置档、Ctrl+L 打开日志。输入 `/` 搜索命令，Tab 补全。配置页面支持浏览、搜索、修改已有字段，状态修改会先显示确认。

首次进入可选择语言和运行方式：安装本地 BAAS 服务版环境，或连接已有服务。工作台中的 `/install`、`/local` 管理本地环境；`/connect` 连接已有服务。实际安装和设备任务需按界面进度及后端状态确认。

本地安装复用桌面端的安装核心，自动安装支持 `main.service.py` 和本地管道的 `Kiramei/baas-dev` 服务版（`dev` 通道）。环境默认位于 `<CLI配置目录>/runtime`，包含私有 Python、BAAS 后端、OCR 和运行依赖。CLI 不使用缺少该服务协议的旧 `blue_archive_auto_script` GUI 稳定版；其安装器会提前拒绝 `stable` 通道。桌面端自身的 stable 默认、安装目录和设置不变。

安装仍需界面确认，`--yes` 不跳过首次安装确认。目前本地 OCR 预构建支持 Windows x64、Linux x64、macOS ARM64。

支持中文、英语、日语、韩语、德语、法语和俄语。使用 `/language` 切换，或传入 `--lang zh`；环境变量 `BAAS_LANG` 和系统 locale 也可提供默认语言。终端尊重 `NO_COLOR` / `--no-color`，支持窄屏中文宽度与控制序列净化。

## 连接已有服务

```bash
# 在支持 Service 模式的 baas-dev 目录启动服务
python main.service.py --host 127.0.0.1 --port 8190

# 工作台中输入 /connect，隐藏输入服务登录 Key
bun run cli --server ws://127.0.0.1:8190
```

脚本通过 `BAAS_KEY` 提供服务 Key：

```bash
export BAAS_KEY='你的服务登录Key'
bun run cli --server ws://127.0.0.1:8190 profiles
bun run cli --profile default_config tasks
bun run cli --profile default_config --json status
```

CLI 复用桌面端的签名公钥固定、认证与加密业务通道。连接尚未初始化的服务时，首次输入的 Key 会初始化服务。自部署使用不同签名公钥时，明确传入 `--server-key <公钥>` 或 `BAAS_SERVER_SIGN_PUBLIC_KEY`。

也支持已有后端的本地管道。Unix 使用本用户可访问的 socket，Windows 使用命名管道路径：

```bash
python main.service.py --host 127.0.0.1 --pipe-name /tmp/baas-cli.sock
bun run cli --pipe /tmp/baas-cli.sock profiles
bun run cli --pipe /tmp/baas-cli.sock --profile default_config status
```

## 脚本命令

| 命令                                                | 用途                           |
| --------------------------------------------------- | ------------------------------ |
| `profiles` / `use <ID或唯一名称>`                   | 查看和选择配置档               |
| `status` / `tasks`                                  | 查看运行状态、真实任务名与调度 |
| `run <task>`                                        | 提交选中配置档的单任务         |
| `start` / `stop`                                    | 启动调度 / 停止当前运行        |
| `wait [run_id]`                                     | 等待当前或指定运行编号         |
| `logs [数量]` / `watch`                             | 查看日志 / 持续观察状态        |
| `config get [/path]`                                | 按 JSON Pointer 读取配置       |
| `config set /path '<JSON>'`                         | 修改已有配置字段               |
| `devices` / `doctor`                                | 检测 ADB 设备 / 检查服务       |
| `packs` / `pack <名称>`                             | 查看和执行独立指令包           |
| `settings show` / `settings set` / `settings unset` | 管理非敏感偏好                 |
| `init` / `connect [URL]`                            | 保存连接偏好 / 连接服务        |

管道或重定向输入必须明确指定命令；没有命令时直接报错，不解释输入文本。

连接外部服务时，`start` / `run` 默认只表示后端接受启动，返回 `completed: false` 和可用的 `run_id`。`--wait` 等待相同运行编号的终态，`--follow` 显示相关日志并等待任务结束：

```bash
bun run cli --profile default_config --yes --wait --follow run explore_normal_task
bun run cli --profile default_config --wait-timeout 120 wait <run_id>
bun run cli --profile default_config --follow logs 50
```

本地安装模式的一次性脚本会自动等待 `run`、`start` 或指令包发起的运行结束，再关闭本次私有后端；默认最多等待 24 小时，显式 `--wait-timeout` 可覆盖。连接外部服务时默认等待上限为 300 秒。交互工作台保持后端运行至退出终端。

运行结束时返回 `completed: true`，`succeeded` 根据 `exit_code` 判断；无法证明结果时不会报告成功。`--wait-timeout` 单位为秒，范围 1–86400；超时退出码为 `124`。断线恢复只重建连接并读取状态或日志，不重放修改。任务已在运行时不会重复提交。

Ctrl+C 取消当前等待、请求或监控；工作台空闲时退出。关闭 CLI、取消本地等待或本地等待超时会停止本次 CLI 自己启动的后端及其子进程；通过 `--server` / `--pipe` 连接的外部服务及已提交任务继续运行。需要服务常驻时，先自行启动服务再由 CLI 连接。健康检查成功不代表认证或设备任务执行成功。

所有状态修改需要确认，非交互脚本须明确使用 `--yes`。`--read-only` 约束直接命令和指令包。配置修改读取快照并检查冲突，不自动覆盖并发修改。

`--dry-run` 预览修改动作和指令包完整计划，不执行包内步骤。预检可读取真实配置档、任务和字段：

```bash
bun run cli --profile default_config --dry-run start
bun run cli --profile default_config --dry-run pack daily-wait
```

`--json` 输出机器可读结果；持续监控输出逐条 JSON 事件。普通命令输出一个 JSON 文档，过程信息进入 stderr。

## 独立指令包

指令包独立于桌面插件包。内置 `briefing` 查看状态与任务，`connection-check` 检查服务和设备，`daily` 启动已有调度，`daily-wait` 启动后等待本次运行最多 120 秒。

将自定义包保存至 `<CLI配置目录>/commands/*.json`，通过工作台指令包页面或 `pack my-check` 执行：

```json
{
  "id": "my-sensei",
  "name": "我的夏莱指令",
  "description": "检查当前配置档",
  "version": 1,
  "commands": [
    {
      "name": "my-check",
      "description": "查看状态和最近日志",
      "steps": [
        { "action": "status", "args": {} },
        { "action": "logs", "args": { "limit": 20 } }
      ]
    }
  ]
}
```

允许动作：`status`、`profiles`、`tasks`、`config_get`、`config_set`、`scheduler_start`、`scheduler_stop`、`task_run`、`devices`、`logs`、`wait_run`。配置档步骤可传 `args.profile`；`wait_run` 可传 `run_id` 和 `timeout_seconds`（1–120 的整数）。

执行前检查完整计划；已有运行、被拒绝或失败的步骤会中止后续执行。`--read-only` 在混合包执行前拒绝修改。包只声明 BAAS 动作，不执行 JS/Python/shell。重复命令、未知参数和内置命令冲突会报错。`packs/baas-core.json` 为内置包参考；扩展包应使用不同 ID 和命令名。

## 配置与打包

偏好独立于桌面端，默认位于 `$XDG_CONFIG_HOME/baas/settings.json` 或 `~/.config/baas/settings.json`；可用 `BAAS_CLI_HOME` / `--config-home` 覆盖。支持服务地址、管道、配置档、语言、运行方式和指令包目录，不保存 Key。

环境变量：`BAAS_SERVER`、`BAAS_PIPE`、`BAAS_PROFILE`、`BAAS_KEY`、`BAAS_SERVER_SIGN_PUBLIC_KEY`、`BAAS_LANG`、`BAAS_CLI_HOME`。连接参数优先级为命令行、环境变量、偏好。`use` 保存当前配置档，`--profile` 只影响本次调用。`BAAS_RUNTIME_HELPER` 可显式指定已构建的安装组件路径；发布包不会自动调用 Cargo。

```bash
bun run cli:build
bun cli/bin/baas.mjs --demo

# 本机可执行发行包，目标机器无需 Bun/Rust
bun run cli:binary
./cli/dist/baas --demo

bun run cli:pack
bun add --global ./cli/dist/baas-cli-0.1.0.tgz
baas --help
```

`cli:build` 会构建原生 Rust helper 和 `cli/dist/baas.js`。`cli:binary` 还会生成 `cli/dist/baas`（Windows 为 `baas.exe`）。构建按当前操作系统和架构进行；不同平台分别构建，不将某个平台的 helper 混入其他平台的包。

两种分发方式都必须包含安装组件：

- Bun 包使用 `bin/baas.mjs`、`dist/baas.js`、`runtime/baas-cli-runtime`（Windows 带 `.exe`）、指令包和许可文件。`cli:pack` 会通过 `prepack` 先构建，再生成 `.tgz`。
- 本机可执行发行包保持 `baas` / `baas.exe` 与 `runtime/baas-cli-runtime` / `runtime/baas-cli-runtime.exe` 的相对目录。不能只复制主程序后丢弃 `runtime` 文件夹。构建脚本会同时将 helper 放入 `cli/runtime` 和 `cli/dist/runtime`，分别供这两种分发方式使用。

CI 在 Windows、Linux、macOS 上检查并构建，发布附件包含 Bun 包 `.tgz` 与原生发行包 `.tar.gz`，两种归档都带有对应平台的安装组件。下载后解开所需归档，保留目录结构与可执行权限。发布用户首次安装 BAAS 环境时无需 Rust 编译工具链。

## 开发与验证

```bash
bun run cli:check
bun run cli:test
bunx eslint cli/src cli/tests packages/baas-client/src packages/baas-client/tests
```

`workspace-view.tsx` 为终端界面，`workspace.ts` 为工作台控制器，`index.ts` 提供脚本命令，`actions.ts` 为统一能力边界，`monitor.ts` 负责运行关联与日志跟随。`packages/baas-client` 是共用无界面客户端。

测试覆盖 socket 分帧、签名加密连接、审批与只读、指令包预检、运行关联、日志恢复、配置冲突、终端净化和 CLI 子进程。模拟验证不等于真机游戏任务验收，需连接设备按实际配置验证。
