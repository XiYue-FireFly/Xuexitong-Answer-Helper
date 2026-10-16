# Web 答题、题库展示与窗口优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 最小范围完成单选约束、自动收齐答案再填回、判断题展示、侧栏拖动与自动收展、启动最大化五项优化。

**Architecture:** 继续使用现有 WebAIController、Web 协议及题库数据模型。自动模式由逐批立即填回改为先收集与入库、补齐后统一填回；侧栏只订阅控制器状态，任务仍独立于面板生命周期。题库增加可选题型元数据，旧题库兼容推断，不批量迁移。

**Tech Stack:** React 18、TypeScript、Electron 31、Vitest；不新增依赖。

---

## 改动边界与现状证据

基线 `c7b713e release: v1.4.3`，开始时工作区干净。仅允许修改：

| 文件 | 职责和修改范围 |
| --- | --- |
| `src/webAI/protocol.ts` | 提示词逐题中文题型与答案数量约束；判断题兼容 JSON 布尔值 |
| `src/webAI/WebAIController.ts` | 自动入库、仅重发未录入题、全部收集后填回；通知侧栏状态 |
| `src/webAI/pageMonitor.ts` | 自动模式允许已结束且稳定的截断回答进入解析，避免永久等待；手动模式保留原规则 |
| `src/webAI/WebAIWorkflow.tsx` | 自动流程提示和判断答案预览显示 |
| `src/components/KnowledgeBase.tsx` | 判断题识别、中文答案与正确选项显示 |
| `src/components/knowledgeAnswer.ts`（新增） | 纯展示函数，统一判断值、题型推断和选项高亮，供组件及测试复用 |
| `src/App.tsx` | 侧栏状态订阅、双向拖动捕获和拖动遮罩 |
| `src/index.css` | 仅修改侧栏拖动手柄、拖动遮罩与拖动期间的规则 |
| `electron/main.ts` | 仅 createWindow 启动显示与最大化配置 |
| `tests/web-ai-protocol.test.ts`、`tests/web-ai.test.ts`、`tests/web-ai-controller.test.ts`、`tests/web-ai-monitor.test.ts` | 对应协议、稳定输出与控制器回归 |
| `tests/knowledge-answer.test.ts`（新增） | 判断题展示回归 |
| 本计划、`docs/analysis/2026-10-16-optimization-verification.md`（新增） | 计划、验收证据与实机限制 |

API 答题、浏览器发送适配、安装器、依赖、版本、教程和其他模块保持不变。修改前记录所有已跟踪文件哈希，结束时核对上述白名单外的文件逐字节一致。用户本轮已授权先计划再实施，无需另等确认，不提交或发布。

### 依据用户补充截图追加的最小范围（实施前记录）

- `src/store/appStore.ts`：仅为题库条目增加可选原始题型，入库和导入保留该字段；不改变题库匹配、答案优先级或 API 答题流程。证据：原 `QuestionBankEntry` 不含 type，导致判断题被展示为单选题。
- `electron/preload-webview/question-extractor.ts`：仅修正题型推断优先级，明确的 qtype/题型标题优先于通用选项标记，判断标题不再依赖存在两个原生 radio。证据：原 DOM 推断遗漏“判断题”标题、通用多选 marker 优先于明确单选 qtype。
- `electron/preload-webview/answer-applier.ts`：仅修正单选选项身份匹配和选中标记落点，避免内容包含关系同时匹配另一选项，以及整行被加上字母圆圈样式；保留填空和其他答题逻辑。
- `electron/preload-webview/page-bridge.ts`：仅在重现证明必要时修正选择题同步调用，禁止单选调用多选钩子。原桥无视题型优先调用 addMultipleChoice。
- 对应 `tests/appstore.test.ts`、`tests/question-extractor.test.ts`、`tests/answer-applier.test.ts`（新增）、`tests/page-bridge.test.ts`（新增）和 `tests/helpers/answer-dom.ts`（新增的最小 DOM 用例辅助）。
- 新题库优先使用原题型；旧题库按明确题型文字和严格“对/错”成对选项兼容分类，不因 AI 返回多答案将明确单选改为多选。逐题提示词继续包含真实题型与唯一答案约束。

## Task 1：单选提示约束与判断数据

- [x] 扩展协议测试：单选数据必须明确“单选题”、`choiceLabels` 与 `matchedOptions` 各一个；多选保留多答案；判断支持 JSON `true/false` 以及现有字符串。
- [x] 运行定向测试，确认新增断言因当前缺少逐题约束/不接受布尔值而失败。
- [x] 在每题数据中保留 `type`，加入 `typeName`、`answerRule`；单选规则为“仅返回唯一一个选项，choiceLabels 和 matchedOptions 数组长度必须都是 1，不得返回多个候选答案”。其他类型按真实题型指定，不将多选改为单选。
- [x] 判断题仅在 `type === 'judgement'` 时允许 `typeof row.answer === 'boolean'`，归一为现有存储字符串 `true/false`；多选或无效字母仍拒绝。
- [x] 同步字符预算计算和独立参考模板测试，保持完整提示词 300000 字符边界、整题分批和超限跳过行为。

## Task 2：自动入库与缺题补齐

