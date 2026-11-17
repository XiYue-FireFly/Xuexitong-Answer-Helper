# Android 1.2.0 液态玻璃验证

## 结果与安装包

版本 `1.2.0`，versionCode `3`；包名 `com.studypilot.android`，minSdk 24、targetSdk 36。交付 `release/android/Xuexitong-Answer-Helper-android-v1.2.0.apk`，仍为 Android Debug 签名，可覆盖同签名测试包。

SHA256：`4029122863825c2dd3eddf18ea6cb40ec117a17ad137fa5cca26e344ad56be46`。

已从 API 35、API 29 模拟器拉取实际安装的 base.apk，SHA256 均与交付文件一致。旧 1.0.0、1.1.0 安装包保留。

## 本轮行为

- 底栏只保留七个工具 Tab。关闭时点击任意工具展开；展开时再次点击当前工具收起；点击其他工具切换内容。
- 按住 320ms 后拖动，胶囊位置、宽度和高光连续跟随手指；松手选择目标。320 CSS px 底栏支持边缘自动滚动，短划只滚动、不选择。旋转和取消手势清除拖动状态。
- 用户收起时从真实工具截图依次散开像素，灰化、飘移并消失；切换工具时旧内容消散、新内容保留。截图仅短暂保存在内存，不写入磁盘。捕获超时/不可用或减少动态效果时直接切换；自动答题回到原网页不等待颗粒动画。
- 地址栏、浏览器标签、七工具页卡片、按钮、输入框、选择器和弹窗使用公共玻璃材质。保留单层网页磨砂背景，减少 WebView 重复 blur 的局部绘制缺失。
- 点击面板外空白只关闭工具，原生层消费整次手势；拖动、长按、关闭期间松手均不会传入网页。工具一直挂载，保留输入草稿。

胶囊交互、公共玻璃材质和颗粒消散以 React/CSS/Canvas/Kotlin 实现；原生层提供有尺寸限制的工具区域截图，Canvas 根据真实像素执行灰化和消散。

## 复现与检查

- 旧 APK 新测试先失败：`8 !== 7`（仍有独立收起按钮）。此前空白收起测试也在旧 APK 失败。
- `npm test`：21 文件、387 项通过。
- `npm run android:build`：TypeScript、Vite、Kotlin 和 APK 清理构建通过。
- `android/gradlew.bat :app:lintDebug`：通过。保留现有依赖升级、资源和 JavaScript 启用提示，未扩大到依赖升级或网站脚本重构。
- `node scripts/check-android-glass.mjs`：API 35 / Android 15 和 API 29 / Android 10 使用真实 ADB 手势验证拖动、松手、外侧拦截、跨关闭手势、快速反向、草稿、模态弹窗、窄屏滚动及减少动态效果。Canvas 中间帧检查同时存在真实可见像素和消散透明区域。
- `node scripts/check-android-browser.mjs`：两个版本均验证横竖屏 IME、浏览器视口、原生 Enter、长提示词与三张图片、完整自动答题、本地跨域两层 iframe、子页跳转拒绝过期答案、标签页新建/关闭、320px 明暗和大字体/密度。

运行环境：`JAVA_HOME=D:/JetBrains/jdk-21.0.11`；`PLAYWRIGHT_MODULE_PATH=C:/Users/pyh20/AppData/Local/npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright-core`；分别设置 `ANDROID_SERIAL=emulator-5554` / `emulator-5556` 和 `ANDROID_QA_OUT=docs/qa/android-browser/liquid-glass-v120-api35` / `liquid-glass-v120-api29`。

截图、颗粒中间帧和 JSON 结果位于两个 QA 目录。模拟器夹具仅用本地 HTML，不包含真实账号。未验证真实登录后的学习通/AI 会话；本轮未新增密码专项适配。

## 自审

检查了原生 ACTION_DOWN 整次手势路由、关闭动画拦截期、惯性/指针取消、重入截图版本、后台/旋转清理、PixelCopy 位图释放、Canvas 动画释放、减少动态效果和自动答题切回原网页；修复了消散完成到 React 关闭提交之间的原面板闪回，以及多指事件错误结束当前拖动的问题。
