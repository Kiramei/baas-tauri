# baasx · 自动化终端

[English](README.md) | **简体中文**

baasx 是 BAAS 的独立终端工作台，直接管理 Blue Archive Auto Script 的配置档、任务、调度、设备和运行日志。CLI 与 Tauri 桌面端独立运行，共享无界面服务客户端和后端协议。

安装后的命令名为 `baasx`，npm 包为 `@kiramei/baasx`。源码位于 `baasx/`，仓库开发脚本使用 `bun run baasx`、`baasx:build` 等名称。

## 安装

使用 npm、Bun、pnpm、Yarn 或 cnpm 安装时需要 Node.js 20.3+。Deno 可直接运行。选择一种已安装的工具：

```sh
# npm
npm install -g @kiramei/baasx

# Bun
bun add -g @kiramei/baasx

# pnpm
pnpm add -g @kiramei/baasx

# Yarn 1（Classic）
yarn global add @kiramei/baasx

# cnpm
cnpm install -g @kiramei/baasx

# Deno
deno install -g -A npm:@kiramei/baasx
```

安装完成后运行 `baasx --help` 或 `baasx --demo --lang zh`。请确保所用包管理器的全局可执行文件目录已加入 PATH。pnpm 提示找不到全局目录时可运行 `pnpm setup` 并重新打开终端。Yarn 1 可用 `yarn global bin` 查看目录。Bun 默认使用 `~/.bun/bin`，也可能由配置指定其他目录。

Yarn 2 及更新版本没有 `yarn global`，可临时运行：

```sh
yarn dlx --package @kiramei/baasx baasx --help
```

cnpm 默认使用 npm 镜像，新版本可能需要等待镜像同步。若暂时找不到包，可直接使用上面的 npm 命令。

Deno 的 `-A` 为启动器授予全部权限。安装后需将 Deno 和其全局可执行目录（默认 `~/.deno/bin`）加入 PATH。Deno 2.9 起默认等待版本发布满 24 小时；如需立即安装，可在 Deno 2.9 或更新版本的命令中加入 `--min-dep-age=0`。

带作用域的包安装 JavaScript CLI。包管理器根据系统和 CPU 自动选择同版本的运行时。Linux、macOS 和 Windows 各提供 x64、ARM64 CLI；从 v0.1.5 起另支持 Linux ARMv7 硬浮点。`armv7l` 与 Debian `armhf` 使用同一个 `@kiramei/baasx-linux-arm` 包，对应 npm 的 `arm` CPU 值。GitHub Packages 发布带作用域的包；无作用域的 `baasx` 包仍暂缓发布。

Linux ARM32 可在安装 ARM32 Node.js 20.3+ 后使用 npm，或下载 `baasx-<版本>-Linux-ARMV7L.tar.gz`。独立归档内置 Node.js 22.23.5、兼容 Node.js 的 CLI 和 ARMv7 Rust 组件，无需另装 Node.js、Bun 或 Rust。请保留 `baasx`、`dist/baasx-node.mjs` 与整个 `runtime/`，包括 `runtime/node` 和 `runtime/NODE_LICENSE`。Bun 不支持 ARM32；`-Linux-ARMV7L-node.tgz` 附件使用系统已安装的 Node.js。

ARM32 发行物需要 GNU/Linux ARMv7 硬浮点、glibc 2.35+、`libstdc++6` 和 `libatomic1`。兼容的 Debian／Ubuntu 系统可用 `sudo apt install libstdc++6 libatomic1` 补齐运行库。`armhf` 这一名称本身不能确定 CPU 下限，部分发行版也用它表示 ARMv6；此发行物不支持 ARMv6、软浮点 `armel` 和 musl Linux。

ARM32 支持终端工作台、远程服务连接、配置编辑、任务与调度控制、日志及演示模式。目前不支持托管本地安装和本地识别：上游没有 ARM32 OCR 预构建，后端的 Python／依赖／OCR 整体环境也尚未在 ARM32 验证。请通过 `--server` 或 `--pipe` 连接兼容的已有服务。本地 OCR 当前支持 Linux x64、macOS ARM64 和 Windows x64。

