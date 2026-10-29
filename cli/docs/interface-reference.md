# 终端界面参考

本次重构实际克隆并阅读了 [oboard/claude-code-rev](https://github.com/oboard/claude-code-rev)，参考版本为 `3b0498a6c684683161077f3c6c5097c6d37cc882`。参考仓库保留在开发临时目录，不作为 BAAS 的源码或运行依赖。

| 参考位置                                                      | BAAS 中的应用                                                                                                  |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/components/LogoV2/LogoV2.tsx`、`WelcomeV2.tsx`           | 宽终端双栏欢迎区域；左侧自制 BAAS 光环像素标识、配置档及连接状态，右侧快速操作和最近动态。窄终端压缩为状态栏。 |
| `src/components/PromptInput/PromptInput.tsx`                  | 贯穿终端的上下分隔线、输入光标、底部键盘提示。                                                                 |
| `src/components/PromptInput/PromptInputFooterSuggestions.tsx` | `/` 命令建议、方向键选择、Tab 补全、最多五行可见选项。                                                         |
| `src/components/CustomSelect`                                 | 当前选择与焦点分开表达；任务、配置档、语言均可键盘选择。                                                       |
| `src/components/Spinner`                                      | 运行期间轻量状态动画、取消提示与任务日志，显示实际后端状态。                                                   |

实现位于 `cli/src/workspace-view.tsx`，由 Ink 和 React 驱动。操作由 `workspace.ts` 显式分发到 BAAS 协议；没有模型、聊天会话或自然语言执行路径。标识、配色、业务组件与实现均为 BAAS 自有内容。

国际化覆盖界面、首次安装、确认及帮助；后端返回的配置档名称、任务标识、日志和配置值保留原始数据。新增界面文案应同步七份 `cli/locales/*.json` 并运行 `bun run cli:test`。
