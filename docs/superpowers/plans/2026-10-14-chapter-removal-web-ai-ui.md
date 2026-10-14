# 章节学习移除、教程与网页 AI 优化执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan, subject to the user's execution authorization and applicable delegation restrictions. Steps use checkbox syntax for tracking.

**Goal:** 完成章节专用代码移除；新增右侧使用教程；按现有风格美化网页 AI 按钮与答题进度；将网页 AI 提示词改为总长不超过 300000 字符的整题分批，取消 50 题上限。

**Architecture:** 保留 Electron / React / WebView 的现有边界。章节删除遵循专用调用链；教程新增纯展示组件并最小接入 App；网页 AI 只调整协议分批函数及工作流的批次状态/文案/按钮样式；进度只改专用 CSS，保留所有进度计算与填入流程。

**Tech Stack:** Electron 31、React 18、TypeScript 5.5、Vite 5、Vitest 4、esbuild、现有 CSS 变量与 lucide-react。

**状态：仅计划，未执行。** 用户本轮明确要求不修改项目运行代码。本文所有待办和命令均属于后续执行阶段；HTML 参考稿是独立设计产物，不接入应用。

分析依据：docs/analysis/2026-10-14-project-analysis.md。行号为 2026-10-14 当前工作区定位辅助，执行以符号名为准。

## 0. 已确认的需求解释

- 总提示词上限 **300000**，不是 30000；当前常量已经是 300000，应保留。
- 不以 50 或其他题数作为硬上限；一批可以包含超过 50 道短题。
- 完整计算发送文本，包括指令模板、requestId、q ID、题干、上下文、选项、JSON 缩进/转义及分隔符。
- 沿用现有 string.length 计数方式。恰好 300000 可发送，300001 不可发送。
- 累计超限的整题不放当前批；若独立可容纳，排到下一批。单题连必要模板仍超限，跳过其本次发送内容并提示，不截断，不删除原题/题库。
- 用户对“其他功能不得修改”的要求适用于所有未被本次需求明确覆盖的功能；共享文件只允许必要局部改动。
- 视觉方向以独立参考稿 A“克制玻璃”为默认实施建议；选 B 时仅调整批准的局部视觉参数，不更改结构与业务。选择设计方向不等于授权本轮开始实施。

## 1. 范围清单与保护规则

| 允许变动的路径 | 允许的具体变化 | 其余内容 |
| --- | --- | --- |
| scripts/build-webview-preload.mjs | 去除已删章节 userscript 的复制及专属目录创建/import | 保留 esbuild bundle 配置 |
| src/components/BrowserPanel.tsx | 删除章节专用辅助链和事件 useEffect | 进度计算、WebView、导航、抓题、填入、下一题、队列与事件合同原样保留 |
| src/components/AIPanel.tsx | 删除无生产者的章节答题专用监听 useEffect | API 查询、重试、并发、暂停、逐题、填入及 UI 原样保留 |
| src/webAI/protocol.ts | 按字符整题分批、跳过原因、共享的精确序列化辅助 | 答案协议与校验、同题比较、选项语义保持 |
| src/webAI/WebAIWorkflow.tsx | 新分批结果消费、真实批次文案、跳过提示、按钮类、删 learning 数组值 | 开站、发送确认、导入、批准填入、停止和安全检查原样保留 |
| src/webAI/web-ai.css | 网页 AI 内嵌、弹窗、任务条按钮视觉及状态 | 不影响 API/题库/设置等全局按钮 |
| src/index.css | browser-solving-dock 专用流光与状态/浅色/reduced-motion | 其余主题、布局、题库与 jelly 代码原样保留 |
| src/App.tsx | 新增教程 import、TabId、tabs 元素和渲染分支 | 现有导航顺序、窗口、主题、日志、公告、拖宽、收起逻辑保持 |
| src/components/TutorialPanel.tsx（新） | 教程文本、目录、折叠和示例 | 纯展示，不调用自动化事件和写设置 |
| src/components/tutorial.css（新） | tutorial-panel 作用域样式 | 不定义全局 button、h1、details 等 |
| tests/web-ai.test.ts | 替换固定 50 题测试，新增真实字符预算行为测试 | 其余协议测试全部保留 |
| README.md | 更新现行功能/指南中的章节内容，加入教程入口和分批规则 | 历史更新记录及无关说明保留 |