## 从源码开始使用

从源码运行需要 Bun 1.4.4+、Rust 1.95+（含 Cargo）和本机 C/C++ 编译工具链。在仓库根目录执行：

```bash
bun install --frozen-lockfile
bun run baasx --demo
bun run baasx --help
```

无参数进入终端工作台。`--demo` 使用明确标记的内存数据，可体验任务、配置档、配置修改、日志与指令包，不连接真实设备。演示数据不跨进程保留。

`bun run baasx` 会增量构建与当前源码匹配的无界面 Rust 安装组件。源码开发需要支持 Bun 的 x64 或 ARM64 电脑。发行 tarball 使用兼容 Node.js 的启动器，需要 Node.js 20.3+；独立归档内置 JavaScript 运行时，无需 Bun 或 Rust，见下方分发说明。

工作台使用往返伸缩的星芒、连接和等待时的文字扫光，以及执行时每两秒一次的颜色呼吸。动画共享时钟，只刷新各自的小组件；选中长标签和窗口末行长日志保留横向滚动。设置 `BAAS_REDUCED_MOTION=1` 可保留静态状态指示，重定向输出或 `TERM=dumb` 时也会关闭动画。窄终端将选项名称与详情分成两行，低高度终端采用两行页头。进入配置页时若尚未选配置档，会先引导选择并自动返回配置页。

工作台包含总览、任务、调度、配置档、日志和配置页面。用 ↑/↓ 选择、Enter 打开或运行、Esc 返回；Shift+Tab 切换页面，Ctrl+T 打开任务、Ctrl+P 打开配置档、Ctrl+L 打开日志。输入 `/` 搜索命令，Tab 补全。支持鼠标点击导航、列表项和确认按钮；滚轮滚动当前列表、日志、安装步骤或较长的确认详情。标签、说明和日志超出可用列宽时会横向滚动，中文、组合字符和 emoji 按显示宽度处理。

顶部 BAASX 品牌和连接信息在所有页面保持相同布局，仅随终端尺寸收缩；底部状态栏使用最后一行，不额外预留空行。

使用 `/reload` 或 Ctrl+R 可像客户端右键“重载”一样重新加载整个终端界面：重置页面与输入状态，重读设置和指令包，恢复连接后回到总览。本地后端和正在运行的任务保持运行。这是在当前程序内重载工作台；非交互命令 `baasx reload` 仍用于重新加载指令包。

交互确认默认选中 Yes：Enter 提交，`n` 或方向键切换至取消，Esc 取消当前操作。可直接点击确认或取消按钮。任务执行后自动展示实时日志；终端宽度至少 110 列时可在工作区右侧同时观察日志，按住中间的竖向分界线左右拖动即可调整分栏宽度。两侧保留最小宽度，终端缩放时保留分栏比例；窄屏使用独立日志页面。向上滚动会暂停跟随，滚回底部恢复。

首次进入可选择语言和运行方式：安装本地 BAAS 服务版环境，或连接已有服务。工作台中的 `/install`、`/local` 管理本地环境；`/connect` 连接已有服务。实际安装和设备任务需按界面进度及后端状态确认。

`/uninstall` 卸载本地后端程序并保留配置和用户数据；`/clear` 清除当前显示的活动和日志，不断开连接或删除数据。命令行可使用 `baasx uninstall`，非交互执行需加 `--yes`。

本地安装复用桌面端的安装核心。新安装默认使用 `stable` 服务版后端，也可通过 `/install dev` 选择开发通道。重装或更新已有环境会沿用选定的通道。默认目录为 `<CLI配置目录>/runtime`，包含私有 Python、BAAS 后端、OCR 和运行依赖。

安装仍需界面确认，`--yes` 不跳过首次安装确认。目前本地 OCR 预构建支持 Windows x64、Linux x64、macOS ARM64。

