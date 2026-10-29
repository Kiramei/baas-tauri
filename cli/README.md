# BAAS CLI · 夏莱终端

BAAS 的独立终端客户端和自动化 Agent，直接连接 BAAS Service，无需启动 Tauri 桌面应用或浏览器。普通命令、交互终端、指令包和模型工具共用明确的 BAAS 动作。

界面参考 Claude/Codex 终端的设计原语：欢迎标志、斜杠指令、历史与补全、流式输出和操作确认。实现和 BAAS 指令集均独立编写。

## 开始使用

在仓库根目录执行，需要 Bun 1.3+：

```bash
bun install --frozen-lockfile
bun run cli --demo
bun run cli --help
```

`--demo` 是明确标记的内存环境，可以体验配置档、任务、调度、配置修改和指令包，不会连接真实设备。退出后不保留演示数据。

## 连接后端

使用 BAAS 后端已有的 Service 模式。CLI 不会隐式安装、启停后端服务。

```bash
# 在 baas-dev / blue_archive_auto_script 目录中
python main.service.py --host 127.0.0.1 --port 8190

# 在本仓库运行，/connect 会隐藏输入登录 Key
bun run cli
# /connect
# /profiles
# /use default_config
# /tasks
# /status
```

无交互使用时，通过环境变量传入已有服务登录 Key：

```bash
export BAAS_KEY='你的服务登录Key'
bun run cli --server ws://127.0.0.1:8190 profiles
bun run cli --profile default_config tasks
bun run cli --profile default_config --yes start
bun run cli --profile default_config --json status
```

尚未初始化的服务会用首次输入的 Key 初始化。CLI 复用桌面端相同的签名公钥固定、控制认证和加密业务通道。自部署使用不同签名公钥时，明确传入 `--server-key <公钥>` 或 `BAAS_SERVER_SIGN_PUBLIC_KEY`；不会自动信任 `/health` 返回的公钥。

也支持后端已有的本地命名管道，Unix 使用仅本用户可访问的 socket：

```bash
# 在后端目录；Windows 替换为命名管道路径
python main.service.py --host 127.0.0.1 --pipe-name /tmp/baas-cli.sock

# 后端负责本机管道访问控制，无需 WebSocket Key
bun run cli --pipe /tmp/baas-cli.sock profiles
bun run cli --pipe /tmp/baas-cli.sock --profile default_config status
```

## 交互与脚本命令

| 交互指令                     | 脚本命令                    | 用途                         |
| ---------------------------- | --------------------------- | ---------------------------- |
| `/profiles`、`/use <ID>`     | `profiles`、`use <ID>`      | 查看并明确选择配置档         |
| `/status`                    | `status`                    | 读取运行状态                 |
| `/tasks`                     | `tasks`                     | 查看真实任务名和调度         |
| `/run <task> --wait`         | `run <task> --wait`         | 提交并等待同一次任务运行结束 |
| `/wait [run_id]`             | `wait [run_id]`             | 等待当前或指定运行编号       |
| `/start`、`/stop`            | `start`、`stop`             | 启停选中配置档的调度/任务    |
| `/config get /name`          | `config get /name`          | 按 JSON Pointer 读取配置     |
| `/config set /name '"夏莱"'` | `config set /name '"夏莱"'` | 修改已有配置字段             |
| `/devices`、`/logs 50`       | `devices`、`logs 50`        | ADB 检测和最近日志           |
| `/logs 50 --follow`          | `logs 50 --follow`          | 实时日志，支持只读重连       |
| `/doctor`                    | `doctor`                    | 检查服务健康与配置           |
| `/packs`、`/briefing`        | `packs`、`pack briefing`    | 查看/执行独立指令包          |
| `/models`、`/model <ID>`     | `models`、`model <ID>`      | 浏览兼容服务的模型、切换模型 |
| `/sessions`、`/resume <ID>`  | `sessions`、`resume <ID>`   | 查看和恢复本地 Agent 会话    |
| `/new`、`/clear`             | `new`、`clear`              | 开始新会话                   |
| `/context`、`/reload`        | `context`、`reload`         | 查看/重载 BAAS.md 与指令包   |
| `/settings show`             | `settings show`             | 查看非敏感偏好               |
| `/quit`                      | —                           | 关闭 CLI 连接                |

交互支持 Tab 补全和 ↑/↓ 历史；配置档、模型和会话选择器支持 ↑/↓、Enter、Esc。Ctrl+C 取消当前输入、Agent 请求或监控，Ctrl+D 退出输入。终端适配窄屏、中文宽度，尊重 `NO_COLOR` / `--no-color`，也会净化跨流式片段的 ANSI 控制序列。