已删除的三个章节文件保持删除。electron/main.ts、preload-webview.ts、types.ts、page-bridge.ts、appStore.ts 的现有章节删除作为基线复核；没有新的确切运行引用证据就不追加改动。

默认禁止修改：KnowledgeBase、SettingsPanel、TokenUsagePanel、HistoryPanel、BugReportPanel、AnnouncementBanner、aiRequest、browserBridge、useBrowserBridge、sendPrompt、font-decode、chaoxing-chapter-api、question-extractor、answer-applier、answer-matcher、submit-sync、navigation、interaction、snapshot 等业务模块及其测试。SettingsPanel 的旧章节注释可保留，避免为注释触碰保护模块。

不重命名仍共享的 chaoxing-chapter-api.ts；不卸载未引用依赖；不全仓格式化；不升级版本/依赖；不改历史 Release 和旧设计稿；不提交、推送或发布安装包。测试若暴露无关错误，单列报告，不能借本计划扩大修改范围。

## Task 1：固定基线和验收范围

**读取：** 工作区 git status / diff、当前源码、现存测试、分析报告。**输出：** 执行阶段基线记录及保护文件清单（不包含密钥/用户题库内容）。

- [ ] 记录当前 11 个已有变更路径的差异与 SHA-256。存在 3 个已删除章节文件，不能 checkout/reset 恢复它们。
- [ ] 对所有现存运行文件记录哈希；对白名单共享文件额外保留原文或可比较 diff，以区分原有改动和本轮增量。
- [ ] 阅读分析报告的删除依赖链，确认现有引用没有因用户新改动发生变化。以本次执行开始时工作区为基线，不直接以 HEAD 当用户原始代码。
- [ ] 在依赖不存在时执行 npm ci；避免自动升级依赖或修改 lockfile。记录基线 npm test / npm run build / npm run electron:build 的结果，已知残留失败与新增失败分别记录。
- [ ] 用只读搜索确认章节残留、事件生产者与字体解码链：

```powershell
rg -n 'chapter-learning|ChapterLearning|answer-all-and-apply|isSameChapterNavigation|chapterNavigationIdentity|comparableNavigationUrl' src electron scripts
rg -n 'readTtfList|cxReadTtfList|syncCompletion|syncJudgement|syncChoice' electron
rg -n 'WEB_AI_BATCH_SIZE|WEB_AI_PROMPT_LIMIT|每批最多|30000|300000' src tests
```

**验收：** 保护清单与允许改动列表明确；已有工作被完整记录；不将项目历史记录中的章节字样认定为运行引用。

## Task 2：闭合章节专用代码删除

**修改：** scripts/build-webview-preload.mjs、BrowserPanel.tsx、AIPanel.tsx、WebAIWorkflow.tsx、README.md 的定点片段。

- [ ] build-webview-preload.mjs：删除最后的 userscript copyFile；删除 copyFile import；删除 dist-electron/preload-webview 子目录的专用 mkdir。保留 dist-electron 根目录 mkdir 和所有 esbuild 参数。
- [ ] BrowserPanel：删除 comparableNavigationUrl → chapterNavigationIdentity → isSameChapterNavigation 的无调用辅助链（现 :260–290 附近）。删除监听 studypilot:chapter-learning-action、发送 studypilot:chapter-learning 并设置 learning 状态的完整 useEffect（现 :1005 附近）。
- [ ] AIPanel：确认 studypilot:answer-all-and-apply 除专用监听外无生产者后，删除对应 useEffect（现 :713–760 附近）。不要删除它调用过的通用答题、队列或重试函数。
- [ ] WebAIWorkflow.beginAction：只从忙碌状态数组去掉 learning，不改变 calling_ai / executing / busy / batchRunning / liveRunning 的判断。
- [ ] README 删除“当前核心功能”中的章节学习模块和“章节学习使用指南”。保留 v1.1.2 这样的真实历史描述，不将过去已经发布的事实抹去。
- [ ] 复核原有三个章节文件删除、主进程章节 IPC、preload 章节处理、store 章节类型/方法删除已闭合；不存在则不额外改文件。
- [ ] 保留 readTtfList、cxReadTtfList、syncChoice / syncJudgement / syncCompletion 以及全部字体/答案同步调用。
- [ ] 再次运行上述章节搜索。目标运行目录不存在章节动作、媒体/任务遍历入口、专用 UI/import/复制路径；保留共享文件名及说明注释可列入明确例外。
- [ ] npm test、npm run build、npm run electron:build。构建产物中不得重新复制 userscript。

