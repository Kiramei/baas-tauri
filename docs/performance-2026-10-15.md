# 更新和界面数据链路提速记录

初始日期：2026-10-15；补充复核：2026-10-16。范围：`baas-tauri` 与同级 `baas-dev` 工作区。本页记录此版本提交前的本地验收结果。

本页保留首轮基础优化、归档审计和局部基准。后续已接入 Windows 共享内存并补充跨进程与 WebView 验证；真实 B 服脚本、远控及传输 A/B 的当前验收结果统一见 [共享内存实际验收报告](shared-memory-live-validation-2026-10-16.md)。

## 判断依据

共享内存的性能问题应定位到具体实现，不能拿旧实现或整条链路的慢来否定机制。需要分别测量：

1. Python 与 Rust 之间的内存读写、消息编码和通知唤醒。
2. Rust 到 WebView 的 IPC、缓冲复制和调度。
3. JavaScript 状态更新和 React 渲染。

当前 WebSocket 直接进入 WebView；本地管道经过 Python → OS pipe → Rust → Tauri Channel → WebView。把 pipe 换成共享内存只替换其中 Python ↔ Rust 的一段。其他阶段仍需独立优化和验收。

已核对远端归档引用 `archive/shared-memory-wip-20260712` 指向
`ccb75a4194f7d25cae00a5a0bb83011975644ad7`，与本地引用一致。

该分支的 `benchmarks/webview-copy-windows.json` 记录 60 个 1 MiB 数据块经过 WebView bridge 共约 4.50 秒，吞吐约 13.33 MiB/s。这是桥接基准，**不是共享内存读写速度**。同分支说明文档中的另一组数字与保存的 JSON 不一致，应以具体测试条件和原始样本为准。

归档还存在消息分片接收缺口：Rust 写入端使用 64 KiB 分片，而接收端没有完整接好重组逻辑。隔离提取真实 Rust 接收函数后，100,011 字节 JSON 的两片均解析失败，100,000 字节二进制被当作 65,536 和 34,464 字节两条消息；先用归档已有函数重组后，两者均还原正确。

方向必须区分清楚：对应 `baas-dev` 归档 `b10ba04f447ae574d4baef80ed1416c0d990ad0a` 中，Python 出站直接写完整单帧，不会自动在 64 KiB 分片，超过 8 MiB 则报错。因此上面的 Rust 接收测试复现的是显式分片场景的真实协议缺陷，不能声称默认 100 KB Python 响应必失败。Python 入站也逐帧解析而未重组，与 Rust 的 64 KiB 出站分片存在不匹配。

归档环算法基准也已重跑：1 MiB 的进程内读写循环约 0.2 ms，按脚本双向字节口径约 10 GiB/s。它只衡量进程内环算法与缓存，不能当作跨进程 IPC 或 WebView 性能，更不能与旧桥接数据直接计算提速倍数。上述问题均属于具体实现；未重现用户当时运行现场，不能认定是当年失败的唯一原因。

## 本次实现

### 更新

- 普通 Git 更新保留 `fetch --depth 1` 和 `reset --hard FETCH_HEAD`，移除每次强制 `reflog expire`、`gc --prune=now`。Git 仍保留自身按阈值触发的自动维护。
- 普通依赖同步保留 UV wheel 缓存；依赖没变时仍使用原有 requirements 缓存。终端阶段 ID 保持兼容，文案改为保留缓存。
- 没有增加“SHA 一致就跳过 reset”的捷径，保留更新覆盖损坏/修改文件的既有行为。
- 保留缓存会占用更多磁盘，显式维护方式见 [updater README](../crates/baas-updater/README.md)。

### 命名管道与 WebView

