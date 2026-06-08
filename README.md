# 学习通答题辅助桌面工具

基于 Electron、React、TypeScript 和 Vite 构建的桌面应用。应用内置浏览器，用于在用户已登录、已授权访问的网页中抓取题目、维护本地题库，并通过用户配置的 OpenAI 兼容接口生成学习参考答案。

## 产品边界

本项目用于学习辅助、题目整理、题库复习和授权网页自动化操作。请只在你拥有、运营或明确获得授权的页面中使用。

应用不会自动提交作业或考试结果。AI 返回内容仅作为学习参考，请自行核对课程材料、题目上下文和平台规则。

## v1.1.2 更新

- 重构 WebView 预加载脚本，将浏览器导航、题目抓取、答案填入、保存同步、章节学习和考试流程拆分为独立模块。
- 保留原有自动化行为和页面兼容逻辑，降低后续修复抓题、填入、章节和考试问题时的维护风险。
- 精简 `electron/preload-webview.ts` 为入口注册文件，方便定位 IPC 事件和模块边界。
## 本地隐私与数据存储

以下数据只保存在你的本机，不会写入代码仓库：

- AI API Key 和模型配置：保存在应用 localStorage 中。
- 本地题库：保存在应用 localStorage 的 `studypilot_question_bank_v1` 中。
- 答案历史和运行记录：保存在应用 localStorage 中。
- 网页登录态、Cookie、localStorage、IndexedDB：保存在 Electron WebView 的持久化分区 `persist:studypilot-sites` 中。

仓库提交时已通过 `.gitignore` 排除构建产物、依赖目录、诊断文件、截图和本地环境文件，避免把本地数据提交到 GitHub。

## 核心功能

### 答题辅助
- 内置浏览器：支持地址栏、前进后退、刷新、多标签页、登录态持久化。
- 题目抓取：从当前页面识别题干、题型、选项和页面定位信息。
- 智能填入：支持单选、多选、判断题自动填入，修复判断题点击bug。
- 本地题库：AI 解析成功后自动入库，再次遇到相同或高度相似题目时优先返回题库答案。
- 题库导入导出：支持把本机题库导出为 JSON，也可以导入已有 JSON 题库。
- 手动加入答案：支持按固定文本格式批量加入选择题、判断题、填空题和问答题答案。
- 题库模糊匹配：先精确匹配，未命中时按题干相似度进行二次匹配，默认阈值为 80%。

### 章节学习自动化（新增）
- **视频/音频自动播放**：检测页面中的视频和音频，自动播放并支持倍速控制（0x-16x）
- **文档/PPT自动阅读**：自动翻页、滚动文档内容，点击"完成"按钮
- **任务点检测**：实时检测视频、文档、音频、作业、考试等任务点完成状态
- **智能章节切换**：所有任务完成后自动打开下一章节继续学习
- **章节题目处理**：可选择自动处理章节中的测验题目（实验性功能）
- **实时进度显示**：显示视频/音频播放进度、任务点完成情况

### AI 提供商配置
- 内置 22 个服务商预设：阿里云百炼/Qwen、DeepSeek、硅基流动、OpenRouter、Google Gemini、Kimi、智谱 GLM、火山方舟/豆包、腾讯混元、百度千帆、MiniMax、阶跃星辰、Groq、Mistral、Together、xAI/Grok、小米 MiMo、OpenAI、Ollama、LM Studio、vLLM/LocalAI 和自定义兼容接口。
- 支持 `Authorization: Bearer`、`api-key` 和本地服务“无需认证”三种认证方式。
- AI 测试聊天：设置页可直接发送测试消息，支持流式输出，用于验证 Base URL、模型和 API Key 是否可用。

### 其他功能
- 自动化控制：自动化页集成抓题、页面扫描、生成计划、批准计划和执行已批准计划。
- 日志诊断：记录页面错误、请求结果、点击调试和保存/提交相关诊断信息。
- 使用说明：应用内置公告横幅，提供详细的使用指南。

