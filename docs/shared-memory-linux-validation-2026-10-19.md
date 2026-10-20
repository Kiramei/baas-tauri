# Linux 共享内存验证

日期：2026-10-19 至 2026-10-20（北京时间）。分支：`fix/linux-adapt`。

## 实现与范围

Linux 的 Rust/Python 传输使用 POSIX 共享内存、`mmap` 和命名信号量，复用 Windows 的固定 slot、消息分片和业务 channel 协议。报文上限仍为 64 MiB，空二进制和跨 slot 消息均保留。

Rust 独占创建权限为 `0600` 的映射与五个信号量；双方已打开资源并完成 READY 后移除 POSIX 名称，现存句柄继续工作，减少运行期间被强制结束后留下命名资源的情况。创建失败和未完成握手时也会通过正常析构清理已创建的资源。后端退出检测优先使用 `pidfd`，受限环境回退为进程状态和启动代次检查；停止或退出会结束容量等待和接收等待。

这份记录覆盖本机 Linux 的原生跨进程传输、生命周期和实际 Tauri 应用的数据通道。没有运行游戏、模拟器、触控或视频，不将原生吞吐当作 WebView、UI 或游戏性能。

## 复测入口

环境为 Ubuntu Linux x86_64，内核 `7.0.0-31-generic`，后端测试 Python 为 `3.9.0`。验证后端使用隔离目录 `../.codex_tmp/linux-shm-backend`，基于后端 `origin/master@a183e1c9` 加本次 Linux 适配；没有覆盖日常安装版。

原生入口为 [shm_native_probe.rs](../src-tauri/examples/shm_native_probe.rs)，使用后端真实 `SharedMemoryTransportServer` 和专用 echo handler，不初始化 BAAS 或设备：

```sh
cargo run -p baas-tauri --example shm_native_probe -- \
  /home/kiramei/.baas/.venv/bin/python \
  /home/kiramei/Workspace/Idle/.codex_tmp/linux-shm-backend
```

探针有 90 秒 watchdog；无论成功或失败，只会停止自己创建的会话并回收自己启动的 Python 子进程。

## 已通过的独立验证

- Rust/Python 两个真实进程完成 READY、echo channel 打开与终结。
- 100,012 字节 JSON，以及 0、1、65,522、65,523、65,532、65,533、4,194,427、8,388,625、67,108,864 字节二进制均逐字节一致，覆盖 slot 边界与 64 MiB 最大报文。
- 同一业务名称在终结后以新 stream 重开，原生资源全部关闭后以同名重新建立新会话，均能继续通信。
- 强制结束探针自己的 Python 子进程后，Rust 接收端报告后端进程退出；停止会话会唤醒已阻塞的接收并拒绝后续写入。
- READY 后与最后析构后均检查 `/dev/shm`，映射与五个信号量均无剩余命名对象；测试没有留下 echo 子进程。

首次独立编译运行采用与 Cargo example 相同的源码，直接链接已有依赖，以便与应用编译并行完成互操作验证。该轮功能检查全部通过；当时另有 Rust 构建任务运行，不用该轮延迟值推断性能排序。

## 实际应用验收（2026-10-20）

使用现有隔离启动器 `.codex_tmp/linux-dev/start.sh`，将配套后端源码同步到 `../.codex_tmp/linux-dev/backend`，保留独立配置、Python 环境和资产软链。应用以 `--shm-name` 启动 Python，真实 WebView 的 `provider`、`sync`、`trigger` 三个通道均打开，主页数据初始化完成，日志记录 `data ready mode=shm`。

通过设置中的“连接与运行 → 数据传输方式”实际切换 `SHM → Pipe → SHM`，两次均重新加载数据成功，整轮没有 ERROR/CRITICAL 日志，最终保留共享内存模式；`/dev/shm` 没有剩余本次命名对象。GTK 原生最小化、最大化和关闭按钮仍在窗口中。截图与原始应用记录保存在本机 `.codex_tmp/linux-dev/shm-settings-final.png` 和 `shm-app-verification.json`。

