# WISP / WISP RS

WISP 是 Windows 与 Android 学习辅助应用。WISP RS 使用 Rust、Tauri 和 WebView2 桌面宿主；Electron 与 Android 版本继续提供。应用内置浏览器，用于用户已登录并获授权访问的网页、题目整理、本地题库和学习参考答案。

## 下载

当前 [WISP RS 0.1.0 预览发布](https://github.com/XiYue-FireFly/Xuexitong-Answer-Helper/releases/tag/wisp-rs-v0.1.0) 提供：

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| Windows Rust | `WISP-RS-0.1.0-windows-x64-setup.exe` | 推荐常规包；复用系统 WebView2，缺少时联网安装 |
| Windows Rust 离线 | `WISP-RS-0.1.0-windows-x64-offline-setup.exe` | 内置完整 WebView2 运行时 |
| Windows Electron | `WISP-Windows-Preview-setup.exe` | WISP 名称、柳叶图标与浮动工具栏 |
| Android | `WISP-Android-Preview.apk` | WISP 名称、柳叶图标，当前使用 debug 测试签名 |

所有下载文件均附 SHA-256 校验值。Rust 版是独立预览，保留原 Electron 安装与数据；正式稳定版仍可在 [Releases](https://github.com/XiYue-FireFly/Xuexitong-Answer-Helper/releases) 选择。Rust 版需要 Windows x64 与 WebView2 140.0.3485.0 或更新版本，预览的正式更新通道尚未启用。

## 界面与功能

- 柳叶应用图标；Rust 版显示 WISP RS，Electron 与 Android 显示 WISP。
- 浏览器标签保留原题页面。工具面板覆盖网页，点击同一入口或面板外区域可收起。
- 浮动玻璃工具栏支持四边停靠、点按平滑切换、长按拖动；下滑或答题时收缩为“答题”按钮，点击可展开，回到页顶或答题完成后恢复。
- Android 常驻“答题、题库、设置”，其余入口位于设置；Windows 保留七个工具入口。
- 网页 AI 与 OpenAI 兼容 API、图片材料、本地题库、历史与用量记录。缺失答案耗尽重试后跳过，继续后续内容。

## 数据与迁移

Electron 内部名称与应用标识、Android 包名保持不变，显示名称变化不切换现有数据路径。Rust 预览使用独立身份 `com.studypilot.rust-preview`，不写入原 Electron profile。

Rust 设置中的“从 Electron 导入数据”接受完整迁移包：选择文件、校验后确认导入。开发者可使用 `scripts/export-electron-profile.mjs`，显式指定原数据库与 renderer 快照进行只读导出。迁移包可能包含敏感配置，请自行妥善保管。

网站 Cookie 与站点存储不跨浏览器引擎复制，Rust 版需重新登录。Rust 与 Electron 后续数据修改不会自动双向同步。

## 从源码构建

准备 Node.js 24，先运行：

```powershell
npm ci
npm test -- --maxWorkers=2
```

### Windows Rust

准备 Rust stable MSVC、Visual Studio 2022 Build Tools 的“使用 C++ 的桌面开发”及 Windows SDK。源码必须包含完整 Git 历史，以验证固定核心基线。

```powershell
# 常规安装包，缺少运行时时联网安装
./scripts/build-rust-installer.ps1

# 同时生成常规和完整离线安装包
./scripts/build-rust-installer.ps1 -RuntimeMode Both
```

输出位于 `release/rust/windows-preview/0.1.0/`。核心校验与 API 契约 JSON 是构建输入，不能删除；计划、进度、截图验收和临时诊断不随源码提交。

### Windows Electron

```powershell
npm run pack:win
```

### Android

准备 JDK 21 和 Android SDK，设置 `JAVA_HOME`、`ANDROID_HOME`，或在本地 `android/local.properties` 指定 `sdk.dir`。

```powershell
npm run android:build
```

APK 位于 `android/app/build/outputs/apk/debug/app-debug.apk`。正式签名发布需维护者另行配置签名。

## 使用范围

只在你拥有、运营或明确获得授权的页面中使用。应用不会自动最终提交作业或考试结果；AI 内容仅作为学习参考，请核对课程材料、题目上下文和平台规则。