- [x] 在控制器场景添加可控制逐次回答的钩子，测试首批缺题、格式错误、单选多答案、低置信度、补发失败重试和多批收齐前不填回。
- [x] 自动模式不再因置信度或 warnings 转人工确认；所有通过结构及原题选项校验的答案自动入库，保留其置信度和警告。手动步骤的确认按钮及行为保留。
- [x] 入库后按本批原题 hash 求差集：`missing = batch.questions.filter(q => !answers.some(a => a.question.hash === q.hash))`；已入库题不再发送。
- [x] 将缺失题排入未处理队列，生成新 requestId，重新编号并复用现有网站发送、TXT 与监测链路。未知/重复 ID 和非法单选不会错误录入；空回答也可触发补发。
- [x] 审查补充：自动监测允许相较发送前发生变化且稳定结束的坏 JSON 返回；仅按正确 requestId 及模板结构恢复截断前已完整闭合的回答行，再走原逐题严格校验。错误 ID、流式未结束及旧回答不能被录入。完整坏 JSON 无可用行时走同一有界缺题补发。消息标识和去尾空白正文双重排除旧回答重绘。
- [x] 同一题每次运行最多自动补发 3 轮，仍失败则保留有效答案并显示“重试失败步骤”；用户重试续接未完成队列，自动补发额度重新计数。避免无限发送，不重复入库或重答已完成批次。
- [x] 所有可发送题收齐并入库后才进入 `fill(completedItems)`；填回仍逐题核对原页面，保持不提交、暂停、停止、写入失败续接及进度/庆祝规则。超限题沿用跳过、最终 partial。
- [x] 定向运行控制器测试，更新旧的“低置信度阻挡”和“第一批已填回”断言以匹配本轮明确要求。

## Task 3：判断题展示

- [x] 新增纯展示测试：`true/false` 显示“正确/错误”；有或无选项均可见；选项顺序反转仍标记正确一项；普通选择/填空显示不变。
- [x] 新增 `knowledgeAnswer.ts`，只做展示归一：识别真假文字及布尔字符串，优先按明确题型提示与选项判断，布尔答案作为缺少元数据的判断题后备证据。
- [x] 题库卡片保留原题正文；判断题总是显示中文答案行，并按选项正文语义高亮，不拿 `true/false` 匹配 A/B。无选项时直接显示中文答案。Web 预览同样显示中文值。
- [x] 新增可选题型元数据并在导入/导出中保留；旧条目无需迁移，复制行为和题库匹配不变（按补充截图调整）。
- [x] 审查补充：显式单选/多选或已有选择字母时，不仅因答案正文是 true/false 就推断为判断题；严格成对的真假选项仍可作为旧条目判断证据，防止英文布尔选项被同时高亮。
- [x] 补充截图回归：题型标题/qtype 优先；单选按准确节点匹配，原生 radio 与字母值不同仍一致；圆圈样式只作用于标记；不重复调用切换选项的页面钩子。

## Task 4：侧栏双向拖动与自动收展

- [x] 保留现有宽度计算边界；拖动手柄全部放在侧栏内，避免被 `overflow: hidden` 裁掉外侧命中区域。
- [x] 拖动开始时使用 `setPointerCapture`，显示覆盖 WebView 的透明固定遮罩；处理 pointermove/up/cancel、lostpointercapture 和窗口失焦，结束或卸载时清理。拖动期间关闭宽度过渡，保证双向跟手。
- [x] App 通过 `useSyncExternalStore` 订阅 Web 控制器。自动任务开始/重试时收起；可重试失败、需要查看、暂停、部分完成时展开答题栏；正常扫描和逐批提取不强制反复展开。用户仍可自行开关。
- [x] 控制器长等待提醒显示 `visible: true`；自动提取正常完成不显示侧栏；异常、暂停则显示。保持手动流程的预览可见性。
- [ ] 组件级检查或可用的浏览器验证：向浏览器区拖宽，再反向缩窄；结束拖动后网页可操作；关闭面板后任务继续；失败后入口自动可见。

## Task 5：启动最大化与验收

- [x] 仅在 `createWindow` 设置 `show: false`，在 `ready-to-show` 中先 `maximize()` 再 `show()`，启动占满系统可用屏幕，保留任务栏及现有窗口控制；使用常规最大化，不启用会隐藏窗口控制的独占全屏模式。
- [x] 执行完整 Vitest、前端与 Electron TypeScript、可用的生产构建、`git diff --check`；246 项测试、两套类型检查、前端生产构建通过。Electron 预加载构建因 spawn EPERM 失败，审批服务 HTTP 503，未完成完整打包。
- [x] 使用 `requesting-code-review` 做独立只读审查，处理本轮相关问题；核对白名单外文件哈希。
- [x] 在验收记录中列出实际通过的检查以及未完成的 Electron/实站验证；不将模拟网页测试当作真实网站通过。

**剩余验收：** 真实侧栏双向拖动/自动收展、启动最大化和实站作答。Playwright 导航被审批服务 HTTP 503 阻挡；本地预览服务已停止。Electron 预加载构建完成前不应把现有运行中的 App 作为本轮修复的验收结果。

验证命令：`npm test`、`node node_modules/typescript/bin/tsc --noEmit`、`node node_modules/typescript/bin/tsc -p tsconfig.electron.json`、`npm run build`、`npm run electron:build`、`git diff --check`。若已有沙箱子进程限制，记录实际错误并按可用配置运行等价测试，不修改项目构建配置。
