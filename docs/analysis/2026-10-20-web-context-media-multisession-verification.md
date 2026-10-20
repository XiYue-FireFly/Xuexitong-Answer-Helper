# Web 自动答题四项优化：改动与验证记录

日期：2026-10-20。分支：`codex/web-context-media-multisession`。版本：`1.4.4`。

## 结果与行为

用户最后澄清已落实：无需清空旧答案，自动流程对抓到的全部题目重新生成答案并填回；手动提取同样包含已填题，继续沿用手动确认步骤。本轮已校验的新答案优先作为后续批次参考，其次才使用页面旧填写。

1. 提示词附带同组章节、大题、公共材料、相邻题干，以及前序页面填写或本任务已校验答案，注明参考来源；不同实验分组不混用。包括已有填写在内的全部题目重新提取、作答和填回；旧填写只作参考，不据此跳题。
2. 独立发现题干、选项和材料图片，通过原题页面 Session 读取图片数据；blob/data 在原文档读取，必要时对已加载且通过身份校验的图片区域截图。附件与题号、文件名匹配，等待网站上传及发送回执。图片失败保留待处理题，继续有效题，并可从失败媒体步骤重试。
3. 应用仍运行时，题目页和 AI 页作为任务资源保留。普通切换页签、收起侧栏不终止任务；浏览其他地址保留原题页，在新标签浏览。无法保留原文档时继续收集答案，等待原题页身份恢复后填入。不会向当前其他页面填入，也不会自动提交。
4. 每个题页有独立控制器、题目、答案、配置、进度和取消状态；回包核对 sessionId、operationId、tabId、documentId。不同 AI 网站可并行；同一网站的发送与收集排队，防止共享登录恢复同一服务端会话而串答。

## 具体改动位置

以下行号对应本次记录时的源码，后续编辑可能使行号移动。

| 文件与入口 | 改动内容与边界 |
| --- | --- |
| `electron/preload-webview/question-reference.ts:38` `readFilledValues`；`:91` `questionReferenceScope`；`:111` `buildWebReference`；`:159` `collectQuestionMedia`；`:191` `webEnhancedQuestionHash`（新增） | 局部读取可见填写、静态材料和图像，排除认证字段、隐藏字段及答案区图像；题目静态身份不包含动态填写与上传状态。 |
| `electron/preload-webview/question-extractor.ts:702` `extractQuestions`；`:761` `enhancedOptionTargets`；`:796` `enhancedQuestionFromRoot`；`:823` `extractWebEnhancedQuestions`；`:860` `applyFontDecode` | 增加默认关闭的 Web 增强抓取，支持纯图题、图片选项及独立填空容器；原 API 默认提取路径保留。 |
| `electron/preload-webview/types.ts:29` `WebReference`、`QuestionMedia`；`src/store/appStore.ts:52` `QuestionItem` | 增加可选参考和媒体字段，兼容旧题目与旧请求。 |
| `src/webAI/questionContext.ts:14` `buildWebReferences`；`:46` `toWebBankQuestion`（新增） | 按材料分组提供邻题和前序答案，限制可选参考长度；入库剥离动态填写，保留静态上下文以区分同名题。 |
| `src/webAI/protocol.ts:29` `prepareWebBatch`；`:112` `prettyPromptQuestion`；`:130` `buildWebPrompt` | 将上下文和图片映射加入实际序列化文本；保持总提示词 300000 字符、整题分批、单选唯一答案和不切碎题干的约束；图片每批最多 8 张。 |
| `src/webAI/questionMedia.ts:7` `mediaFileName`；`:18` `prepareQuestionMedia`；`:52` `releaseQuestionMedia`（新增） | 文件扩展名与真实 MIME 对应；任务内缓存、单图 8 MiB、总量 32 MiB、取消与失败保留；当前按序读取图像。 |
| `electron/web-ai-task-resources.ts:130` `createWebAITaskResourceManager`；`:181` `lease`；`:237` `boundedResponse`；`:256` `read`（新增） | 校验主窗口及其 WebView 所有权、原文档和局部图片元素；带来源 Session 读取、限时和限量、局部截图降级；引用计数保留任务页面并恢复后台节流设置。 |
| `electron/main.ts:1549`；`electron/preload.ts:86` | 仅注册和暴露任务资源、媒体读取 IPC；不改变窗口启动、安装升级或登录存储实现。 |
| `src/webAI/browserBridge.ts:16` `webActionScript`；`:38` `webPageAction`；`src/webAI/sendPrompt.ts` `sendWebPrompt` | 图像字节只在 prepare 上传传入，不随轮询重复传输；检测本批图片与 TXT 混合附件、上传状态和消息回执，保持完整文本一次发送及不确定发送不盲目重发。 |
| `src/webAI/useBrowserBridge.ts:11` `useBrowserBridge` | 将浏览器命令绑定任务页面；普通后台处理不切换前台，原生 Enter 使用短队列并保护用户当前选择。 |
| `src/webAI/WebAIController.ts:198` `saveBatch`；`:204` `prepare`；`:223` `extract`；`:299` `sendAndRead`；`:430` `fill`；`:498` `startAutomatic` | 按任务分离草稿、上下文、媒体和活动；全部题目重新作答；填入前核对原题身份、等待原页恢复；失败重试仅对本轮已成功填入题去重。 |
| `src/webAI/WebAISessionManager.ts:13` `WebAISessionManager`（新增） | 每题页独立状态和配置快照、引用计数运行锁、每网站会话队列、暂停停止隔离、当前页面归属选择。 |
| `src/webAI/pageRequests.ts:5` `WebPageRequestRegistry`；`:59` `applyWebAnswers`（新增） | 关联回包、超时取消、旧文档隔离、每目标页填入串行；连续填空校验失败仍沿用一次重试和明确跳过语义。 |
| `electron/preload-webview.ts:88` 文档身份；`:99` `webReply`；`:102` 抓题 handler；`:121` 填入 handler | 新 Web 请求回传身份信封；页面侧保持写入队列直到底层写入真正结束，丢弃过期和取消操作；旧 API 请求保留兼容分支，未改填入器算法。 |
| `src/components/BrowserPanel.tsx:336` 文档事件；`:459` 任务选择；`:573` IPC 路由；`:735` 抓题；`:801` 填入；`:1002` 导航；`:1039` 关闭页签 | 只在 Web 任务分支采用按页请求和资源保护；运行中的源页及 opener 不误关闭，关闭对应任务页需确认；非任务标签保留原行为。 |
| `src/webAI/WebAIWorkflow.tsx:12` `WebQuestionCount`；`:41` `WebAIWorkflow`；`src/webAI/web-ai.css` | 按题页选择任务、显示对应题量、失败步骤和全部重答说明；沿用已有界面样式。 |
| `src/App.tsx:48`；`src/components/AIPanel.tsx:723`；`src/answerActivity/AnswerActivityLayer.tsx:168` | 仅更换 Web 任务订阅与题量展示接入；面板退订不停止后台任务，提示音与庆祝保持任务归属。API 答题循环未修改。 |
| `tests/question-extractor.test.ts`、`tests/web-ai-controller.test.ts`、`tests/web-ai-login.test.ts` | 扩展原测试，覆盖增强抓取、已有填写全部重答、媒体等待、恢复和混合附件。 |
| `tests/question-context.test.ts`、`tests/question-reference.test.ts`、`tests/web-ai-media.test.ts`、`tests/web-ai-page-requests.test.ts`、`tests/web-ai-sessions.test.ts`、`tests/web-ai-task-resources.test.ts`（新增） | 覆盖参考隔离、字符边界、媒体校验和预算、回包错序、取消与页面恢复、独立任务和资源释放。 |

