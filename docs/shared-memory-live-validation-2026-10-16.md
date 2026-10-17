# Windows 共享内存与 B 服实际验收

日期：2026-10-16（北京时间）。范围为同级 `baas-tauri`、`baas-dev` 工作区；本页记录提交前的实测结果，测试期间保留已有工作区改动。

## 实现范围

Windows 默认从命名管道迁移到共享内存。前后端共用现有业务 channel handler，命令、状态、日志及远控视频和触控都接入新通道。WebSocket 和显式 Pipe 对照入口保留。非 Windows 默认仍使用原有路径，本次未运行 Linux、macOS 或 Android 的设备测试。

Python 与 Rust 之间采用 Win32 文件映射、固定 slot、信号量和停止事件：消息可跨 slot 重组，支持空二进制与 64 MiB 上限；等待容量时阻塞唤醒，不使用高频轮询。连接身份包含 session 与 stream 代次，防止旧对象发送或关闭后来重开的连接。Python 入站字节预算覆盖重组和 endpoint 排队，常规全局 16 MiB、每 stream 8 MiB，空预算允许一条合法的最大报文；这是队列预算，不是 RSS 硬上限。

更新器保留 UV 缓存并移除普通更新中的强制 Git GC；日志线程桥接、前端日志批处理和原始二进制 invoke 优化详见 [首轮性能记录](performance-2026-10-15.md)。

## 实际测试环境与方法

- 使用正在运行的 B 服游戏 `com.RoamingStar.BlueArchive.bilibili`，MuMu 15，设备 `127.0.0.1:16384`，配置 `1783070312368`。
- 在 `.codex_tmp/live-shm-validation/backend` 建立隔离后端，复制本次源码及配置，引用工作区资源和 Python 3.11.9 虚拟环境。没有覆盖日常安装目录。
- 对照使用同一份 Tauri 原生 debug EXE、真实 WebView2 与冻结的 Vite 产品前端；关闭 HMR 和 WebView 后台节流，窗口保持可见。构建任务停止后才采集正式数据。
- 使用实际 store 的 `status`/`solve`、主页原有远控开关、`StreamClientScrcpy`、MSE 播放器和真实触控消息。没有用模拟视频或单独的远控演示替代产品链路。
- 统一 MSE、1280×720、码率 7,340,032 bit/s、请求最大 60 FPS；实际输入视频约 30 FPS。每种模式两轮，顺序为 WS→Pipe→SHM、SHM→Pipe→WS。
- 每轮 200 个串行命令，三次 `restart` 任务、10 秒视频、三对公告打开/关闭触控。`restart` 在游戏已打开时检查当前包，不会强制重启游戏；它不是整套日常任务耗时。
- 点击延迟从真实触控发送开始，到远控视频指定 ROI 的平均 RGB 差首次超过阈值。测量下一次点击前确认公告蓝色标题已完全出现或消失；主界面按钮隐藏时先恢复界面，恢复操作不算公告点击样本。
- 实际显示帧率使用 `requestVideoFrameCallback` 的 `presentedFrames` 差值。`getVideoPlaybackQuality().totalVideoFrames` 和 `droppedVideoFrames` 仅保留原始统计，不将 total 当作实际显示 FPS。

复测入口：[原生 WebView 探针](../tests/browser/live-game-probe.ts)、[CDP 驱动脚本](../scripts/live-game-validation.mjs)。两者仅用于显式开启本机调试端口的开发测试，不会进入生产前端包。

## 正式对照结果

每模式 400 个命令样本、20 秒视频、6 次打开及 6 次关闭公告；表中点击为中位数，FPS 为两轮范围。全部 18 次 `restart` 与 36 次公告触控成功，没有将前置失败补成成功样本。

| 通道 | 命令 RTT p50 / p95 | 视频实际呈现 FPS | 打开公告 | 关闭公告 |
| --- | ---: | ---: | ---: | ---: |
| WebSocket | 0.30 / 0.40 ms | 27.70–28.20 | 710 ms | 181 ms |
| Pipe | 0.90 / 1.20 ms | 27.90–28.20 | 686 ms | 174 ms |
| 共享内存 | 1.20 / 1.60 ms | 26.70–27.40 | 697 ms | 182 ms |

三者接收视频均约 30.0 包/秒；新通道完整保留了实际脚本、视频和触控功能，但**当前适配器的端到端命令延迟尚未胜过 Pipe 或 WebSocket**。两轮轻负载视频样本也没有显示共享内存的呈现帧率优势。不能用原生吞吐掩盖这项差距，也不能用本组有限样本宣称统计显著的总体性能排序。

`restart` 首次包含设备初始化：WS 711–771 ms、Pipe 708–753 ms、SHM 776–845 ms；同一 session 后续四个样本分别为约 48–53、48–51、53–63 ms。远控首个实际呈现帧约 1.54–1.59 秒。完整 `mail` 也分别在三种通道执行成功：初次 WS 7.23 秒、Pipe 6.67 秒、SHM 9.99 秒；邮件状态、初始页面和运行时间不同，SHM 这次从邮件页面经恢复开始，**这些单次耗时仅用于功能验收，不作传输性能排名**。

原始样本：[六轮完整数据](../benchmarks/live-game-transport-windows.json)、[聚合结果](../benchmarks/live-game-summary-windows.json)。原生窗口截图保留在本机验收目录，不随源码提交。