**验收：** 无悬空事件/导入/构建文件复制，无 learning 类型错误；共享字体映射和答题同步链仍完整。不为可逆删除专门添加复刻静态搜索的测试文件，使用现有测试、构建和人工冒烟验证。

## Task 3：实现精确字符预算整题分批

**修改：** src/webAI/protocol.ts、tests/web-ai.test.ts。**保持：** WebBatch 的 requestId / questions / provider 结构和所有答案导入协议。

### 接口与行为

删除 WEB_AI_BATCH_SIZE（确认所有当前调用/测试已迁移），保留 WEB_AI_PROMPT_LIMIT = 300000。prepareWebBatch 接收参数不变，扩展返回结果：

```ts
type SkippedWebQuestion = {
  questionHash: string;
  questionIndex: number; // 原题 index，缺失时使用输入顺序
  promptLength: number; // 单题完整提示词长度
  reason: 'single-question-over-limit';
};
type PreparedWebBatch = {
  batch: WebBatch | null;
  prompt: string;
  remaining: QuestionItem[];
  skipped: SkippedWebQuestion[];
};
```

无输入继续抛出现有“请先抓题并选择题目”。有输入但全部跳过返回 batch=null、prompt=''、remaining=[] 和跳过清单，不生成空 batch。返回与输入题目数据不可共享可变状态，最终 batch 使用现有 structuredClone 语义。

### 精确长度实现

- [ ] 先写行为测试使其因旧 50 题逻辑失败：例如 80 道短题可同批，按实际模板构造 300000/300001 边界。不要只断言常量值。
- [ ] 将 buildWebPrompt 的题目投影与模板渲染抽为同文件私有辅助。保留原模板的全部指令、措辞和 JSON 格式，特别是 ##、段落、返回结构、题数说明和选项正文要求。
- [ ] 共用的序列化只投影现有字段：id、type、question、context、optionPairs(question)，不能漏 context 或用题干长度代替。
- [ ] 使用精确序列化后的行片段累计长度，避免每加入一题就 structuredClone / stringify 整个累计 batch。请求 ID 一次生成并固定用于本批测量与输出。

具体方案：对题目对象执行 JSON.stringify(row, null, 2)，给每行加 4 个空格，得到与现有 pretty JSON 完全一致的数组元素片段。共用 JSON 前缀/后缀和 promptPreamble(count)；对 n>0：

```text
jsonPrefix = '{\n  "requestId": ' + JSON.stringify(requestId)
             + ',\n  "questions": [\n'
jsonSuffix = '\n  ]\n}'
jsonLength(n) = jsonPrefix.length + sum(rowParts.length)
                + 2 * (n - 1) + jsonSuffix.length  // 逗号 + 换行
promptLength(n) = promptPreamble(n).length + 2 + jsonLength(n)
```

promptPreamble(n) 为现有模板数组（不含最终 JSON）用两个换行连接；最后再用两个换行连接 JSON。所有长度来源于真正参与输出的文本，同一套 helper 用于 buildWebPrompt 与分批长度预算。n=0 保留 buildWebPrompt 原有空数组序列化兼容，但不将空 batch 用于发送。

- [ ] 用一份包含中文、引号、反斜杠、换行、emoji、阅读上下文、选项与两位/三位 q ID 的完整预期提示词验证新旧输出等价；保留已有格式测试，避免只测长度漏内容。
- [ ] 每题先判断单题 q1 的完整提示词是否超过上限；超过则登记 skipped 并继续扫描，不写入 batch 或 remaining。
- [ ] 对可独立容纳的题生成当前候选 q(n+1) 片段，计算候选完整长度。能容纳则接纳；会超限则从该题起保留完整剩余输入给下一批并结束本批。不得为塞满当前批而重排后题。
- [ ] 最终只克隆一次接纳题目，调用 buildWebPrompt 生成真正发送字符串，并以 validateWebPrompt 做最终边界检查；同时断言/测试累计长度和最终长度一致。

算法示意：

```text
为本批创建 requestId；accepted=[]；skipped=[]
按输入顺序访问题目 q：
  若完整单题 prompt(q, q1) 超限：记录跳过；继续后题
  否则若加入 accepted 后完整候选 prompt 超限：
    remaining = 从 q 开始的未消费原题；结束
  否则接纳 q（批内 ID 连续，不使用原序号作 q ID）
若扫描结束：remaining=[]
若 accepted 为空：返回空批结果和跳过信息
否则克隆 accepted，生成最终 prompt 并校验，返回
```