`start` / `run` 默认只等待后端接受启动，结果包含 `completed: false` 和后端提供的 `run_id`。添加 `--wait` 才等待相同运行编号的终态；添加 `--follow` 同时显示相关日志。运行结束会返回 `completed: true`，`succeeded` 根据后端 `exit_code` 判断；旧后端无法提供结果时为 `null`。健康检查成功不代表认证或设备任务成功。

```bash
bun run cli --profile default_config --yes --wait --follow run explore_normal_task
bun run cli --profile default_config --wait-timeout 120 wait <run_id>
bun run cli --profile default_config --follow logs 50
```

`--wait-timeout` 单位为秒，默认 300，可设为 1–86400。超时、Ctrl+C 或关闭 CLI 只结束观察；已经提交的后端任务仍可能继续运行，需用 `stop` 明确停止。遇到 `already-running` 会报告已有运行，不重复提交任务。断线恢复只重建连接和读取状态/日志；丢失确认的修改不会自动重放。原运行被替换或无法关联时会明确报错，旧的空闲状态不会被当成本次成功。

所有状态修改要求交互确认，脚本中须显式使用 `--yes`。`--read-only` 同时约束直接命令、指令包和 Agent。配置修改先读取快照；冲突会报错，不自动重试覆盖。

`--dry-run` 预览修改动作及指令包的完整计划，不执行包内步骤。预检仍可连接后端读取配置档、任务和字段，因此可预览真实配置档上的计划：

```bash
bun run cli --profile default_config --dry-run start
bun run cli --profile default_config --dry-run pack daily-wait
```

## 自然语言 Agent

交互中可用 `/login` 重新隐藏输入 BAAS Key，或 `/login model` 设置仅当前进程使用的模型 Key；`/logout` 关闭服务连接并清空当前对话，不停止后端任务。`/use` 和 `/model` 支持方向键选择，Tab 也能补全已经读取的配置档、任务和指令包命令。临时 `--wait`、`--follow`、`--dry-run` 参数仅作用于当前交互命令。

模型是可选功能。配置支持工具调用及 SSE 流式响应的 OpenAI Chat Completions 兼容服务：

```bash
export BAAS_AI_BASE_URL='https://你的模型服务/v1'
export BAAS_AI_MODEL='你的模型ID'
export BAAS_AI_API_KEY='你的模型Key'
export BAAS_KEY='你的BAAS服务Key'

bun run cli --profile default_config
# 查看当前任务安排，找出下一个要执行的任务
# 帮我启动当前配置档的调度

bun run cli --profile default_config -p '查看运行状态并解释最近错误'
bun run cli --profile default_config --read-only --json -p '总结当前状态'
```

本地兼容模型服务可以不提供模型 Key。也可传 `--model <ID>` 与 `--ai-url <URL>`；`BAAS_MODEL` 是 `BAAS_AI_MODEL` 的兼容别名。

Agent 仅能使用 BAAS 状态、配置档、任务、配置读写、启停调度、单任务、等待运行、设备检测和日志工具，不执行 shell、不加载任意代码、不调用任意后端指令。参数经 JSON Schema 校验；工具串行执行，修改需确认，调用轮次、参数/结果长度、超时均有上限。Ctrl+C 终止模型请求和后续调用，已经提交的任务需明确使用 `/stop` 停止。

模型会收到你请求读取的 BAAS 数据，请按需读取配置。凭据字段、已知 Key 及常见凭据文本会在工具结果、模型上下文和会话持久化前脱敏；工具调用编号与关联关系保持完整。偏好文件不保存 Key。

## 会话与本地 BAAS 指令

成功完成的 Agent 对话会自动保存到 `<CLI配置目录>/sessions/<ID>.json`，采用原子替换与 `0600` 文件权限。`sessions` 查看列表，`resume <ID>` 或 `--resume latest` 恢复；`new`/`clear` 新建会话。恢复要求匹配原服务端点与配置档，不会跨服务复用任务上下文。`--no-session` 禁用保存和恢复：

```bash
bun run cli sessions
bun run cli --resume latest -p '继续分析上次的运行状态'
bun run cli --no-session --read-only -p '只在本次进程中查看状态'
```

会话保留模型对话和脱敏后的 BAAS 数据，每个文件最多 2 MiB；损坏文件不会阻止列出其他会话。会话不接受 system 消息、孤立工具结果或缺失回应的工具调用。