## 本轮重新执行的验证

| 验证 | 实际结果 |
| --- | --- |
| `npm.cmd test` | 混合题型补抓与文字题型图片边界修复后再次执行，20 个测试文件，330 项测试通过，退出码 0。 |
| `tsc --noEmit` | 通过，退出码 0。 |
| `tsc -p tsconfig.electron.json --noEmit` | 通过，退出码 0。 |
| `npm.cmd run build` | 通过，生成前端生产产物，退出码 0。 |
| `npm.cmd run electron:build` | 通过，生成 Electron 和真实 preload 产物，退出码 0。 |
| `git diff --check` | 通过。Git 对部分原文件给出 LF/CRLF 提示，无空白错误。 |
| SHA256 基线对照 | 原 100 个已跟踪文件中 20 个相关文件改变，80 个逐字节未变；无白名单外原文件改变、无原文件缺失。 |
| 本地真实 Electron 31.7.7 WebView | 6 组检查通过：两个混合页面各提取 6 题，涵盖单选、多选、判断、填空、问答且身份隔离；普通题和独立填空题图片由真实 Session 读取；隐藏页面仍可抓题；两页并发写入准确且没有提交；GET 导航转新页并保留源题页。 |

本地真实 Electron 最新记录：`本地验证目录/web-mixed-types-smoke-result.json`，本轮时间 `2026-10-20T10:38:45.653Z`。该验证使用本地模拟题页与实际 preload/WebView，不使用用户线上作业。

无新增依赖，`package.json` 和 `package-lock.json` 均与基线相同。构建现有 Vite CJS 弃用提示及 npm allow-scripts 配置提示仍存在，不影响本次构建。

## 改动范围与审查

与实施前基线比对，改动集中于 20 个相关原文件，另增加 6 个实现文件、6 个测试文件及本次方案/验证文档。`answer-applier.ts`、答案匹配器、API 请求与自动作答循环、安装升级脚本、登录存储、教程、版本和依赖文件均未改变。共享文件只包含上表列出的 Web 接入点和兼容分支。