安装与更新使用类似 Docker BuildKit 的步骤视图：每步显示编号、状态、耗时及独立的可用进度条或传输量；正在运行的步骤自动展开末尾日志，已完成步骤折叠，点击可重新展开最后日志。滚轮查看步骤，PageUp/PageDown 翻页；运行中 Esc 取消安装或更新，完成后 Esc 返回工作台。步骤结果在完成后保留，进度和下载输出原地刷新，已有步骤保持在同一列表中。

支持中文、英语、日语、韩语、德语、法语和俄语。使用 `/language` 切换，或传入 `--lang zh`；环境变量 `BAAS_LANG` 和系统 locale 也可提供默认语言。终端尊重 `NO_COLOR` / `--no-color`，支持窄屏中文宽度与控制序列净化。

## 配置与调度工作台

`/config` 先显示与桌面客户端对应的配置分类，再进入字段。只展示当前后端实际提供、且桌面客户端允许编辑的字段；内部缓存、资产计数等 JSON 不作为通用编辑项暴露。字段与选项名称复用桌面的七语言资源，显示 label 与提交给后端的真实 value 分开，选择英文或日文界面不会改变服务端枚举值。

编辑器按字段提供开关、单选、多选、数字、文本、列表和行表格；数字检查范围和整数要求。咖啡厅邀请、制造阶段、模拟器多开和队伍模式等关联字段随当前配置显示。学生、物品、关卡等选项读取后端目录数据；服务器类型保持只读。推送凭据隐藏显示，脱敏占位符不能写回配置。

制造优先级和学生偏好按实际优先级编号显示，越靠上越优先。用 ↑/↓ 选择条目、←/→ 或鼠标“上移/下移”调整顺序，Space 或行尾按钮添加/移除，`/` 搜索长列表；`<` / `>` 仍可调整顺序。Ctrl+S 保存整个字段。

日程次数和区域等级偏好分别以表格显示，按后端完整区域目录补齐旧配置缺少的行；新区域默认次数为 1，已有的 0 次和偏好顺序保持原值。次数可以点击 `[-]` / `[+]` 或按 `-` / `+` 调整，Enter 编辑具体值；等级偏好点击单元格进入排序。商店购买先选择普通商店或战术对抗赛商店，再编辑该店的刷新次数和商品；配置搜索仍可直接找到商品。数字范围使用明确文字，支持“全部”或最大次数的字段直接选择相应模式，无需输入特殊符号。

扫荡与推图计划使用章、关、次数等行字段；白名单提供条目增删；队伍属性按桌面已有单元格修改。普通行编辑使用 `+` 添加、Backspace/Delete 删除；单值编辑按 Enter 保存。取消、校验失败或并发冲突不会提交修改；失败时保留当前编辑草稿。命令行和指令包的 `config_set` 也遵守同一字段白名单、类型、选项和条件校验。

`/tasks` 的“一次性任务”入口或 `/oneoff` 可运行普通/困难推图、主线/社团/小故事，以及活动剧情、任务和挑战。选定后仍使用单任务运行确认；这些操作不加入 `/start` 的日常调度。也可使用 `/run start_explore_activity_story` 等真实后端任务 ID。

`/scheduler` 编辑当前配置档的真实任务调度，同时支持全部启用/禁用、重置执行时间，以及新增任务默认状态 `on` / `off` / `default`。每项任务可编辑：

| 字段                     | 含义与输入                                                                   |
| ------------------------ | ---------------------------------------------------------------------------- |
| `enabled`                | 启用开关                                                                     |
| `next_tick`              | 下次执行时间；本地日期时间、ISO 日期、Unix 秒或 `now`，`立即` 表示可立即执行 |
| `priority`               | 整数，数值越小越优先                                                         |
| `interval`               | 非负整数秒；`0` 使用每日重置时间                                             |
| `daily_reset`            | 每日重置时间行，包含时、分、秒                                               |
| `disabled_time_range`    | 禁用时间段的开始和结束；跨午夜拆为两段                                       |
| `pre_task` / `post_task` | 按顺序执行的前置/后置任务，从其他现有任务中选择且不能重复                    |

调度保存检查读取时的字段基线，拒绝覆盖并发变更。任务列表与总览显示当前任务、等待队列、已启用数量和下次安排，运行结束后刷新调度数据。

