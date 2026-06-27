# 开发与文档维护

BAAS Tauri 使用 React、Vite、Tailwind CSS、Zustand、i18next 和 Tauri 2。客户端通过 WebSocket 与后端同步状态、配置、日志和触发命令。

## 文档维护

- 应用内文档只维护中文和英文。
- 其他语言回退英文。
- 网页文档站位于 `baas-tauri/docs`，使用 Fumadocs 和 Next.js 静态导出。
- 旧 `baas-dev/docs` 的安装、使用、开发、脚本、日志和服务模式资料会逐步迁移到网页文档站。

新增功能时，应同时更新配置说明、调度说明、故障排查和 README。
