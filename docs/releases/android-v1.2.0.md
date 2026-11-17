# Android v1.2.0 — 跟手玻璃与颗粒消散

- 长按工具 Tab 后拖动，玻璃胶囊跟随手指并在松手时选择工具；窄屏支持拖到边缘自动滚动。
- 点击 Tab 展开，再点当前 Tab 收起，删除独立收起按钮。点击面板外空白继续只收起并拦截该手势。
- 工具页切换和用户收起加入真实像素的灰化颗粒消散，支持快速中断、旋转清理和减少动态效果。
- 地址栏、浏览器标签、七个工具页、按钮、输入框、选择菜单和弹窗统一玻璃材质。保持原网页尺寸和未发送草稿。

安装包：`Xuexitong-Answer-Helper-android-v1.2.0.apk`，versionCode 3，Android Debug 签名，最低 Android 7.0 / API 24。

SHA256：`4029122863825c2dd3eddf18ea6cb40ec117a17ad137fa5cca26e344ad56be46`。

387 项测试、APK 构建和 Android Lint 通过。Android 10 / 15 模拟器覆盖真实触摸、横竖屏、320px、明暗主题、草稿、自动答题及长提示词加三图发送；网站流程使用本地夹具。详细记录见 `docs/qa/android-browser/liquid-glass-v120-verification.md`。