## 更新本地环境

终端程序本身通过 `npm update -g @kiramei/baasx` 升级，或整体替换解压后的独立归档，包括 `runtime/` 和 ARM32 的 `dist/`。`/update` 更新受支持的 CLI 托管后端／OCR 环境，不升级 BAASX。下载归档使用 `SHA256SUMS` 校验完整性，不提供 `.sig` 附件。

工作台使用 `/update` 检查并更新环境；脚本使用 `check-update` 读取本地后端与 OCR 仓库版本，`update` 应用可用更新：

```bash
bun run baasx --json check-update
bun run baasx --yes update
bun run baasx --dry-run update
```

更新只针对完整安装、由 CLI 管理的本地运行环境。更新前检查本次 CLI 所持有后端的全部配置档；只要仍有任务、调度或等待队列，就拒绝更新。确认空闲后关闭该私有后端、更新依赖并复查安装；工作台原先连接本地后端时会重新启动并连接。其他 CLI 实例仍持有运行租约时，安装锁也会拒绝替换该环境。

`--server` / `--pipe` 指定的外部服务不属于本地更新目标，更新不会停止或修改它们。`check-update` 只检查，`--dry-run update` 只预览，`--read-only` 拒绝应用更新。

## 连接已有服务

```bash
# 在支持 Service 模式的后端目录启动服务
python main.service.py --host 127.0.0.1 --port 8190

# 工作台中输入 /connect，隐藏输入服务登录 Key
bun run baasx --server ws://127.0.0.1:8190
```

脚本通过 `BAAS_KEY` 提供服务 Key：

```bash
export BAAS_KEY='你的服务登录Key'
bun run baasx --server ws://127.0.0.1:8190 profiles
bun run baasx --profile default_config tasks
bun run baasx --profile default_config --json status
```

CLI 复用桌面端的签名公钥固定、认证与加密业务通道。连接尚未初始化的服务时，首次输入的 Key 会初始化服务。自部署使用不同签名公钥时，明确传入 `--server-key <公钥>` 或 `BAAS_SERVER_SIGN_PUBLIC_KEY`。

也支持已有后端的本地管道。Unix 使用本用户可访问的 socket，Windows 使用命名管道路径：

