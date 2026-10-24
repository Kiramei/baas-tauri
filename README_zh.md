# BAAS Tauri

<p>
  <a href="README.md"><kbd>English README</kbd></a>
  <a href="https://github.com/Kiramei/baas-tauri/releases/latest"><kbd>下载最新版</kbd></a>
  <a href="https://baas.kiramei.moe/docs/zh/"><kbd>文档站</kbd></a>
  <a href="LICENSE"><kbd>GPL-3.0-only</kbd></a>
</p>

原生 Android 开发位于 [`android-dev`](https://github.com/Kiramei/baas-tauri/tree/android-dev)。
最新 debug 候选已在 Android 12 ARM64 真机的 root Shizuku 模式下完成限定验证：游戏冷启动至邮件流程、预览横屏进入/返回、Activity 重建及配置 ZIP 往返。
Android 15 shell 模式输入、完整手势矩阵、release 构建及整体提速尚未通过验收，不代表通用兼容或发布验收通过。
详见[目标与当前状态](docs/ANDROID_GOALS_AND_STATUS_20261024.md)、[各版本验证记录](docs/ANDROID_RUNTIME_VALIDATION.md)与[历史交接文档](docs/ANDROID_PREVIEW_HANDOFF.md)。
桌面端与当前文档开发位于 [`dev`](https://github.com/Kiramei/baas-tauri/tree/dev)。

BAAS Tauri 是 [Blue Archive Auto Script](https://github.com/pur1fying/blue_archive_auto_script) 的客户端，可管理配置档、调度、功能配置、日志、更新和远程设备画面。设备连接、识别与任务执行由 BAAS 后端完成。

<p>
  <img src="https://raw.githubusercontent.com/Kiramei/baas-tauri/f123464c8e1293437095eb95c44546446a370930/docs/public/baas-icon.webp" width="72" alt="BAAS 图标" />
</p>

## 桌面端界面预览

<img src="https://raw.githubusercontent.com/Kiramei/baas-tauri/f123464c8e1293437095eb95c44546446a370930/docs/public/media/desktop/zh/scheduler-list.webp" alt="BAAS Tauri 桌面端任务调度界面" />

## 🧭 它负责什么

| 区域        | 能做什么                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| 🗂️ 配置档   | 隔离账号、区服、模拟器实例和任务策略。                                                                       |
| ▶️ 主页     | 启动/停止调度，查看执行中任务、下一个任务、队列、日志、资产和远程画面。                                      |
| 🗓️ 调度     | 启用任务、编辑下次执行时间、搜索、排序、设置间隔、每日重置、前置任务和后置任务。                             |
| 🧩 功能配置 | 配置服务器、模拟器、脚本、推图、扫荡、编队、咖啡厅、日程、商店、制造、战斗、维护和推送。                     |
| 🎛️ 设置     | 调整主题、语言、背景图、UI 缩放、远程解码器、安全流、低性能模式、更新通道、更新源、MirrorC CDK 和 SHA 测试。 |
| 📚 文档     | 通过标题栏“帮助 → 文档”，使用系统默认浏览器打开文档站。                                                      |

## 🖼️ 截图

| 桌面端调度工作流                                                                                                                                                                            | 桌面端功能配置                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| <img src="https://raw.githubusercontent.com/Kiramei/baas-tauri/f123464c8e1293437095eb95c44546446a370930/docs/public/media/desktop/zh/scheduler-workflow.webp" alt="桌面端任务依赖工作流" /> | <img src="https://raw.githubusercontent.com/Kiramei/baas-tauri/f123464c8e1293437095eb95c44546446a370930/docs/public/media/desktop/zh/config-cafe.webp" alt="桌面端咖啡厅功能配置" /> |

| 桌面端运行与连接                                                                                                                                                                          | 桌面端设置与更新                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <img src="https://raw.githubusercontent.com/Kiramei/baas-tauri/f123464c8e1293437095eb95c44546446a370930/docs/public/media/desktop/zh/settings-runtime.webp" alt="桌面端运行与连接设置" /> | <img src="https://raw.githubusercontent.com/Kiramei/baas-tauri/f123464c8e1293437095eb95c44546446a370930/docs/public/media/desktop/zh/settings-updates.webp" alt="桌面端更新设置" /> |

## 📥 下载

安装包发布在 [GitHub Releases](https://github.com/Kiramei/baas-tauri/releases)。下载最新版时，请按你的操作系统和 CPU 架构选择对应文件。

| 系统                        | 安装包                                        |
| --------------------------- | --------------------------------------------- |
| Windows x64                 | `BAAS.Tauri_*_x64-setup.exe`                  |
| Windows ARM64               | `BAAS.Tauri_*_arm64-setup.exe`                |
| Windows x64 固定 WebView2   | `BAAS.Tauri_*_x64_fixed_webview2-setup.exe`   |
| Windows ARM64 固定 WebView2 | `BAAS.Tauri_*_arm64_fixed_webview2-setup.exe` |
| macOS Apple Silicon         | `BAAS.Tauri_*_aarch64.dmg`                    |
| macOS Intel                 | `BAAS.Tauri_*_x64.dmg`                        |
| Linux Debian/Ubuntu         | `BAAS.Tauri_*_amd64.deb` 或 `*_arm64.deb`     |
| Linux Fedora/RHEL           | `BAAS.Tauri_*_x86_64.rpm` 或 `*_aarch64.rpm`  |

文档站中也提供动态下载面板，会读取最新 GitHub Release 并展示可直接下载的安装包。

## 📚 文档站

[中文文档](https://baas.kiramei.moe/docs/zh/) · [English documentation](https://baas.kiramei.moe/docs/en/)

当前 Fumadocs/Next.js 文档源码位于
[`dev/docs`](https://github.com/Kiramei/baas-tauri/tree/dev/docs)，本地预览和构建方式见其
[README](https://github.com/Kiramei/baas-tauri/blob/dev/docs/README.md)。

自建部署可在构建时设置 `VITE_BAAS_DOCS_URL`；旧的 `VITE_BAAS_WIKI_URL` 仍作为回退配置保留。

## 🛠️ 开发

前置条件：

- Bun 1.3 或更高版本。
- 与当前 Vite 和 Next.js 工具链兼容的 Node.js。
- Rust 工具链和 Tauri 2 前置依赖。
- 完整运行交互需要 BAAS 后端服务。

```bash
bun install --frozen-lockfile
bun run dev
bun run dev:tauri
bun run build
bun run build:tauri
bun run lint
```

| 命令                  | 作用                       |
| --------------------- | -------------------------- |
| `bun run dev`         | 启动 Vite 开发服务器。     |
| `bun run dev:tauri`   | 以 Tauri 模式启动前端。    |
| `bun run build`       | 类型检查并构建 Web 资源。  |
| `bun run build:tauri` | 构建 Tauri 模式前端资源。  |
| `bun run lint`        | 执行 ESLint 和 i18n 检查。 |
| `bun run i18n:check`  | 检查多语言键一致性。       |

## 🧱 项目结构

```text
baas-tauri/
├─ src/                    # React 客户端
├─ src-tauri/              # Tauri 2 Rust 外壳、命令、窗口和权限
├─ public/locales/         # 应用 UI 多语言文件
├─ public/docs/            # 旧本地文档兼容内容
├─ docs/                   # Fumadocs 文档站
└─ .github/workflows/      # 发布和文档部署工作流
```

## 开发分支

- [`dev`](https://github.com/Kiramei/baas-tauri/tree/dev)：桌面端、WebUI 和文档开发。
- [`android-dev`](https://github.com/Kiramei/baas-tauri/tree/android-dev)：原生 Android 开发与[交接文档](docs/ANDROID_PREVIEW_HANDOFF.md)。
- [`main`](https://github.com/Kiramei/baas-tauri/tree/main)：发布版本与线上文档。

## 许可证

本项目使用 GPL-3.0-only 协议。详见 [LICENSE](LICENSE)。
