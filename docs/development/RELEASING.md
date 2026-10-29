# 发布版本

发布前由维护者指定版本；准备工具只修改本地文件，不创建或推送标签，也不发布 Release。

公开版本只使用以下格式，数字按数值比较：

- 正式版：`0.0.9`
- 候选版：`0.0.9.rc0`、`0.0.9.rc1`
- 正式版后的修订：`0.0.9.post0`、`0.0.9.post2`

Git 标签可以带一个 `v` 前缀，也可以不带，例如 `v0.0.9.post2` 和 `0.0.9.post2`。应用界面和资产文件名使用不带 `v` 的公开版本。历史的 `v0.0.8-rc`、`v0.0.8-rc1` 等标签继续兼容读取，不重命名或覆盖；新发布不再使用连字符候选版命名。

顺序是先比较 `major`、`minor`、`patch`，再比较同一基准的 `rcN < 正式版 < postN`；`N` 也按数值比较。因此 `rc10 > rc2`，`0.0.9.post2 > 0.0.9`，但 `0.0.9.post2 < 0.0.10.rc0`。

## 准备文件

先预览维护者选择的版本，例如：

```sh
node scripts/set-release-version.mjs 0.0.9.post2 --dry-run
```

确认后运行同一命令并去掉 `--dry-run`，检查、测试并提交生成的版本文件。工具同步 `package.json.releaseVersion`、`package.json.version`、Tauri、Cargo、Cargo.lock 和原生安装包版本。`UPDATE.md` 的新章节使用公开格式，例如 `## 0.0.9.post2`。

标签与清单的本地校验：

```sh
node scripts/check-release-version.mjs 0.0.9.post2
node scripts/check-release-version.mjs v0.0.9.post2
```

发布工作流还会检查标签提交属于 `main`。版本准备和校验均不会执行发布。

## 原生版本与公开版本

`.rcN`、`.postN` 不是 SemVer，所以原生清单与公开名称分开保存：

| 公开版本      | Cargo / Tauri / updater 的 SemVer |
| ------------- | --------------------------------- |
| `0.0.9.rc1`   | `0.0.9-rc.1`                      |
| `0.0.9`       | `0.0.9`                           |
| `0.0.9.post2` | `0.0.10-0.post.2`                 |

post 使用下一 patch 的低优先级预发布空间，因此它高于原正式版，又低于下一 patch 的候选版。不能改成 `0.0.9-post.2`（它低于正式版）或 `0.0.9+post.2`（构建元数据不参与 SemVer 排序）。

updater JSON 的 `version` 写原生 SemVer，`release_version` 写公开名称。不要再同时写 `name`，因为 Tauri 将它作为 `version` 的别名，会报告重复字段。RC 走预览通道；正式版和 post 走稳定通道，预览用户也能升级到后续正式版。

Android `versionName` 使用公开名称，`versionCode` 使用含阶段的整数。默认布局支持基准数字 `0–99` 和 rc/post 计数 `0–498`；超出时需要显式指定 `BAAS_ANDROID_VERSION_CODE`。同一公开版本重新构建应保留同一码，后续发布必须递增。

Windows NSIS 将公开名称写到版本展示字段，将原生 SemVer 单独写到 `BAASInternalVersion` 注册表字段用于升级比较。读取老安装时回退原有 `DisplayVersion`。四段数字版本使用 `base.phase`，其中 rc 为计数、正式为 500、post 为 501 加计数；默认计数上限为 498，超过容量时设置递增的 `BAAS_WINDOWS_BUNDLE_VERSION`。

macOS 的短版本保留三个数字的基准版本；构建号将有序整数转换成三个数字段，满足 4/2/2 位的保守范围，完整公开名称另存 `BAASReleaseVersion`。容量不足时设置 `BAAS_MAC_BUNDLE_VERSION`，格式为 `1–9999.0–99.0–99`。原生构建号在同一发布序列中必须递增。Apple 要求这些键使用数字格式：[CFBundleVersion](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleversion)、[CFBundleShortVersionString](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleshortversionstring)。

## 发布渠道

RC 不成为 GitHub/Docker 的稳定 latest；post 可以成为稳定 latest。任何 `major = 0` 的版本（包括正式、RC 和 post）都跳过 Winget；`major >= 1` 的正式版和 post 才进入 Winget。