## 题库查询逻辑

题库查询分两步：

1. 精确匹配：对题干和选项做标准化处理，去掉空格、常见标点和选项前缀后生成 key，完全一致则命中。
2. 模糊匹配：精确未命中时，对标准化后的题干计算相似度，相似度大于等于 80% 时命中。

为降低误命中风险，模糊匹配会忽略过短题干，并要求双方选项数量差异不能过大。

## 本地题库导入导出

打开“本地题库”页面后，可以直接导出当前题库 JSON 文件，也可以导入此前导出的 JSON 题库。导入时会按题干和选项生成题库 key，相同题目会更新，不会重复堆叠。

本地题库只保存在本机，不会写入代码仓库。查询答案时会优先查本地题库，题库命中后不会调用 AI；只有题库未命中时，才需要使用已配置的 AI API Key。

## 手动加入答案格式

选择题、判断题可以使用题目、选项、答案的格式：

```text
题目：示例选择题题干
A. 选项一
B. 选项二
C. 选项三
D. 选项四
答案：A
解析：可选解析
```

多选题答案可以写成 `答案：A、C` 或 `答案：AC`。如果答案写完整选项文本，程序也会尝试和选项内容匹配。

填空题、问答题可以使用题目、答案的格式：

```text
题目：示例填空题题干
答案：填空答案
解析：可选解析
```

多个题目可以连续粘贴，程序会在上一题的答案/解析结束后自动识别下一题；也可以用空行、`---`、`====` 或 `###` 分隔。手动加入的答案会直接形成本地解析，适合在没有 API Key 或不想调用 AI 时使用。

## 安装与运行

```bash
npm install
npm run electron
```

## 下载 Windows 安装包

普通用户不需要克隆源码。打开 GitHub 仓库右侧的 Releases，下载最新版本里的 `Xuexitong-Answer-Helper-vx.x.x-win-x64-setup.exe`，双击安装即可。

安装程序使用 NSIS，支持开始菜单快捷方式和控制面板卸载。卸载时会删除应用本体，并清理本机应用缓存、运行日志、内置浏览器登录态和本地题库等数据。升级安装时不会清理这些数据，只有正式卸载才会清理。

项目维护者发布新版本时，先更新 `package.json` 里的 `version`，然后创建并推送版本标签：

```bash
git tag v1.0.0
git push origin v1.0.0
```

GitHub Actions 会自动在 Windows 环境构建安装包，并把 `.exe` 上传到对应 Release 附件中。

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

生成 Windows 发布安装包：

```bash
npm run release:win
```

该命令会先清理旧的 `release/` 目录，再重新构建前端、Electron 主进程和 NSIS 安装包，并校验安装包内是否包含 `dist/index.html`、前端资源和 Electron 预加载脚本，避免旧包残留或安装后白屏。

## AI 配置

应用支持多种 OpenAI 兼容接口，在设置页面可以通过下拉框选择服务商、Base URL 和模型。API Key 只保存在本机，不会写入仓库。

如果还没有 API Key，可以在设置页的 API Key 输入框右侧点击“没有秘钥，前往”。应用会弹出常用服务商的获取地址、复制链接按钮和简短教程，方便跳转到控制台创建密钥；Ollama、LM Studio、vLLM 等本地服务通常无需填写 API Key。

### 云端服务商