CLI 按顺序加载 `<CLI配置目录>/BAAS.md`、当前工作目录的 `BAAS.md`，以及 `--instructions <文件>` 指定的补充文件。可写常用配置档说明、任务偏好与 BAAS 工作流程；这些内容作为补充领域上下文提供给模型，不能扩大工具权限或取消审批。每个文件最多 32 KiB，总量最多 64 KiB，采用 UTF-8 字节计数，相同来源只加载一次。约定路径可以不存在；显式指定的文件缺失则报错。`context` 查看来源，`reload` 重新加载：

```bash
bun run cli --instructions ./my-baas-workflow.md -p '按本地工作流程检查今日任务'
```

## 独立指令包

内置 `baas-core`，独立于桌面插件包：`briefing` 查看状态和当前任务，`connection-check` 检查状态和 ADB，`daily` 启动当前配置档已有调度（需确认），`daily-wait` 启动后等待本次运行最多 120 秒。

将自定义包存入 `<CLI配置目录>/commands/*.json`，重新启动或执行 `/reload` 后可通过 `/my-check` 或 `baas pack my-check` 执行：

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

动作名：`status`、`profiles`、`tasks`、`config_get`、`config_set`、`scheduler_start`、`scheduler_stop`、`task_run`、`devices`、`logs`、`wait_run`。配置档步骤可传 `args.profile`，否则使用当前选择。`wait_run` 是只读动作，可传 `run_id` 和 `timeout_seconds`（1–120 整数）；省略运行编号时可关联同一配置档刚提交的运行。前一步被拒绝、失败，或已有运行导致本次未能提交时，指令包停止后续执行。包 ID、命令、动作及参数严格校验；重复、未知字段或内置命令冲突会报错。包仅能声明这些动作，不执行 JS/Python/shell。

`packs/baas-core.json` 是内置包的可读参考，内置内容编译进程序。扩展时请用新 ID/命令名，勿把同名内置包复制到自定义目录。

## 配置与打包

偏好文件独立于桌面端，默认 `$XDG_CONFIG_HOME/baas/settings.json` 或 `~/.config/baas/settings.json`，可用 `BAAS_CLI_HOME` / `--config-home` 覆盖。`init` 保存连接、配置档、模型 ID/地址和包目录，不保存 Key。`use` 保存当前配置档，`--profile` 只影响本次调用。

`settings show` 查看偏好，`settings set <字段> <值>` / `settings unset <字段>` 管理非敏感字段；凭据继续使用环境变量或隐藏输入。

环境变量：`BAAS_SERVER`、`BAAS_PIPE`、`BAAS_PROFILE`、`BAAS_KEY`、`BAAS_SERVER_SIGN_PUBLIC_KEY`、`BAAS_AI_BASE_URL`、`BAAS_AI_MODEL`、`BAAS_AI_API_KEY`、`BAAS_CLI_HOME`。命令行参数优先于环境变量，环境变量优先于偏好。

```bash
# Bun 可运行包，全部运行时依赖打包进 JS
bun run cli:build
bun cli/bin/baas.mjs --demo

# 本机单文件程序，目标机器无需 Node/Bun
bun run cli:binary
./cli/dist/baas --demo

# 使用 Bun 创建和安装 tarball，无未发布 workspace 运行时依赖
bun run cli:pack
bun add --global ./cli/dist/baas-cli-0.1.0.tgz
baas --help
```

## 开发与验证

```bash
bun run cli:check
bun run cli:test
bunx eslint cli/src cli/tests packages/baas-client/src packages/baas-client/tests
```

`src/index.ts`：入口与 REPL；`actions.ts`：统一能力边界；`agent.ts`：有界流式工具循环；`monitor.ts`：运行关联与日志跟随；`sessions.ts` / `instructions.ts`：会话和领域上下文；`packs.ts`：独立指令包；`ui.ts`：终端显示。`../packages/baas-client` 是无界面客户端，桌面端由旧路径重新导出共用加密协议。

测试覆盖真实 Unix socket 分帧/关联、签名加密 WebSocket 测试服务、OpenAI 兼容 SSE 测试服务、审批/只读、指令包、会话隔离/脱敏、上下文字节上限、终端净化和 CLI 子进程。Bun PTY 测试检查选择器、取消、密钥输入、窄屏中文和终端状态恢复。模拟服务测试不等于真机游戏任务验收，需连接设备按实际配置验证。
