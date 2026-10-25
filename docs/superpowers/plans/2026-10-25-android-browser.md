# Android Browser Implementation Plan

**Goal:** 修复安卓浏览器显示、覆盖面板和自动答题的标签通信。

**Architecture:** 原生浏览器固定视口；透明 React 工具层按 DOM 边界转发触摸。独立安卓事件适配器连接现有自动答题流程。

**Tech Stack:** Capacitor 8、Kotlin、React 18、TypeScript、Vitest、Android WebView。

- [x] 新增 `tests/android-browser.test.ts`，复现标签命令未响应、抓题结果未写入 store、答案载荷错误、下一题无法回传。运行 `npx vitest run tests/android-browser.test.ts` 确认失败。
- [x] 修改 `src/platform/nativeWebViewPlugin.ts`、`capacitorBridge.ts`；新增 `androidBrowser.ts` 实现命令、抓题与答案转换、取消及来源 URL 校验。
- [x] 修改 `NativeWebViewPlugin.kt`；新增触摸覆盖容器，保持透明工具 WebView 和固定浏览器区域，增加独立页面及异步执行；请求结果按 ID 管理。
- [x] 修改 `MobileApp.tsx`、`mobile.css`；底部固定 Tab、上滑覆盖磨砂面板、面板组件常驻、屏幕变化自动同步。
- [x] 检查 iframe 文档桥接、来源校验和下一题回传的代码及回归测试；模拟器验证独立标签页的跨页返回。真实账号页面见验收记录的范围说明。
- [x] 运行 `npm test`、`npm run android:build`，用模拟器验证本地竖屏夹具、面板切换和题目抓取/填入；按 `code-review` 检查代码及残留风险，记录验收与 APK 路径。
