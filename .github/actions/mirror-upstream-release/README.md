# 镜像客户端发布到上游

将源 GitHub 稳定版 Release 的**各平台安装文件**镜像到 `pur1fying/blue_archive_auto_script`。直接传输已发布文件，不重新构建；上游文件名明确添加平台名称，文件字节保持原样。

正式流程位于 [release-app.yml](../../workflows/release-app.yml)：`release-update` 完成后，`mirror-to-upstream` 与 CNB 同步独立并行。镜像失败会显示警告和步骤汇总，不阻断 CNB、Winget 或 QQ 通知，可单独重试。镜像 job 串行执行，手动运行不占用正式发布队列。

## 身份与权限

源仓库使用当前工作流的 `GITHUB_TOKEN` 读取 Release。目标仓库优先使用 GitHub App 安装令牌：

1. 由目标仓库所有者将 App 安装到 `pur1fying/blue_archive_auto_script`，授予该仓库 **Contents: Read and write**。
2. 在源仓库配置变量 `UPSTREAM_MIRROR_APP_ID`，以及秘密 `UPSTREAM_MIRROR_APP_PRIVATE_KEY`。
3. 工作流创建目标仓库的短期安装令牌，并通过 `target-token` 传入 action。

**启用生产镜像前，还需由目标仓库所有者确认已有 Release 自动化会过滤 `tauri-` 标签。** 上游的 `mirrorchyan_release_note.yml` 监听 `release` 的 `edited`、`released` 事件，当前只限制仓库，未排除客户端标签。首次发布 prerelease 不会产生 `released`，但后续编辑镜像标题或正文会产生 `edited`，仍可能误触原 BAAS 的 MirrorChyan 发布说明。

建议在上游对应 job 使用以下条件，同时保留手动触发：

```yaml
if: ${{ github.repository == 'pur1fying/blue_archive_auto_script' && !startsWith(github.event.release.tag_name, 'tauri-') }}
```

本次没有修改目标仓库的工作流。镜像脚本在标题、正文与发布状态一致时应跳过更新，减少重复事件；**prerelease 本身不能隔离所有上游 Release 事件**。

备用方式是在源仓库配置秘密 `UPSTREAM_MIRROR_TOKEN`：由**目标仓库所有者**签发、只选择目标仓库、具有 **Contents: Read and write** 的 fine-grained PAT。[GitHub 当前列出的限制](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#fine-grained-personal-access-tokens-limitations)包括 outside/repository collaborator 场景；Kiramei 的协作者写权限不代表 Kiramei 自己签发的 fine-grained PAT 能选择 `pur1fying` 的仓库。

令牌不放入标签、命令行参数、产物或发布正文。脚本只从 `SOURCE_GITHUB_TOKEN`、`TARGET_GITHUB_TOKEN` 环境变量读取令牌。

## Action 接口

| 输入 | 默认值 | 用途 |
| --- | --- | --- |
| `source-token` | 必填 | 读取源 Release 与附件。 |
| `target-token` | 空 | 实际同步必填；公开目标的 dry run 可不提供。 |
| `source-repository` | 当前 GitHub 仓库 | 源 `owner/repository`。 |
| `target-repository` | `pur1fying/blue_archive_auto_script` | 目标 `owner/repository`。 |
| `tag-name` | 必填 | 已发布的源稳定版标签。 |
| `dry-run` | `false` | 只读取元数据并输出计划，不修改 Release、标签或附件。 |

输出为 `target-tag`、`release-url` 和 `status`；`status` 为 `planned` 或 `synced`。

## 标签与附件行为

- 源 Release 必须已发布且为稳定版；draft 或 prerelease 不会镜像。源标签可带 `v` 前缀或稳定版 `.postN` 后缀，规范化后使用 `tauri-<canonicalVersion>`，例如 `0.0.10` 对应 `tauri-0.0.10`。
- 目标标签首次创建时指向**目标仓库默认分支自己的提交**。已有标签不移动；没有归属镜像 Release 的同名孤立标签会拒绝复用，不会把客户端仓库的 Git 对象推入上游。
- 目标 Release 的归属标记绑定源 Release。首次同步先创建 draft；需要修复的已有镜像也会暂转 draft，并在 draft 内更新标题与正文。待附件集合、内容摘要及源快照复核通过后，再发布为 **prerelease**，并设置 `make_latest=false`。失败时可能保留 draft，重试完成后才重新公开。
- 只选择当前版本 `BAAS.Tauri_<version>_` 前缀的安装文件：Windows `*-setup.exe`（含固定 WebView2 安装版）、Linux `.deb` / `.rpm` / `.AppImage`、macOS `.dmg`、Android `.apk`。不传 Windows 便携版、Updater 专用归档、签名或校验清单。
- 在版本号后、架构前插入 `win_`、`linux_`、`macos_` 或 `android_`。已有相同平台标识不重复添加。例如 `BAAS.Tauri_0.0.10_x64-setup.exe` → `BAAS.Tauri_0.0.10_win_x64-setup.exe`；`BAAS.Tauri_0.0.10_android_arm64-v8a.apk` 保持原名。
- 选中文件为空或改名后发生碰撞时，在任何目标写入前失败。最终数量、名称和 SHA-256 校验以筛选、改名后的安装文件集合为准；报告同时记录 `source-name` 和目标 `name`。源端完整附件集合仍参与快照稳定性检查。
- 同名、同大小且双方具有匹配的有效 SHA-256 摘要时跳过传输。需要传输的文件下载后计算摘要；目标上传结果也需校验。
- 替换附件时，先上传并校验 staging 文件，再将旧附件改为 backup 名称并提升新附件。失败时尝试恢复旧名称；重试可接续受管理的 staging/backup。完成后只清理本动作管理的临时附件，遇到未知额外附件则失败并保留它们。
- 创建请求超时、响应丢失或返回网关错误时，只做有界退避查询，不再次发送创建请求。若仍无法确认结果，会明确报告“创建结果不确定”；请先核验目标标签和草稿，再手动重跑，避免暂时不可见的草稿被重复创建。

## 手动重试与 dry run

使用 `release-app.yml` 的 `workflow_dispatch`，填写 `mirror-tag`，先保留 `dry-run=true`。手动入口只运行镜像 job，不启动客户端重构建；确认计划后再将 `dry-run` 改为 `false`。

注意两个默认值不同：**手动工作流默认 dry run；直接调用本 action 默认实际同步**。

代码合入 `main` 后，可通过以下命令检查既有版本。此模式不要求目标秘密，也不会生成 App 令牌：

```sh
gh workflow run release-app.yml --repo Kiramei/baas-tauri --ref main \
  -f mirror-tag=0.0.9.post1 -f dry-run=true
```

本地只读检查可以使用：

```sh
python3 scripts/mirror-upstream-release.py \
  --source-repository Kiramei/baas-tauri \
  --target-repository pur1fying/blue_archive_auto_script \
  --tag-name '<existing-stable-tag>' \
  --dry-run
```

Dry run 只检查元数据与计划，不下载大型附件，因此不代表已验证文件字节摘要或已完成同步。实际执行前配置目标身份；凭据缺失时同步应失败，不会退回使用源仓库令牌写入上游。

本地或 dry run 未提供令牌时，公开仓库读取仍受 GitHub 匿名 API 限流约束；脚本按服务端重试时间等待并即时显示日志。工作流使用 `GITHUB_TOKEN` 读取源仓库，也可通过已配置的目标令牌读取目标元数据。