跳过统计只在扫描消费到该题时增加；尚未到达的超长题可在下一批消费时跳过。跨批最终必须覆盖每个选中题目：已发或待发或明确跳过，不允许静默丢题。若下一批只剩超长题，要消费完并结束，不停留在“下一批”循环。

### 必须验证的边界

- [ ] 80 道短题同批，81 题不再因固定题数拆批。
- [ ] 完整提示词恰好 300000 被接受；多 1 字符不接受当前题；下一批仍是完整题目。
- [ ] 单题 300001（含模板）位于首/中/尾均有跳过记录，后续可容纳题继续处理。
- [ ] 题干不长但 context 或 options 造成超限，同样正确分批/跳过。
- [ ] JSON 转义、中文、emoji、q9→q10、q99→q100、题数模板位数变化的长度一致。
- [ ] 空输入、全部超长、仅剩超长题、跨多批最终耗尽，结果无空发送/死循环。
- [ ] 原题对象、options、optionTargets 与输入数组未被修改；原题 hash 与顺序保留。
- [ ] 各批 requestId 不同，批内 q ID 连续，parseWebAnswer 仍按正确原题映射，既有答案协议测试通过。

**命令：** npm test -- tests/web-ai.test.ts tests/web-ai-protocol.test.ts。随后完整 npm test。

## Task 4：接入分批结果与提示

**修改：** src/webAI/WebAIWorkflow.tsx。**不改：** sendPrompt、browserBridge、useBrowserBridge、appStore。

- [ ] 移除 WEB_AI_BATCH_SIZE import 和 Math.ceil(items.length / WEB_AI_BATCH_SIZE)。position 使用当前批序号；显示“第 N 批 · 本批 X 题 · 待处理 Y 题”，不虚构预计总批数。
- [ ] 首次生成重置本轮跳过清单，下一批累积去重；展示题号、单题提示词长度和原因。提示“已从本次提示词跳过，原题保留”，不使用“删除题目”的文案。
- [ ] batch=null 时清空当前不可用 prompt/草稿；仅剩超长题时终止 remaining，保留先前 completedItems 与已入库答案可继续批准填入。
- [ ] 成功生成时更新 batch / prompt / remaining；保留 reply、imported、attemptedRequest 的原重置时机与来源页关联判断。
- [ ] 题目选择摘要改为“不限题数 · 每批完整提示词 ≤ 300000 字符”；字符计数显示当前实际 prompt.length / 300000。
- [ ] 内置和外部路径的复制、发送按钮保留 validateWebPrompt；用户编辑导致超限时明确拒绝复制/发送，不默默截断。
- [ ] 保留下一批需本批有效答案全部导入的条件、requestId 校验、重复发送保护、取消逻辑、原页面同题比对与显式批准填入。
- [ ] 草稿恢复仍兼容原 WebBatch。恢复后先按完整 buildWebPrompt + validateWebPrompt 校验；合规旧草稿沿用同一 requestId，防止旧回答失配。超长/损坏草稿提示重新抓题/生成并禁用发送，不自动裁剪或改写其 requestId；不顺带重构草稿持久化格式。
- [ ] 外部浏览器手动路径也使用相同字符分批与预览规则。缺题、低置信度/警告的现有反馈原样保留。

**手工验证：** 一批超过 50 题；字符拆为两批；首批导入前下一批不可操作；导入后可生成下一批；全跳过后按钮合理；旧合法草稿可接收旧 requestId 答案；超长恢复草稿不发送；停止后不重复发送。

## Task 5：新增右侧“使用教程”模块

**新增：** TutorialPanel.tsx、tutorial.css。**局部修改：** App.tsx。

