# 学习通答题辅助桌面工具

基于 Electron、React、TypeScript 和 Vite 构建的桌面应用。应用内置浏览器，用于在用户已登录、已授权访问的网页中抓取题目、维护本地题库，并通过用户配置的 OpenAI 兼容接口生成学习参考答案。

## 产品边界

本项目用于学习辅助、题目整理、题库复习和授权网页自动化操作。请只在你拥有、运营或明确获得授权的页面中使用。

应用不会自动提交作业或考试结果。AI 返回内容仅作为学习参考，请自行核对课程材料、题目上下文和平台规则。

## 本地隐私与数据存储

以下数据只保存在你的本机，不会写入代码仓库：

- AI API Key 和模型配置：保存在应用 localStorage 中。
- 本地题库：保存在应用 localStorage 的 `studypilot_question_bank_v1` 中。
- 答案历史和运行记录：保存在应用 localStorage 中。
- 网页登录态、Cookie、localStorage、IndexedDB：保存在 Electron WebView 的持久化分区 `persist:studypilot-sites` 中。

仓库提交时已通过 `.gitignore` 排除构建产物、依赖目录、诊断文件、截图和本地环境文件，避免把本地数据提交到 GitHub。

## 核心功能

- 内置浏览器：支持地址栏、前进后退、刷新、多标签页、登录态持久化。
- 题目抓取：从当前页面识别题干、题型、选项和页面定位信息。
- 本地题库：AI 解析成功后自动入库，再次遇到相同或高度相似题目时优先返回题库答案。
- 题库模糊匹配：先精确匹配，未命中时按题干相似度进行二次匹配，默认阈值为 80%。
- AI 配置：支持 DashScope、OpenAI 兼容接口和自定义兼容接口。
- AI 测试聊天：设置页可直接发送测试消息，验证 Base URL、模型和 API Key 是否可用。
- 自动化控制：自动化页集成抓题、页面扫描、生成计划、批准计划和执行已批准计划。
- 日志诊断：记录页面错误、请求结果、点击调试和保存/提交相关诊断信息。

## 题库查询逻辑

题库查询分两步：

1. 精确匹配：对题干和选项做标准化处理，去掉空格、常见标点和选项前缀后生成 key，完全一致则命中。
2. 模糊匹配：精确未命中时，对标准化后的题干计算相似度，相似度大于等于 80% 时命中。

为降低误命中风险，模糊匹配会忽略过短题干，并要求双方选项数量差异不能过大。

## 安装与运行

```bash
npm install
npm run electron
```

仅运行前端开发服务：

```bash
npm run dev
```

构建前端：

```bash
npm run build
```

构建 Electron 主进程和预加载脚本：

```bash
npm run electron:build
```

打包桌面应用：

```bash
npm run pack
```

## AI 配置

打开设置页，填写：

- 服务商名称
- Base URL，例如 `https://dashscope.aliyuncs.com/compatible-mode/v1`
- 模型名称，例如 `qwen-plus`
- API Key

填写后可以先使用“AI 测试聊天”发送一句测试消息，确认配置可用，再保存配置。

## 真实网页使用

真实 WebView 能力默认关闭。需要在设置页开启真实 WebView 后，才会对内置浏览器当前页面进行抓题、扫描和自动化操作。

登录态会保存在本机，关闭应用后再次打开仍可继续使用。如需清除扫码登录状态，可在设置页点击清除登录。

## 项目结构

```text
electron/                 Electron 主进程和 WebView preload
src/components/           React 页面和业务组件
src/store/appStore.ts     全局状态、题库、设置和历史记录
scripts/                  诊断和辅助脚本
```

## 技术栈

- Electron 31
- React 18
- TypeScript 5
- Vite 5
- lucide-react

## 免责声明

本项目仅用于学习辅助和授权页面自动化。使用者应遵守所在平台、学校、课程和网站的规则，自行承担使用行为产生的责任。