- Rust 接收时直接保留 BPIP 帧，避免先分配 payload 再复制为完整帧。
- 使用有上限的缓冲读取，只合并已经收到且完整的帧，最多 128 帧、256 KiB；首帧可以大于批次上限，但仍受既有 64 MiB 消息限制。安静通道不会等待下一帧来凑批，close/error 保持顺序边界。
- 新前端显式请求批次，旧前端默认仍收到单帧。Python 端 BPIP 协议不变。
- WebView → Rust 二进制调用使用 raw invoke，移除 `Array.from(bytes)` 和 JSON 数字数组。Rust 仍接受原来的 JSON 调用。此处使用 [Tauri 官方 raw request API](https://v2.tauri.app/develop/calling-rust/#accessing-raw-request)。

### 前后端日志与状态

- Python 日志摄入每次线程池往返最多取出 128 条已有记录；首条不等凑批。仍逐条记录历史、逐条发布并让出事件循环，保持多个 scope 的消费机会。
- 跨线程状态广播直接安排 fanout 回调，减少每次创建 coroutine task 和 Future 的成本。
- 前端历史日志分组一次写入；实时日志按最多 16ms 或 256 条批量写入 Zustand，保留所有已收到的行和各 scope 顺序。状态、命令响应不等日志计时器。
- 断开、切换、重连前同步刷出待显示日志；切换连接代次后忽略旧连接数据。配置列表删除 scope 前也先刷出，避免旧批次重新插入已删除 scope。
- 本次没有改变后端原有慢订阅队列的溢出策略，也没有裁剪历史日志。

### 后续接入的 Windows 共享内存

- 共享内存适配器复用现有业务 channel handler，沿用原始 WebView 二进制桥接；Python ↔ Rust 使用固定 slot 和 Win32 信号量转移所有权，逻辑消息支持跨 slot 重组。
- Windows 默认使用 `shm`；旧 `pipe` 配置通过 `transport_version` 一次迁移，显式 Pipe 对照入口及 WebSocket 保留。非 Windows 默认仍走原生 Pipe，Android 原有启动流程不变。
- 入站字节 lease 覆盖消息重组、线程桥接和 endpoint 排队。常规全局预算为 16 MiB、每 stream 为 8 MiB；空预算允许单个最大 64 MiB 报文。这是排队预算，不是进程 RSS 硬上限。
- stream 身份包含连接 generation，重开、迟到 CLOSE、旧对象关闭、进程退出和 READY 超时均有对应生命周期处理及回归覆盖。

## 本机局部基准

Windows，本地合成负载。每行测量阶段不同，不能相加，也不能当作整体应用提速倍数。

| 场景 | 修改前中位数 | 修改后中位数 | 范围 |
| --- | ---: | ---: | --- |
| 12 MiB 浅仓库小版本更新，4 轮 | 936.95 ms | 441.12 ms | 本地 Git；排除公网波动 |
| 暖缓存 8 MiB wheel 版本切换，4 轮 | 525.49 ms | 175.41 ms | compile + sync + 旧清理；本地 HTTP |
| 10,000 行 Python 日志摄入，5 轮 | 808.37 ms | 43.56 ms | 无订阅者；不含传输/UI |
| 10,000 行 JS 日志状态准备，7 轮 | 99.09 ms | 0.97 ms | 不含 WebView/React 绘制；状态通知 17,500 → 80 |
| 1 MiB 二进制 JS 编码，20 轮 | 13.31 ms | 0.038 ms | JSON 数字数组 → raw envelope；不含真实 IPC |

UV 基准的后续四轮 HTTP 传输从约 64.2 MiB 降为 0，前提是所需 wheel 已在缓存中。首次下载、新包和缓存缺失仍需联网。

原始样本与复测入口：

- [更新样本](updater-performance-local-2026-10-15.json)，`python scripts/benchmark-updater.py --help`
- [前端日志样本](benchmarks/log-batching-windows.json)，`bun scripts/benchmark-log-batching.ts 10000 7`
- [二进制编码样本](benchmarks/pipe-encoding-windows.json)，`bun scripts/benchmark-pipe-encoding.ts`
- [Python 日志样本](../../baas-dev/docs/performance/log-pump-20261015.json)，在 `baas-dev` 执行 `python develop_tools/benchmark_log_delivery.py --help`
- [归档共享内存审计样本](benchmarks/archived-shm-audit-windows.json)，`python scripts/audit-archived-shm.py`；需要本地归档引用和已缓存的 Cargo 依赖

Rust 的 1,000 帧突发测试中，266,000 字节数据逐字节、按顺序一致，需过桥的批次数从 1,000 降至 9。该测试使用内存读取 fixture，仅证明合批和内容正确，不衡量真实 WebView 延迟。

## 验证记录

- 2026-10-16 最终更新器复测：`cargo test -p baas-updater` 为 65 passed；另有 0 个 doctest。
- 同次集成复测：`cargo test -p baas-tauri --lib` 为 21 passed，包含共享内存 generation、同 route 重开、READY 超时和真实 Python peer 退出测试。
- 2026-10-15 基础阶段的 `bun test tests/frontend` 为 43 passed，覆盖 store 恢复与待刷日志（传输被 mock），以及 Pipe 单帧、合批、关闭、异常和原始二进制调用。
- 同一基础阶段 `baas-dev` 的 `python -m pytest tests/service -q` 为 85 passed、1 skipped（Unix 专属），包含本机 Windows named pipe roundtrip；当时 TypeScript、前端构建、Rust clippy 和 diff whitespace 检查通过。
- 以上前端与 Python 数量是首轮历史记录；新增共享内存背压、跨进程及真实业务验证的最终计数和范围，以 [后续验收报告](shared-memory-live-validation-2026-10-16.md) 为准。

## 共享内存与整体体验的验收边界

共享内存适配器现已实现。首轮公共链路局部基准不能用于计算它的端到端提速倍数，也不能据此宣称某种传输在所有负载下都更快。

当前实现保持业务消息可靠有序，没有将视频丢帧策略用于日志，也没有随意丢弃 H.264 数据片。消息重组、跨进程发布、容量背压、generation 隔离与资源回收已分别补充测试。

跨进程吞吐、WebView 消息时延和真实游戏体验仍是不同测量范围。实际 B 服脚本、远控画面、Pipe/共享内存 A/B、测试实例与安装版的区别，以及仍未覆盖的指标，均应引用 [2026-10-16 实际验收报告](shared-memory-live-validation-2026-10-16.md)，不再将本页的首轮阶段边界当作当前实现状态。