Linux 新配置默认使用共享内存；缺少迁移标记的旧 Pipe 配置会迁移一次，`transport_version = 1` 的显式 Pipe/WebSocket 选择保持不变。旧的 Windows 专用后端会在 Linux 启动预检查中被明确拒绝，可更新后端或改选 Pipe/WebSocket。

配套 Python 修改由 [baas-dev PR #68](https://github.com/Kiramei/baas-dev/pull/68) 交付，提交 `53a8492d`，目标为后端 `master`（客户端 dev 渠道实际使用的分支）。日常兄弟仓库 `../baas-dev` 的本地工作区保持原 `master@955e26c3`。前后端适配需要一起交付。

检查结果：前端 200 项通过；Rust 应用 30 项通过（包含真实 Python 进程的重开/退出测试）；更新器 79 项通过、1 项忽略；Python 共享内存 26 项通过，相邻 Pipe/启动测试 12 项通过、1 项 Windows 专属跳过。`bun run build:tauri`、原生 Cargo 构建、Clippy `-D warnings`、TypeScript、相关 ESLint 和 diff check 均通过。

## Cargo 成品复测

2026-10-20 00:01 完成正式 `cargo build -p baas-tauri --bin baas-tauri --example shm_native_probe -j 2` 后，再运行 `target/debug/examples/shm_native_probe`，上述数据一致性、重开、进程退出、停止和资源清理检查全部通过。原始数据为 [Linux 原生跨进程结果](../benchmarks/shm-native-cross-process-linux.json)。

这是 debug 构建的单轮原生观察：100 次 1 KiB 往返，p50 为 1.352 ms、p95 为 1.758 ms、p99 为 29.405 ms；20 次 1 MiB 往返，双向字节吞吐为 218.7 MiB/s。强制退出 Python 后的退出检测为 8.17 ms；停止时唤醒阻塞读取为 30.07 ms。退出和停止的数字包含该次线程调度，不是延迟上限。这组本机样本没有与 WebSocket/Pipe 作同负载对照，也不用于跨系统或与既有 Windows 样本的性能排名。

## 同机三通道对照（2026-10-20）

本轮单独进行同机对照，没有把上一节的单项 debug 样本与本轮优化后的原生探针混算。机器为 i7-11700、16 个逻辑 CPU，Linux 7.0.0-31-generic、WebKitGTK 2.52.6、Python 3.9.0。仅测试隔离后端，不运行游戏、视频、触控或更新；采样期间没有同时运行构建或另一套 benchmark。保留桌面正常后台进程及所有离群样本。

### 实际 Tauri 界面

使用现有 debug 应用、Vite tauri 前端、真实 store/连接工厂和后端 `status` 命令。6 轮采用三种模式的全部排列，每轮每种模式预热 50 次、测量 300 次，切换后等待认证、数据与三个业务通道就绪并静置 1 秒。每种模式共 1,800 次请求，串行并发为 1，切换/启动/认证不计入 RTT。

| 当前产品模式 | 平均串行请求 RTT | 各轮平均 RTT 范围 |
| --- | ---: | ---: |
| WebSocket（含现有加密） | 0.336 ms | 0.227–0.747 ms |
| Pipe（Linux Unix socket） | 0.552 ms | 0.517–0.630 ms |
| 共享内存 | 0.816 ms | 0.773–0.940 ms |

本机普通页面的 `performance.now()` 实测分辨率为 1 ms，`crossOriginIsolated=false`。因此主指标采用每 25 条连续请求的总耗时再除以数量，序列化与数据校验在块计时外；不将单条测出的 0 ms 当成零延迟，也不宣称亚毫秒的单条 p50 精度。量化后的 p95 三者均约 1 ms，区分度不足。窗口始终 visible，`document.hasFocus()` 为 false，保留桌面原有焦点策略。

各轮配置数量与前端状态项数量均为 1，后端实际 `status` 数据均为空对象；回调对象序列化后均为 44 字节（不是网络帧字节数）。所有请求成功，无重连、模式变化或 ERROR/CRITICAL 日志。WebSocket 第 5 轮的抖动也计入均值，没有删除。此结果比较的是空载控制请求，不代表执行任务或视频帧率。

原始逐次样本、块耗时和状态：[界面对照](../benchmarks/ui-transport-linux-2026-10-20.json)；[机器环境](../benchmarks/ui-transport-linux-2026-10-20-environment.json)。入口为 [WebKit inspector 驱动](../scripts/webkit-probe.mjs) 与 [界面探针](../tests/browser/linux-transport-benchmark.ts)。仅在显式启用本机调试端口时加载探针，结束后已关闭该调试端口并以共享内存模式重新启动应用。

```sh
WEBKIT_INSPECTOR_HTTP_SERVER=127.0.0.1:9230 .codex_tmp/linux-dev/start.sh --no-watch
# 另一终端，应用空闲且没有构建或其他 benchmark 时：
node scripts/webkit-probe.mjs 9230 \
  '(async()=>{ const b=await import("/tests/browser/linux-transport-benchmark.ts"); return b.run(); })()'
```

### Rust/Python 原生链路

同一个 Python 进程、同一个 EchoHandler 和事件循环，SHM/Pipe 使用生产服务端，Rust 客户端分别使用现有 SHM 代码及最小阻塞 Pipe/WS 客户端。WebSocket 对照为无压缩、无产品加密的 RFC6455 二进制基线，与上面的产品 SecureWebSocket 分开解释。三种模式使用相同报文、预热、次数、校验方式及交错顺序，校验放在 RTT 计时外。

Rust 探针同源 `rustc -O` 编译，使用已缓存的 debug 依赖，三种模式在同一个可执行文件中；这不是整个产品的 release 构建。两次各 5 轮全部合并，小包每种各 3,000 次，1 MiB 每种 400 次，8 MiB 每种 100 次。吞吐是 `2 × 有效载荷字节数 / RTT 总时长`，表示单个未完成请求的往返有效载荷速率，未计入块间校验时间，不是并发流式带宽。

| 负载 | 共享内存 | Pipe | Plain WebSocket |
| --- | ---: | ---: | ---: |
| 1 KiB JSON RTT p50 | 0.233 ms | 0.036 ms | 0.090 ms |
| 1 KiB binary RTT p50 | 0.215 ms | 0.022 ms | 0.071 ms |
| 1 MiB binary 往返吞吐 | 873 MiB/s | 2,205 MiB/s | 1,725 MiB/s |
| 8 MiB binary 往返吞吐 | 930 MiB/s | 656 MiB/s | 746 MiB/s |
| 8 MiB binary RTT p50 | 16.44 ms | 20.70 ms | 16.01 ms |

8 MiB 下共享内存相对 Pipe 的聚合吞吐约高 42%，典型 RTT 约低 21%；与 Plain WebSocket 的 RTT 中位数接近。Plain WS 有首轮重尾，不能把聚合吞吐差异宣传为稳定的 25% 优势。两次测试和所有慢样本均保留，不能据此推断任意包大小或生产 release 的排名。

原始结果：[首轮 5 轮](../benchmarks/native-transport-linux-2026-10-20.json)、[复测 5 轮](../benchmarks/native-transport-linux-2026-10-20-repeat.json)、[10 轮合并](../benchmarks/native-transport-linux-2026-10-20-combined.json)。合并文件包含编译命令、源码/fixture 哈希与分轮范围；[Rust 探针](../src-tauri/examples/transport_native_probe.rs) 和 [Python fixture](../tests/fixtures/transport_echo_peer.py) 可复测，完成后会清理自己的进程、Unix socket 和 POSIX 名称。

当前实现没有显示常用小消息的提速。源码可确认 SHM 经过独立读取线程到 asyncio 的投递、writer actor 队列、slot 信号量和分片/组包复制；这些是可优化路径，但本轮没有分段 profile，不能将差值精确归因到某一步。较大的 8 MiB 报文显示相对 Pipe 的优势，尚无实际游戏或视频性能结论。

同时通过 `cargo check` 的 example 检查、库与 example 的 Clippy `-D warnings`、Rust 应用库 30 项测试、updater 79 项测试（另有 1 项 ignored）和前端 200 项测试。后端原有共享内存测试在 Linux 放开平台标记后 22 项通过，包含 slot 回绕、背压、慢消费者、入站字节预算和退出清理。