- [ ] App 新增 tutorial TabId、BookOpen 图标、tabs 元素和渲染分支，位置建议在设置之前。保留原有 tab ID、相对顺序、收起与展开行为。
- [ ] 新组件为纯展示：标题、简短导读、可键盘操作的目录与 details 折叠章节；支持右栏内部滚动和长内容换行；不加自动调用业务的快捷按钮。
- [ ] 章节“开始前”：启用真实 WebView，内置浏览器登录并进入实际题目页；说明登录态、清除登录入口和演示模式区别。
- [ ] 章节“网页 AI 六步”：①抓题、选择并生成提示词、②开站并登录、③发送/等待、④提取或粘贴完整 JSON 后预览、⑤确认入库/生成下一批、⑥内置模式回原页核对与批准填入。顺序与现有六个步骤卡一致。
- [ ] 章节“字符规则”：总长 300000；不限题数；累计放不下进下一批；独立仍超限只跳过本次提示词；原题保留；站点自身限制可能更小，用户可手动少选题。
- [ ] 章节“外部浏览器”：复制提示词、打开目标站手动发送、复制完整回答粘回应用、预览入库；说明此模式没有第六步直接回原页填入，入库后可回原题页用 API AI 的题库查询路径核对填入。此路径不能承诺自动读取外部浏览器登录或回复。
- [ ] 章节“API AI”：选择服务商/URL/模型/认证，配置并保存，测试聊天，抓题→解析→核对→填入；题库优先；并发 1–5、默认 5，429 降并发、余额不足检查配置/额度；演示答案不当真实结果。
- [ ] 章节“题库”：JSON 导入/导出、手动加入格式，提供可复制的选择题与填空示例，多选 A、C / AC，网页 AI JSON 和手工文本入口不能混用。
- [ ] 章节“进度与排错”：解析/填入阶段、状态颜色、等待/结束/错误；抓不到题先检查页面与真实 WebView；回复不完整检查 requestId 和缺题；页面变化重新抓题；Token 仅记录有 usage 的 API；错误报告和底部日志入口。
- [ ] 本模块所有 CSS 以 .tutorial-panel 为根，复用现有字体/颜色变量、15px 面板和 10px 控件；不覆盖全局 h/button/details。
- [ ] 深浅主题、右栏最小/常用宽度、滚动、导航收起/展开、Tab/Enter/Space 和焦点可见均手工检查。不要为静态文案和导航枚举添加镜像测试。

**验收：** 教程完整可达、步骤与真实行为一致，章节学习不再出现在可用功能指南；原公告、设置中的 Key 说明以及原功能入口不被替换。

## Task 6：网页 AI 按钮局部美化

**修改：** WebAIWorkflow.tsx（仅样式类）、web-ai.css。**参考：** 独立 HTML 的 A / B 方向。

- [ ] 设置局部 primary / secondary / ghost / danger 类。当前步骤的主要动作突出，辅助复制/重开等使用次级层次，停止为克制的红色描边。
- [ ] 沿用靛紫主操作、绿色网页 AI 语义、15px 步骤卡/10px 按钮，不换布局体系或增加 UI 库。
- [ ] 按钮高度以 36–38px 为基准，正文 12–13px，图标约 14–15px；窄栏允许换行/占满，避免固定宽度截断长中文。
- [ ] hover 仅轻微提亮/边框变化，active 局部压下；focus-visible 清晰轮廓；disabled 无点击/动效、文字仍可读。解决网页 AI 内部父 disabled opacity 叠加导致过淡，只动本作用域。
- [ ] 为 .web-ai-inline / .web-ai-dialog / .web-ai-task 都覆盖状态，并处理浅色主题末尾全局 disabled 规则的优先级；不得修改全局 disabled 规则。
- [ ] 保留每个现有 onClick、disabled、任务锁和数据条件。检查错误页、任务浮条、弹窗、内嵌、busy、重新生成等状态均没有丢按钮或多出业务动作。
- [ ] 与当前全局 jelly 相容，不更改其监听/transform 实现；减少动效时无按钮位移动效。

**验收：** 同风格、可读、状态明确；API AI/题库/设置等按钮截图及代码均无变化。不添加仅核对 CSS 属性的单元测试。

## Task 7：答题进度流光局部美化

**修改：** src/index.css 的 browser-solving-dock 专属规则。**默认不改：** BrowserPanel 进度 JSX 与逻辑；若可访问性属性必须补充，需保持同一局部边界且不碰计算。