```bash
python main.service.py --host 127.0.0.1 --pipe-name /tmp/baasx.sock
bun run baasx --pipe /tmp/baasx.sock profiles
bun run baasx --pipe /tmp/baasx.sock --profile default_config status
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
| `config set /path '<JSON>'`                         | 修改白名单中的已有配置字段     |
| `devices` / `doctor`                                | 检测 ADB 设备 / 检查服务       |
| `packs` / `pack <名称>`                             | 查看和执行独立指令包           |
| `settings show` / `settings set` / `settings unset` | 管理非敏感偏好                 |
| `init` / `connect [URL]`                            | 保存连接偏好 / 连接服务        |
| `check-update` / `update`                           | 检查 / 更新 CLI 托管本地环境   |

管道或重定向输入必须明确指定命令；没有命令时直接报错，不解释输入文本。

连接外部服务时，`start` / `run` 默认只表示后端接受启动，返回 `completed: false` 和可用的 `run_id`。`--wait` 等待相同运行编号的终态，`--follow` 显示相关日志并等待任务结束：

```bash
bun run baasx --profile default_config --yes --wait --follow run explore_normal_task
bun run baasx --profile default_config --wait-timeout 120 wait <run_id>
bun run baasx --profile default_config --follow logs 50
```

本地安装模式的一次性脚本会自动等待 `run`、`start` 或指令包发起的运行结束，再关闭本次私有后端；默认最多等待 24 小时，显式 `--wait-timeout` 可覆盖。连接外部服务时默认等待上限为 300 秒。交互工作台保持后端运行至退出终端。

运行结束时返回 `completed: true`，`succeeded` 根据 `exit_code` 判断；无法证明结果时不会报告成功。`--wait-timeout` 单位为秒，范围 1–86400；超时退出码为 `124`。断线恢复只重建连接并读取状态或日志，不重放修改。任务已在运行时不会重复提交。

Ctrl+C 取消当前等待、请求或监控；工作台空闲时退出。关闭 CLI、取消本地等待或本地等待超时会停止本次 CLI 自己启动的后端及其子进程；通过 `--server` / `--pipe` 连接的外部服务及已提交任务继续运行。需要服务常驻时，先自行启动服务再由 CLI 连接。健康检查成功不代表认证或设备任务执行成功。

直接输入 `/start`（命令行 `start`）立即启动调度，无需再次确认或传入 `--yes`。其他状态修改和指令包仍默认显示确认，交互工作台默认选中 Yes；`--yes` 可跳过常规动作确认，其他非交互修改脚本须明确传入该选项。首次安装仍需界面确认。`--read-only` 约束直接命令和指令包。配置修改读取快照并检查冲突，不自动覆盖并发修改。

`--dry-run` 预览修改动作和指令包完整计划，不执行包内步骤。预检可读取真实配置档、任务和字段：

```bash
bun run baasx --profile default_config --dry-run start
bun run baasx --profile default_config --dry-run pack daily-wait
```

`--json` 输出机器可读结果；持续监控输出逐条 JSON 事件。普通命令输出一个 JSON 文档，过程信息进入 stderr。

## 独立指令包

指令包独立于桌面插件包。内置 `briefing` 查看状态与任务，`connection-check` 检查服务和设备，`daily` 启动已有调度，`daily-wait` 启动后等待本次运行最多 120 秒。

将自定义包保存至 `<CLI配置目录>/commands/*.json`，通过工作台 `/pack my-check` 或命令行 `pack my-check` 执行：

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

baasx 沿用原 CLI 配置目录和 `BAAS_*` 环境变量，无需迁移已有设置或本地环境。偏好独立于桌面端，默认位于 `$XDG_CONFIG_HOME/baas/settings.json` 或 `~/.config/baas/settings.json`；可用 `BAAS_CLI_HOME` / `--config-home` 覆盖。支持服务地址、管道、配置档、语言、运行方式和指令包目录，不保存 Key。

环境变量：`BAAS_SERVER`、`BAAS_PIPE`、`BAAS_PROFILE`、`BAAS_KEY`、`BAAS_SERVER_SIGN_PUBLIC_KEY`、`BAAS_LANG`、`BAAS_CLI_HOME`。连接参数优先级为命令行、环境变量、偏好。`use` 保存当前配置档，`--profile` 只影响本次调用。`BAASX_RUNTIME_HELPER`（兼容 `BAAS_RUNTIME_HELPER`）可显式指定已构建的安装组件路径；发布包不会自动调用 Cargo。

将下面的 `<版本>` 替换为 `baasx/package.json` 中的版本号。

```bash
npm exec --yes --package=bun@1.4.4-canary.20261105.1 -- bun run baasx:build
bun baasx/bin/baasx.mjs --demo

# 固定瘦身编译器，目标机器无需 Bun/Rust；不替换系统 Bun
npm exec --yes --package=bun@1.4.4-canary.20261105.1 -- bun run baasx:binary
./baasx/dist/baasx --demo

npm exec --yes --package=bun@1.4.4-canary.20261105.1 -- bun run baasx:pack
bun add -g "./baasx/dist/baas-baasx-<版本>.tgz"
baasx --help
```

`baasx:build` 会构建原生 Rust helper、`baasx/dist/baasx.js` 和兼容 Node.js 的 `baasx/dist/baasx-node.mjs`。`baasx:binary` 还会生成 `baasx/dist/baasx`（Windows 为 `baasx.exe`）。x64、ARM64 在各自操作系统和架构上构建。

Linux ARM32 从支持 Bun 的 Linux 主机交叉编译。安装 `armv7-unknown-linux-gnueabihf` Rust target 及硬浮点 C/C++ 交叉工具链后，运行 `bun run baasx:binary --target=linux-arm`；`--target=linux-armv7l` 和 `--target=linux-armhf` 等价。构建会生成真实的 ARMv7 Rust 组件，并下载固定版本、校验 SHA-256 的 Node.js 22.23.5 ARMv7 运行时，不会使用不存在的 Bun ARM32 编译目标。CI 通过 `.github/actions/setup-linux-arm` 准备交叉工具链和 QEMU 检查。

JS 发行包经过压缩，x64、ARM64 二进制采用 ESM 和浅层 bytecode 缓存以减少启动解析。其瘦身编译器固定为 `baasx/package.json` 中的 `bun@1.4.4-canary.20261105.1`（revision `b1007f117`）；CI 安装在临时目录，构建脚本核对完整 revision，拒绝其他版本及浮动 canary。此版本的 [运行时裁剪功能](https://bun.com/docs/compiler/size) 仍属实验性：仅删除未使用的 Bun 构建/测试工具、图片、数据库等 API，保留 JIT、WASM、Intl、网络、加密及进程能力，不启用 AOT。配置与指令包功能通过实际编译产物验证。稳定版 Bun 1.4.4 尚不支持裁剪，不能仅升级版本就保证 exe 变小；要回退到完整运行时，使用 `bun run baasx:binary --no-trim`。ARM32 使用 Node.js bundle，不应用 Bun bytecode 或裁剪。

两种分发方式都必须包含安装组件：

- JavaScript tarball 使用 `bin/baasx.mjs`、`dist/baasx-node.mjs`、`runtime/baasx-runtime`（Windows 带 `.exe`）、指令包和许可文件。ARMv7／armhf 安装 Node.js 20.3+ 后，可用 `npm install -g ./baasx-<版本>-Linux-ARMV7L-node.tgz` 安装 ARM32 附件；现有 x64／ARM64 附件保留 `-bun.tgz` 文件名。`bun run baasx:pack` 会先执行 `prepack` 构建，再调用 `bun pm pack --ignore-scripts` 生成 `.tgz`。
- 本机可执行发行包保持 `baasx` / `baasx.exe` 与 `runtime/baasx-runtime` / `runtime/baasx-runtime.exe` 的相对目录。新包保留旧名称 `baas-cli-runtime`，新版也能识别旧包内的同名组件。复制发行包时请保留 `runtime` 文件夹。构建脚本会同时将 helper 放入 `baasx/runtime` 和 `baasx/dist/runtime`，分别供这两种分发方式使用。

CI 在 Windows、Linux、macOS 上检查并构建，每个目标上传 JavaScript 包 `.tgz` 与独立发行包 `.tar.gz`，两种归档都带有对应平台的组件、中英文 README 和许可文件。ARM32 独立归档还包含 `dist/baasx-node.mjs`、`runtime/node` 和 `runtime/NODE_LICENSE`。解压及升级时请保留全部目录与可执行权限。`SHA256SUMS` 覆盖发行归档，BAASX 不发布 `.sig` 文件。目标电脑无需 Rust 编译工具链；托管本地 BAAS 安装仅适用于后端和 OCR 依赖可用的平台。


## 开发与验证

```bash
bun run baasx:check
bun run baasx:test
bunx eslint baasx/src baasx/tests baasx/packages/baas-client/src baasx/packages/baas-client/tests
```

`workspace-view.tsx` 为终端界面，`terminal.ts` 处理终端与鼠标协议，`field-editor.tsx` 提供类型化编辑器；`configuration.ts` 和 `scheduler.ts` 定义可编辑字段、校验与序列化。`workspace.ts` 为工作台控制器，`index.ts` 提供脚本命令，`actions.ts` 为统一能力边界，`monitor.ts` 负责运行关联与日志跟随。`runtime.ts` 包装本地安装组件，`installation.ts` 保存有界步骤进度与日志，`installation-view.tsx` 展示每步进度与日志尾部。`baasx/packages/baas-client` 是共用无界面客户端。

测试覆盖 socket 分帧、签名加密连接、审批与只读、指令包预检、运行关联、日志恢复、配置白名单与类型、调度冲突、七语言文案、鼠标协议、终端净化、结构化安装进度和 CLI 子进程。模拟验证不等于真机游戏任务验收，需连接设备按实际配置验证。