复审先核对 diff，再检查身份、重试去重、媒体权限与配额、输入参数校验、取消和多任务状态。未发现本次新增的阻塞性问题；未引入第三方库。上下文构造目前包含同组遍历，最坏为 O(n²)，参考条数和提示词长度有界，但极大量题目可能需要后续性能评估；未为此扩大本次重构范围。

## 验收边界与未完成的线上检查

已有填写回归先观察到五项失败，移除筛选和填入跳过后通过；前序题同时有旧填写与新答案的回归也先失败，再修复为新答案优先。独立复审批准，未发现阻塞问题。

新主进程、前端与 preload 已构建；未关闭用户原应用进程。完全退出并从当前开发目录重新启动 App，才会加载本次全部修改；旧安装包仍是旧代码。

- DeepSeek、豆包、千问真实站点的图片上传、发送回执与视觉理解未完成现场验收；本地测试通过不能证明所有在线 DOM 与账号环境都兼容。
- 网站若拒绝程序上传、只接受原生文件选择、当前模式不支持看图或未返回可识别的附件回执，会明确保留待处理题并允许重试，不把缺图推测当作完成。
- 同网站发送和收集排队；不同网站可并行。这不突破站点自身的会话和频率限制。
- 后台继续的范围是应用仍运行；不承诺退出应用、系统休眠后继续。原题 SPA/强制跳转无法保留 DOM 时，保留答案并等待原页恢复，不向其他页误填。
- 单图超过 8 MiB、任务媒体超过 32 MiB、单题超过 8 张图均进入明确待处理状态；当前不自动压缩转码。
- 题干、选项与上下文的实际序列化文本总上限仍为 300000 字符；无法容纳的整题明确跳过，不截断题干，也不自动提交。
- 本轮没有执行打包安装、提交、推送或 GitHub Release 发布。

## 补充修复：整份作业混合题型漏抓

用户要求包括已填写在内的整份作业全部题目，不能只提取填空题。本次继续修改的实现仅为 `electron/preload-webview/question-extractor.ts:823` 的 Web 增强抓取和 `electron/web-ai-task-resources.ts:31` 的对应图片归属检查；测试仅扩展 `tests/question-extractor.test.ts`、`tests/web-ai-task-resources.test.ts`。其余既有改动保持。

- 抓题不再因发现 `.singleQuestionDiv` 就提前只返回一题；合并同页标准题块、局部 `qtype`、隐藏 `type` 元数据及选择控件等候选，按页面顺序返回，支持单选、多选、判断、填空和问答。
- 旧页面的 `.TiMu` 纯题干不替代拥有答案控件的完整父题块；选项内部的 `.content`/`.title` 不恢复为伪题；聚合题组和 `.content` 包装器不吞并多道具体题目。局部恢复不提升到整页，不采集导航控件。
- 图片读取的局部根识别同步支持全部上述题型，以及仅带中文题型标题或隐藏 `typeName` 字段、没有数字题型元数据的文字编辑器题块；保留局部标题和最多 5 层界限，以及原文档身份、元素、地址和大小校验，不扩大到任意页面元素。
- 新增 8 个混合抓题回归及不同题型的图片作用域回归，均先观察失败后修复。其中聚合 `.content` 包裹多道仅带隐藏 `type` 的题目，先复现只返回 1 题，修复后分别返回两题。
- 最终专项 49/49，全量 330/330，前端与 Electron 构建通过；实际 bundled preload 在两页真实 WebView 中各提取全部 6 题，保留选项、判断类型及已有填空答案。已有答案仍全部重新提取、重新作答，不据此跳题，不自动提交。文字题型标题和隐藏 `typeName` 图片回归先 2 项失败，补齐校验后通过；独立只读复审最终批准，无剩余阻塞问题。

2026-10-20 18:32（本地时间）重新核对 SHA256：仍仅原白名单 20 个已跟踪文件改变，80 个文件逐字节不变，没有新增白名单外原文件改动。用户当前线上作业页面未实际验证；以上夹具验证不替代线上验收。需要完全退出旧进程并从开发目录重启才能加载新 preload。

## 后续截图缺陷修复记录

用户随后报告长答案截断与工具栏文字误入题库；本轮补充修复了 `answer-applier.ts` 的文字答案分支（新增 8 行）及 Web 增强抓题/参考的编辑器 UI 排除，并补充 12 项回归。上文“填入器未修改”与 20 个原文件范围统计记录的是该截图报告之前的阶段。最新全量 342/342，构建与本地 37 题两轮实际控制器/WebView/题库流水线通过。最新范围、具体函数和线上验收限制见 `2026-10-20-web-answer-integrity-fix.md`，此前其他实现保持不变。