- [ ] 保留底部居中、370px 胶囊、translateX(-50%) 定位及指针行为，优先仅在轨道填充的伪元素上做流光。
- [ ] running 使用低对比靛紫渐变、细高光和约 2.4–3.2 秒平滑流光；B 仅提高局部光晕与主按钮层次，不增加全屏发光或闪烁。
- [ ] 动画仅依赖既有 .is-active，完成/错误/空闲均关闭流光与外围循环；success 绿色、error 暖红并保留状态文字/图标。
- [ ] prefers-reduced-motion 关闭平移/闪烁，保留静态轨道和百分比。浅色模式单独保证对比。
- [ ] 核验进度值、解析/填入计数、完成/错误后 720ms 隐藏逻辑、暂停/继续行为与原版一致。不得用动画计时模拟真实进度。
- [ ] 检查全局 jelly 的 transform !important 不造成胶囊偏移。采用内部装饰层规避，不改全局动效或其他模块。
- [ ] 不触碰 .kb-progress、本地题库流光或 Token 图表。

**验收：** 运行有流光，结束/错误停止；不同状态有文字含义，缩窄浏览器区域不会遮挡右栏。

## Task 8：回归、构建与完整性核验

**本轮不执行；以下是实施后的交付门槛。**

- [ ] npm test：7 个原有测试文件保持存在，所有原有行为测试及新增分批测试通过。
- [ ] npm run build：renderer TS + Vite 通过；npm run electron:build：主进程 TS + preload bundle 通过。
- [ ] 使用 npm run pack:win 生成验证安装包；不要调用会发布到外部的工作流。验证 app.asar 内 dist/index.html、资源、main/preload/preload-webview 存在，userscript 不存在。
- [ ] 使用 scripts/verify-webview-preload-bundle.mjs 检查实际 app.asar 路径，不能含相对 split-module require。源码树和打包树都无章节运行入口。
- [ ] 用合法测试/演示数据在 Electron 手工验证下表；不要在真实作业/考试中自动提交或发送无关请求。

| 功能 | 核验步骤 | 应保持的结果 |
| --- | --- | --- |
| 导航/登录 | 开页、登录、前后退/刷新、新标签、重启恢复 | 标签、URL、会话持久化正常 |
| 抓题/字体 | 单选/多选/判断/填空/问答、阅读上下文、字体映射 | 题型、选项与上下文完整；共享字体链正常 |
| API | 题库命中、未命中查询、并发与暂停、429/余额提示 | 不新增调用、不丢答案、不改变错误处理 |
| 填入/保存同步 | 乱序选项、多选、判断、多个空/富文本 | 页面值与隐藏字段一致，原有有界重试保持 |
| 逐题考试 | 填入当前题后进入下一题 | 下一题与抓题链保留，不触发最终提交 |
| 网页 AI | 三站适配、内置/外部、重复发送、停止、完整/缺题/旧 requestId | 原检查有效；分批正确；无静默丢题 |
| 题库/统计/设置 | 导入导出、手工、历史、Token、日志、模型配置 | 功能、数据与代码保持完整 |
| UI | 深/浅、窄/宽右栏、教程、运行/完成/错误、减少动效 | 同现有风格，无影响其他面板 |

- [ ] 将实施后的 SHA-256 与执行开始基线逐一比较，所有保护路径完全一致。允许文件检查增量 diff，每个 hunk 必须能对应本计划某一条；不允许全文件格式化掩盖范围。
- [ ] 检查原有三个删除仍在，没有恢复/重删用户代码；无意外依赖/lockfile/CI/版本号变动。
- [ ] git diff --check 通过；交付简明列出修改文件、跳过规则、已跑检查及任何未能完成的真实 WebView 项。未完成的门槛不得写作“已确认不影响其他功能”。

## 完成定义

章节功能在源码入口、事件、类型、打包资源和当前使用说明中均无可运行残留，共享字体/答题能力完整；右栏教程可达且覆盖真实操作；网页 AI 按钮和进度符合选定参考方向且深浅主题/减少动效可用；任何已发提示词均 ≤300000，短题不受题数限制，超长整题有记录且原始数据不被删除；保护文件无变化，全部必要测试、构建与冒烟门槛有可核验结果。

## 2026-10-14 实施进度

用户随后回复“可以改”，已执行上述代码调整。Task 1–7 的实现完成，规格与最终质量审查通过。Task 8 的类型检查、CSS 解析、差异与保护哈希检查完成；七个测试文件经额外进程内诊断运行器 67 项通过。标准 Vitest、完整构建/安装包与真实 WebView 冒烟仍受环境 spawn EPERM 和提权审核服务 503 阻碍，未达到全部运行验证门槛。具体证据与范围见 `docs/analysis/2026-10-14-implementation-verification.md`，本计划原勾选项保留作为完整验收清单。