代码检查能确认的固定成本包括：WS 直接从 WebView 进入 Python；两个原生适配器共同经过 invoke、Rust、raw Channel 和 JS 帧解析。共享内存当前又增加 Rust writer 的 mpsc/oneshot、Python reader 到事件循环的线程桥、Python writer actor，以及 slot 信号量操作。Pipe 使用 Tokio writer 与 Python asyncio.Protocol 分发，调度路径不同。共享内存也仍有组包、重组和桥接复制，当前实现并非端到端零拷贝。

这些是可以继续优化的实现环节，不是共享内存机制的限制。没有给每项成本分别加埋点，所以不能将 0.3 ms 差值精确分摊给某个队列或信号量；下一轮应针对小包立即写入路径、线程/actor 唤醒与 WebView bridge 做分段剖析，再用同一真实负载验证。

## 跨进程原生共享内存基准

真正的 Rust/Python 两进程往返，排除 WebView 和游戏：1 KiB 报文 100 次，p50 **0.1076 ms**、p95 **0.1629 ms**；1 MiB 报文 20 次，按往返双向字节计算 **995.0 MiB/s**。使用原生 debug 构建；这个结果不能当作 UI 延迟或整体游戏提速倍数。

验证了 100,012 字节 JSON，二进制 0/1 字节、slot 边界前后、4 MiB 与 8 MiB 以上消息的逐字节一致。入口为 `cargo run -p baas-tauri --example shm_native_probe -- <python> <baas-dev>`，含超时 watchdog，不使用游戏设备。原始结果：[native cross-process](../benchmarks/shm-native-cross-process-windows.json)。

## 实测发现并修复的问题

1. **任务耗尽重试后无报错停止**：真实 `Baas_thread.solve` 在三次恢复后可能落出循环返回 `None`，且没有最终错误日志；单任务上层以 `is False` 判断失败，会漏报。现记录任务名及尝试次数并显式返回 `False`，保留原重试与最后恢复策略。
2. **标准单任务名未初始化变量**：`_original_task_name` 只在旧别名分支赋值，`solve restart` 会在 worker 报错；现统一在转换别名前保存。
3. **MuMu 15 DLL 候选路径缺失**：源码补充 `nx_device/15.0/shell/sdk/external_renderer_ipc.dll`，使用原配置的 Nemu 截图/控制路径进行测试。
4. **初始化失败仍执行任务**：实测 ADB 10054 连接重置后，初始化返回 False，上层仍运行任务且留下 scheduler 假就绪标记，引起二次异常。现停止本次执行、回滚就绪标记、释放 guard、发布失败状态，下次可重新初始化。
5. **切换时自动恢复竞争重启后端**：旧版实际日志显示一次 WS 切换内出现三个后端启动，期间自动 init 在没有会话时触发 recovery；刚提交的任务被后来一次重启中断，pending callback 被清空而超时。现切换期间禁止自动 init/recovery，异步初始化与消息绑定代次，旧控制连接不能更新或撤销新会话；心跳检测给新认证连接完整宽限期。详见 [筛选后的竞态证据](../benchmarks/transport-switch-race-2026-10-16.json)。日志没有标明每次 recovery 的调用方，因此不能将某一次重启单独断言为心跳触发。

前置调试还遇到主界面 UI 隐藏和 ROI 条件不正确，相关失败没有计入正式点击延迟，也没有归因于传输机制。首次邮件实测领取了可领取的非体力邮件奖励，未消费体力或购买；两封体力邮件仍保留。

## 验证与交付

- Python：138 passed、1 skipped（平台专属），包括共享内存、背压、退出、重试、初始化失败、OCR 启动和行为跟踪相关集合；有两个现有 Pydantic 警告。
- Rust Tauri：21 passed；updater：65 passed。
- 前端：51 passed、703 assertions；另通过 Clippy `-D warnings`、TypeScript、i18n 7 种语言、探针额外类型检查及相关 ESLint。
- `bunx tauri build --no-bundle` 成功生成嵌入正式前端的 release EXE（10,710,528 字节），SHA256 为 `8771FDA879FBFEAFE77872D834D621EFF0BA5B902FE91F0E311335CF767286E0`。完整文件与检查记录见 [构建清单](../benchmarks/build-validation-windows-2026-10-16.json)。没有生成安装器。
- 又以这份 release EXE 替换隔离测试目录中的 debug EXE 并实际启动，页面 URL 为 `http://tauri.localhost/`，配置和服务连接均为 `shm`，不依赖 Vite。原有远控开关成功播放 1280×720 视频，3 秒观察到 84 个实际呈现回调，另次为 83 个。生产版鼠标触控通过原始 InteractionHandler 验证；这不是前述精确延迟样本。
- 生产版原生窗口截图保留在本机验收目录。该轮已关闭测试原生实例、其后端/WebView 子进程与冻结 Vite，检查 9229/8191 均无剩余监听；保留隔离测试文件和生产 EXE，游戏与模拟器继续运行。

## 结论适用范围

这次区分了原生共享内存、WebView 桥接和真实游戏三个测量阶段。共享内存机制没有被旧实现或 UI 结果否定；端到端差距需要在消息唤醒、Tauri IPC、WebView 调度、解码与绘制中继续定位。当前约 30 FPS 输入的真实场景足以验证可用性，不足以证明高负载上限。

该轮实测期间没有修改日常安装版、提交代码或推送远端。没有运行消耗体力的日常任务。测试资源与模拟器以外的 ADB 设备分开管理。后续代码清扫与检查结果见 [清扫验收记录](code-cleanup-2026-10-16.md)。