| 服务商 | 默认 Base URL | 默认模型 | 认证方式 |
| --- | --- | --- | --- |
| 阿里云百炼 / Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | Bearer |
| DeepSeek | `https://api.deepseek.com` | `deepseek-v4-flash` | Bearer |
| 硅基流动 SiliconFlow | `https://api.siliconflow.cn/v1` | `Qwen/Qwen3-8B` | Bearer |
| OpenRouter | `https://openrouter.ai/api/v1` | `openai/gpt-4o-mini` | Bearer |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.0-flash` | Bearer |
| 月之暗面 Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` | Bearer |
| 智谱 AI / GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` | Bearer |
| 火山方舟 / 豆包 | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-seed-1-6-flash-250615` | Bearer |
| 腾讯混元 | `https://api.hunyuan.cloud.tencent.com/v1` | `hunyuan-lite` | Bearer |
| 百度千帆 / 文心 | `https://qianfan.baidubce.com/v2` | `ernie-4.0-turbo-8k` | Bearer |
| MiniMax | `https://api.minimax.chat/v1` | `MiniMax-Text-01` | Bearer |
| 阶跃星辰 StepFun | `https://api.stepfun.com/v1` | `step-2-mini` | Bearer |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.1-8b-instant` | Bearer |
| Mistral AI | `https://api.mistral.ai/v1` | `mistral-small-latest` | Bearer |
| Together AI | `https://api.together.xyz/v1` | `meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo` | Bearer |
| xAI / Grok | `https://api.x.ai/v1` | `grok-3-mini` | Bearer |
| 小米 MiMo | `https://api.xiaomimimo.com/v1` | `mimo-v2.5-pro` | `api-key` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4.1-mini` | Bearer |

### 本地模型服务

| 服务商 | 默认 Base URL | 默认模型 | 说明 |
| --- | --- | --- | --- |
| Ollama | `http://127.0.0.1:11434/v1` | `qwen2.5:7b` | 无需 API Key，需要先启动 Ollama 并拉取模型 |
| LM Studio | `http://127.0.0.1:1234/v1` | `local-model` | 无需 API Key，需要开启 OpenAI Compatible Server |
| vLLM / LocalAI | `http://127.0.0.1:8000/v1` | `local-model` | 无需 API Key，按服务端模型名填写 |

### 配置步骤

1. 打开“设置”标签页。
2. 选择 AI 服务商、Base URL 和模型。
3. 云端服务填写 API Key；没有密钥时点击“没有秘钥，前往”查看获取地址并复制链接，本地服务可保持 API Key 为空。
4. 使用“AI 测试聊天”发送一句测试消息，确认配置可用。
5. 点击“保存 AI 配置”。

## 真实网页使用

真实 WebView 能力默认关闭。需要在设置页开启真实 WebView 后，才会对内置浏览器当前页面进行抓题、扫描和自动化操作。

登录态会保存在本机，关闭应用后再次打开仍可继续使用。如需清除扫码登录状态，可在设置页点击清除登录。

## 章节学习使用指南

章节学习功能可以自动完成学习通课程中的各类任务，包括视频观看、音频收听、文档阅读等。

### 使用步骤

1. **登录学习通**：在内置浏览器中登录超星学习通账号
2. **打开课程章节**：进入需要学习的课程章节页面
3. **打开章节学习标签**：点击右侧面板的"章节学习"标签
4. **配置自动化选项**：
   - ✅ 视频/音频结束后打开下一章节
   - ✅ 进入章节后自动播放视频/音频
   - ✅ 静音播放（推荐）
   - ✅ 播放速度：1.0x - 16.0x（推荐1.5x-2.0x）
   - ✅ 自动阅读文档/PPT
   - ✅ 自动处理章节题目（需配置AI，实验性功能）
5. **点击"开始学习"**：系统会自动完成所有任务

### 功能说明

- **视频/音频播放**：自动检测并播放页面中的所有视频和音频内容
- **文档阅读**：自动翻页、滚动，完成PPT和文档的阅读任务
- **任务点检测**：实时显示各类任务点的完成状态
- **智能切换**：当前章节所有任务完成后，自动打开下一章节
- **安全暂停**：随时可以点击"暂停媒体"或"停止辅助"中断自动化

### 注意事项

- 播放速度不要设置过快，建议不超过2.0x，避免被系统检测
- 开启"静音播放"可以避免打扰，不影响学习进度
- "自动处理章节题目"需要先配置AI提供商和API密钥
- 部分课程可能有特殊的防刷机制，请合理使用
- 建议在学习时保持应用在前台运行

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
