# Web 自动答题上下文、图片与多页面任务实施方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 为 Web 自动答题补充实验报告上下文、实际可读取的图片，并使多个题目页的任务在切换、导航后独立继续运行。

**Architecture:** 保留现有 WebAIController 的发送、收集、补题、校验及填入流程，在其外增加按题目页组织的任务管理层，每个任务持有自己的控制器、活动状态、配置及浏览器资源。题目静态身份与动态参考材料分离；图片通过独立附件传递，页面回包按任务和请求准确路由。原题页作为任务资源保留，浏览导航与执行目标分开。

**Tech Stack:** 现有 React 18、TypeScript、Electron 31、Vitest；不计划新增运行时依赖。

---

## 0. 当前阶段与改动约束

- 本方案已获用户“开始”授权并完成代码实施；2026-10-20 用户进一步明确：不论是否已有填写，必须重新提取全部题目并重新作答。已按该澄清移除筛选和填回阶段的已有答案跳过逻辑。真实 AI 网站线上含图验收尚未执行，详见验证记录。未提交或发布。
- 检查时 HEAD 为 `ce1ecc4e7acbd6e476ddffeb46d23efe1d64053b`，版本 `1.4.4`，工作区干净。
- 实施前保存了 100 个已跟踪文件的 SHA256 基线。收尾核对：20 个相关文件改变，80 个文件逐字节未变，无白名单外改变或文件缺失。
- 白名单为下文列出的文件及测试。既有文件只修改点名的类型、函数和 Web 专用接入分支，不进行顺带重构、格式化或依赖升级。发现必须扩大边界时，先列原因与新范围，再请用户确认。
- 继续保持：当前页面可抓取全部题目、整题分批、完整文本提示词上限 **300000 字符**、超限单题跳过、唯一单选校验、有效答案自动收集、缺题有界重发、收齐后填回、**不自动提交**、TXT 转换后完整一次发送、基于输入可用性和发送结果判断而不强制登录。
- 本方案中的“多开”指应用内多个题目标签页同时执行 Web 自动答题，不扩展 API 自动答题的执行方式。“后台”指应用仍在运行时离开题目页、浏览其他页或收起侧栏，不包括应用退出、设备休眠期间继续执行。

## 1. 已确认的问题与代码证据

| 问题 | 当前位置 | 实际限制 |
| --- | --- | --- |
| 实验报告缺上下文 | `electron/preload-webview/question-extractor.ts` 的 `questionFromRoot`、`extractDetachedCompletionQuestions`、`attachReadingContext`；`src/webAI/protocol.ts` 的 `prettyPromptQuestion` | 只有少数阅读题附带 `context`；不读取章节、大题分组、前序填写内容和邻题关系。提示词虽已有 `context` 字段，缺少可靠数据来源。 |
| 图片丢失 | `findQuestionText`、`visibleText`；`QuestionPayload`、`QuestionItem` | 题干最终以文本保存，图像没有独立字段。`removeNoise` 会去除 svg/canvas，纯图片题也可能因缺少文字被拒绝。 |
| 图片发送未实现 | `src/webAI/browserBridge.ts` 的 `webPageAction`；`src/webAI/sendPrompt.ts` | 现有附件检测只认 `.txt`，不能识别、绑定和确认图片上传；把 URL 或 Base64 放进普通文本不等于 AI 已读到图片。 |
| 导航中断 | `src/webAI/WebAIController.ts` 的 `extract`、`fill`；`src/components/BrowserPanel.tsx` 的请求和导航处理 | Web 任务已独立于侧栏组件，并非所有切换都会终止；但原题必须持续位于同一 tab、同一 URL。原页导航后直接报错；`fill` 和发送主动切换标签。部分打开新标签逻辑还会关闭 opener。 |
| 无法并发 | `WebAIController.ts` 的 `begin`、`finish`、`stop`；文件末尾单例 | 一个控制器、一个全局运行锁、一份待发草稿和一份配置；第二个 Web 任务被阻止，简单创建两个实例还会相互释放全局锁。 |
| 回包串线 | `BrowserPanel.tsx` 的 `extractQuestionResolverRef`、`applyAnswerResolverRef`、`handleWebviewIpc`、`applyQueue` | 抓题和填入各只有一个回调槽，回包没有请求关联 ID；并发会覆盖回调。全局填入队列与活动标签变化还可能交错。 |
| 状态串线 | `appStore.ts` 的 `questions`、`answerMap`、`status`；`answerActivity/activityStore.ts` 的 `task` | 前后台题目和任务覆盖同一状态，进度只能存一个任务；相同“实验结论”等短题干会共享 hash。 |
| 返回状态不完整 | `WebAIWorkflow.tsx`、`App.tsx`、`AnswerActivityLayer.tsx` | UI 订阅固定单例；通知、暂停、重试、音效与庆祝没有多任务归属。 |

## 2. 设计与行为约定

### 2.1 上下文：静态材料与动态答案分开

1. 抓取时建立材料分组，优先采用页面 qid、实验/报告标题、章节面包屑、大题容器和局部标题；没有可靠章节信息则留空，不从 URL 猜章节。
2. 对同一实验/大题保留题目顺序，收集前后各 2 道邻题题干；在同一组前序题中保留最近 5 道非空已填内容。已填内容读取 textarea.value、文本 input、contenteditable 和可访问的同源编辑器 iframe，不抓取账号、密码、隐藏 token 或页面其他表单。
3. 参考答案记录来源：`page-filled`（页面已有填写）或 `web-generated`（本任务已校验的前批答案）；不能把空答案或尚未校验的 AI 输出标成事实。
4. 提示词在同一消息内携带公共材料及逐题引用。说明材料只作参考、未知实验观测值不得编造；本批前后题可互相参考，跨批/重发可参考本任务已校验答案。
5. 按用户最新澄清，不论选择、填空、问答题是否已有填写，都重新提取并纳入本轮目标；无需预先清空。自动流程获得有效新答案后填回，手动流程仍保留既有确认步骤。旧填写仅作为上下文，不作为跳题或计为完成的依据；失败重试只跳过本轮已成功填入的题，不能把“旧有填写”误当成本轮完成。
6. 可选上下文设预算：标题/分组材料最多 16000 字符，单题邻题与前序填写参考合计最多 12000 字符。超限先去重再缩减远处邻题和较早参考，并写明缩减；原题题干及选项不截断。最终完整文本仍按 300000 字符计算和分批。
7. 不把动态已填答案纳入题目 hash 或 `sameQuestions` 判定。题目本体身份使用页面题号/qid、静态题干、选项、稳定材料与图片指纹；没有 qid 时以分组和原始顺序区分同名题。
8. 本次抓到的全部题目均计入待填目标，包含已有填写。图片失败待处理题仍计入未完成目标，故障时其他已获有效答案的题可以填回，最终显示部分完成。没有故障时沿用收齐本次目标再统一填回；缺图、超限或实际填入失败不能误统计为完成。

计划新增的元数据契约（两端类型同名字段，测试核对）：

```ts
type WebReference = {
  pageTitle: string;
  chapterTitle?: string;
  sectionTitle?: string;
  groupKey: string;
  sourceQuestionId: string;
  material?: string;
  filledValues: string[];
};

type QuestionMedia = {
  id: string;
  role: 'stem' | 'option' | 'material';
  optionLabel?: string;
  sourceUrl?: string;
  alt: string;
  caption?: string;
  width?: number;
  height?: number;
  status: 'discovered' | 'ready' | 'unavailable';
  reason?: string;
  contentDigest?: string;
};

// 在原类型上只增可选字段，旧题、旧草稿继续可读。
// QuestionItem / QuestionPayload:
//   webReference?: WebReference;
//   media?: QuestionMedia[];
```

### 2.2 图片：发现、读取、附件提交和降级

1. 在清理 DOM 文本之前独立提取题干、选项和共享材料图片，读取 `currentSrc`、`src`、懒加载属性、`picture/srcset` 的实际地址，按当前文档 baseURI 解析；保留 alt、图注、尺寸及所属题/选项。按题根及文件指纹去重，不把网站图标、按钮图标和头像当试题插图。
2. 支持只含图片的题目/选项；使用“见图片 q1-img1”等标识承接正文，仍保持其原始题型和选项字母。
3. 优先从原题 WebView 已加载图片获取可读取数据；HTTP(S) 图片由其真实 Electron Session 读取，继承该 Session 的登录与网络环境，必要时使用原页 Referer。blob/data 由原页面解析。读取失败时，在图片确实已经渲染的条件下，尝试仅截取对应图片区域；不截取整页作为替代。
4. 每张图原始数据不超过 8 MiB，任务图片缓存合计不超过 32 MiB，每批最多 8 张图，按整题分批。当前不自动转码压缩；单图/任务预算或单题图片数量超限时进入明确的媒体失败状态，不能静默截掉该题图片。文件名扩展名与实际 MIME 对应，保留原图摘要用于附件映射。
5. DeepSeek、豆包、千问逐站适配 file input / 粘贴上传入口。用确定文件名将附件绑定到题号、图片号；等待所有本批图片上传完成，再一次发送完整文本。文本被网站自动转 TXT 时，识别 TXT 与图片同时存在，保持一次发送，禁止分段键入或反复补发。
6. 发送回执必须确认“本批文本或 TXT + 本批图片文件”匹配，并等网站真正接受消息；仅输入框被清空、按钮被点击或存在任意附件不算成功。上传 pending、failed、已发送、发送不确定各有明确状态；重试不重复上传已成功附件，不重发不确定消息。
7. 普通文本提示词包含图片清单、映射和可用 URL，但 Base64 不塞进 300000 字符文本。AI 只能读文字、未开图片理解或站点不支持附件时必须明确显示能力不足，不能声称已经读图。
8. URL 失效/403/加载失败时仍保留该题。默认不自动填入依赖缺图的推测答案；其他可用题继续收集，故障题列为待处理并允许仅重试该题图片阶段。若题目仅凭文字可解，仍保留图片缺失警告供核对，不把 AI 声称“已看图”作为上传证据。
9. 图片字节仅保存在任务运行内存或受控临时文件；草稿和题库仅保存必要描述/稳定摘要，不保存 Base64。任务结束/取消清理临时文件；日志不输出 cookies、签名 URL 参数或图片数据。
10. 当前采用站点支持的 DataTransfer/File 输入或粘贴入口，并以网站附件回执核验；只接受系统原生选文件、拒绝程序上传的入口报告附件失败并保留待重试，不模拟系统文件选择器。图片只存任务内存，不落任意本机路径；读取前后复核原文档、题目局部元素与 MIME。

### 2.3 任务与页面生命周期解耦

- 每个题目页一个任务 session；抓题成功后不再依赖当前 activeTabId。原题 WebView 与 AI WebView 在任务运行期间是明确绑定的执行资源，切换标签/侧栏不会卸载或停止它们。
- 原题页被标记为“任务执行页”。地址栏跳转、前进后退以及原有跳转新标签逻辑对运行中任务采取“保留执行页，在新标签浏览”的行为，原题 DOM 与已填状态继续保留；其余普通标签保持原行为。
- 运行中 opener 不被自动关闭，关闭其他/右侧标签时也不误销毁正在执行的页面。用户主动关闭任务页时明确提示会停止该任务；取消保留，确认只停止对应任务并释放资源，不影响其他任务。
- 原题主框架的正常页面导航通过受任务租约约束的 native 导航钩子转到新浏览标签；仅在任务运行期间启用。提交/保存端点及平台考试流程沿用原限制，不自动重放 POST，不强行加载一次性考试 URL。
- SPA pushState、站点强制跳转、会话失效或 WebView 崩溃无法安全保留原 DOM 时，AI 收集任务仍继续，填入阶段使用 `waiting_source` 保存结果。原页面返回并匹配稳定身份后，从未填题继续；绝不能写入当前其他页面。明确显示“答案已准备，等待原题页可用”，不把它标为已填完成。
- 所有普通后台 inspect、prepare、按钮发送、抓题及填入直接针对绑定 WebView，不主动切换前台。确需原生 Enter 时，使用短临界区串行化 focus + sendInputEvent，完成后仅在用户未主动切换时恢复原焦点。
- 任务租约关闭相关宿主/任务 WebContents 的后台节流，最后一个相关任务释放后恢复原设置；不全局永久关闭，也不改变 BrowserWindow 启动/窗口行为。
- 任务状态存放在应用服务层内存；面板卸载只取消订阅。返回任一题页自动选中对应 session，恢复批次、进度、配置和失败步骤。应用退出不承诺继续执行或无缝重放已发送消息。

### 2.4 多页面并发与数据隔离

- 一个 `WebAISessionManager` 管理 `Map<sessionId, session>`，每个 session 拥有一个现有控制器实例和独立 `AnswerActivityStore`。配置在任务创建时复制（provider/mode/flow/相关选项），修改另一个页面的配置不影响已运行任务。
- 每个 session 分配独立 AI 页面，保留各自聊天草稿和回答游标，可以共享既有登录 Session。考虑网站可能恢复同一服务器会话，同 provider 的“发送＋收集”临界区统一排队，不同 provider 并行；各任务状态仍独立，不能把同站点排队表述成真正的服务器并行会话。
- 暂停、停止、重试只操作对应 session 的 AbortController、token、发送回执和未处理题目。保留现有每题最多 3 次自动补发，重试从该任务失败步骤继续。
- 浏览器操作携带 `sessionId`、`operationId`、`targetTabId` 和稳定页面身份；pending 请求用 Map 匹配。preload 在新 Web 请求回包中原样带回 operationId，超时/取消/旧文档迟到回包不再修改任务。
- 同一 WebView 的填入保持串行，不同 WebView 可以并行。原 API 的无 task id 请求继续走既有兼容路径，API 任务执行代码不重构。
- Web 任务运行锁改由 manager 统一持有及引用计数，不能由某个 session 的 finish/stop 把其他任务的运行标记清掉。既有 API 与 Web 互斥策略保留，Web 与 Web 不再互斥。
- Web 的题目、答案、状态与进度以 session 本地快照为准，不让后台结果覆盖全局当前题目或 API 状态。公共题库/历史仍是共用资源，其写入走现有主线程内同步入库接口。
- 入库使用只对 Web 启用的精确上下文写入选项：稳定实验/大题材料和媒体摘要参与内容 key；动态已填答案不参与。禁止新 Web 上下文条目通过旧短题干回退合并；原 API、手工导入及一般查库匹配规则保持原样。
- 旧单例草稿只迁入默认手动工作区，不同时复制给多个页面；新草稿按 session 分键保存必要文本元数据，图片不进入 localStorage。失效来源不能自动恢复执行。
- 保留当前单任务 UI 风格，增加简短任务选择及页签状态。活动任务展示自己的进度；后台失败用带任务归属的提示/重试入口，不抢走当前正在操作的页面。音效/庆祝按 session/request 去重。

计划的任务归属契约：

```ts
type WebTaskBinding = {
  sessionId: string;
  sourceTabId: string;
  sourceUrl: string;
  sourceFingerprint: string;
  aiTabId?: string;
};

type WebPageOperation = {
  sessionId: string;
  operationId: string;
  targetTabId: string;
  documentId: string;
};

// session 中独立保存 questions、answers、configuration、controller、activity。
// pending Map 的键为 operationId，值同时核对 tabId / documentId / sessionId。
// DOM 定位 selector、动态参考答案和临时图片字节不作为跨页题库身份。
```

## 3. 文件、函数和具体改动白名单

### 3.1 修改既有文件（只限列出的接入点）

| 文件 | 函数/类型 | 具体改动 |
| --- | --- | --- |
| `electron/preload-webview/types.ts` | `QuestionPayload`；新增 WebReference/QuestionMedia 兼容类型 | 添加可选 Web 参考和媒体描述字段。原字段、填入 payload 含义不变。 |
| `src/store/appStore.ts` | `QuestionItem`；`upsertQuestionBank` | 对应可选字段；入库增加默认关闭的 Web 精确上下文选项，避免不同实验短题干合并。其他调用使用原默认行为，不改设置/题库 UI/清空逻辑。 |
| `electron/preload-webview/question-extractor.ts` | `findQuestionText`、`questionFromRoot`、`extractDetachedCompletionQuestions`、`extractQuestions`、`applyFontDecode` | 增加默认关闭的 Web 增强抓取选项，接入局部材料/当前填写和媒体发现；增强模式允许纯图题并保留稳定题身份。API 原抓题仍走默认兼容输出。动态参考与字体解码后的题目身份分离。 |
| `electron/preload-webview.ts` | `studypilot:extract-question`、`studypilot:apply-answer` 的 IPC handlers | 接受可选 Web 操作信封、增强抓题参数，回包带相同关联字段；老请求仍原样执行，不改 applyAnswerV2。 |
| `src/webAI/protocol.ts` | `WebBatch`、`prepareWebBatch`、`prettyPromptQuestion`、`buildWebPrompt`、`sameQuestions` | 建立本批上下文/附件映射；按真实序列化文本重新计算字符预算；保持单选/判断/多空约束。原题校验仅比较稳定字段，不比较已填答案、图片上传进度或选择器。解析答案仍按 requestId/题型严格校验。 |
| `src/webAI/WebAIController.ts` | `Environment`、构造器、`restorePending`、`begin`、`finish`、`stop`、`saveBatch`、`prepare`、`openInternal`、`monitorOptions`、`sendAndRead`、`importItems`、`extract`、`fill`、`startAutomatic` | 注入 session 身份、局部 store/activity/锁与草稿命名空间；任务源固定，不读取其他页；上下文构建及媒体准备加入失败续接阶段；waiting_source 独立于 AI 收集；移除普通后台流程的强制 focus。 |
| `src/webAI/browserBridge.ts` | `BrowserSource`、`WebCommand`、`WebPageState`、`browserCommand`、`webPageAction` | 加入任务关联、媒体上传及回执字段；现有三站 adapter 增图片入口/数量限制/上传进度识别，TXT+图片同批识别，精确确认同一次消息。 |
| `src/webAI/useBrowserBridge.ts` | `useBrowserBridge` | 绑定资源而非活动标签路由；接入图片发送和任务关联；原生按键用资源级短队列，归还焦点时保护用户已切换的选择。 |
| `src/webAI/sendPrompt.ts` | `sendWebPrompt` | 将 TXT 特定上传状态拓展为本批附件状态，全部就绪后一次发送；保持发送不确定时不盲目重发。 |
| `src/components/BrowserPanel.tsx` | `BrowserTabView`、`registerWebview`、`handleWebviewIpc`、抓题/填入事件 handlers、`openBrowserTab`、`loadWebviewUrl`、`navigate`、`moveHistory`、`closeBrowserTab`、`closeOtherTabs`、`closeTabsToRight` | 注册活动页/任务资源；Web 请求采用按任务及 operationId 路由与每页队列；保护运行中原题页和 opener；导航转新浏览标签；任务页状态标记。API、mock、扫描、计划执行和普通标签沿用原路径。 |
| `src/webAI/WebAIWorkflow.tsx` | `WebAIWorkflow`、`openWebAI` 相关选中任务绑定 | 订阅当前选中 session，按钮作用于明确任务；显示所属页面、媒体降级、waiting_source 和重试位置；手动步骤保持其确认方式。 |
| `src/components/AIPanel.tsx` | Web 模式题数徽标及其 import | 为修复用户补充的“有题但显示 0 题”截图，仅接入 `WebQuestionCount`；API 模式继续读取原全局 questions，API 执行函数不变。 |
| `src/App.tsx` | `webTask` 订阅和侧栏自动收展 effect | 改为 manager 的选中任务/待关注任务；后台完成不误折叠其他任务面板，待处理提示可定位对应任务。其余布局/拖动/主题/窗口逻辑不动。 |
| `src/answerActivity/AnswerActivityLayer.tsx` | `ActivityDock`、`collectFeedback`、`AnswerActivityLayer` 的订阅/清理 | 合并展示各 Web session 独立活动，当前任务进度与按钮正确归属，反馈按任务去重；UI 卸载不 stop；原 API observer 和活动算法保持不变。 |
| `src/webAI/web-ai.css` | 仅新增任务选择/所属页/媒体失败提示样式 | 使用已有主题变量、按钮、边框、尺寸，不重做界面、不调整全局动效。 |
| `electron/main.ts` | 新增 Web-task IPC 注册入口；仅在已有 web-contents-created 处挂任务资源钩子 | 注册下文隔离 native 模块；任务租约限制到明确 WebContents；不改窗口启动、登录持久化、安装器、云题库和 ai:chat。 |
| `electron/preload.ts` | `electronAPI` 新增窄接口 | 暴露媒体读取、任务资源租约注册/释放和对应导航事件订阅，校验放 native；不扩大已有通用 API 权限。 |

### 3.2 新增文件（新增职责避免扩大既有大文件）

| 文件 | 计划函数/类 | 职责 |
| --- | --- | --- |
| `electron/preload-webview/question-reference.ts` | `collectWebReferences`、`readFilledValues`、`collectQuestionMedia` | 只读采集局部实验材料、同源编辑器当前填写及图片元数据；不写页面、不加载外部资源。 |
| `electron/web-ai-task-resources.ts` | `registerWebAITaskResources`、`leaseTaskContents`、`releaseTaskContents`、`readQuestionMedia` | 受控原题/AI WebContents 租约、后台节流与运行中主框架导航保护；Session 图片获取及必要局部截图、限量、清理。只接受主窗口针对其已有受管 WebViews 的请求。 |
| `src/webAI/questionContext.ts` | `buildWebReferences`、`stableWebQuestionKey`、`toWebBankQuestion` | 生成同组公共材料/动态答案参考、预算和稳定 Web 题身份；入库转换不携带临时字节或动态答案。 |
| `src/webAI/questionMedia.ts` | `prepareQuestionMedia`、`buildMediaManifest`、`releaseQuestionMedia` | 按任务整理图片、获取字节与摘要、受限缓存、附件清单和精确失败信息；不访问其他任务数据。 |
| `src/webAI/WebAISessionManager.ts` | `WebAISessionManager`、`getOrCreateForSource`、`selectForTab`、`acquireRun`、`releaseRun`、`disposeSession`、`getSnapshot`、`subscribe` | 多任务实例、源页/AI页关联、每任务 store 适配、配置快照、锁引用计数、活动汇聚和资源释放。 |
| `src/webAI/pageRequests.ts` | `WebPageRequestRegistry`、`request`、`resolve`、`cancelSession` | 按 operationId/tab/document/session 关联请求，集中超时/迟到回包处理；每页填入队列持久于 React render。 |

### 3.3 测试与验证文档

- 实际修改：`tests/question-extractor.test.ts`、`tests/web-ai-controller.test.ts`、`tests/web-ai-login.test.ts`。其余原测试文件未修改，随全量回归一起执行。新增测试覆盖上下文、图片、任务隔离及“全部已有填写仍重新作答”。
- 新增：`tests/question-reference.test.ts`、`tests/question-context.test.ts`、`tests/web-ai-media.test.ts`、`tests/web-ai-sessions.test.ts`、`tests/web-ai-page-requests.test.ts`、`tests/web-ai-task-resources.test.ts`。
- 新增验证记录：`docs/analysis/2026-10-20-web-context-media-multisession-verification.md`，实施时填入真实测试输出、实机证据、白名单外文件哈希对照和仍存在的站点限制。
- 不计划修改 `AIPanel.tsx` 的 API 请求/并发/自动答题循环、`aiRequest.ts`、答案匹配器、`answer-applier.ts`、页面答案同步、安装与升级、登录存储、云题库、统计、版本号、依赖、教程和发布工作流。

## 4. 实施顺序与每阶段验收

### Task 1：固化任务身份和操作隔离

- [x] 保存基线哈希与文件白名单，核对用户确认范围。
- [x] 为 `WebPageRequestRegistry` 写乱序回包、超时、取消、旧 documentId 回包、不同 tab 相同题干测试；期望旧回包不能完成新请求。
- [x] 实现 operationId 注册及返回协议，Web 路径使用 registry，每页 fill 队列；未携带信封的旧 API 请求保留原路径。
- [x] 回归原抓题、单题/多题填入、现有填空失败重试，不改变现有页面答案算法。

### Task 2：任务管理和后台资源

- [x] 写两个同 provider 任务同步启动、其中一个暂停/停止/失败、结束顺序反转等测试。
- [x] 实现 manager 与注入式 controller，局部 questions/answerMap/status、独立 activity、配置快照和草稿键；Web 锁改 manager 引用计数。
- [x] 为每个任务分配独立 AI 会话页；控制器普通浏览命令不切换用户前台。
- [x] 增原题页租约、导航保留、opener/批量关闭保护；接入 native 主框架导航和任务期间的后台节流控制。
- [x] 测试 source fingerprint 验证、waiting_source、刷新/崩溃/失效会话；返回相同原题只继续未填项，页面变成另一份作业不填入。
- [x] 接入 workflow、侧栏和进度层；UI 卸载只退订，不销毁任务；归属明确的通知与重试入口。

### Task 3：上下文和短题干身份

- [x] 构造一份实验报告夹具：章节“网络实验”，大题“直通网线制作”，前题已填“568B”，当前题“实验结论”，后题“心得”；断言同一提示词含标题/前序题与答案/邻题，且材料不混入另一报告。
- [x] 测试 textarea.value 与 DOM textContent 不一致、多个填空、contenteditable、同源 iframe、跨源不可读 iframe及空填写。
- [x] 在 Web 增强抓题模式采集材料/当前填写；保留默认 API 抓取行为。
- [x] 构建静态身份和动态参考；按用户最终要求，已有填写题也重新作答，旧答案仅作参考，不跨 task 使用全局 answerMap；前批新答案优先于旧填写，缺题补发正确引用。
- [x] 重新校准完整文本字符预算：299999/300000/300001 边界；上下文缩减先于整题跳过；不切题干/选项；只输入实际请求题数。
- [x] Web 专用入库精确上下文测试：不同实验的同名题分别保留；同实验重试不会重复；动态答案变化不造成原题失配或题库新副本。

### Task 4：图片提取与实际发送

- [x] 构造题干图片、纯图题、图片选项、懒加载、相对地址、srcset、blob/data、已加载跨域图、共享材料图及加载失败夹具。
- [x] 实现媒体发现与原生受控读取：默认 10 秒单图超时、保守串行读取（不超过原定 3 路上限）；超时/403/重定向非图片/MIME错误/8 MiB 上限可预测地失败；取消即中断并清理。
- [x] 附件清单包含题号/图片号/稳定文件名/摘要；长文本与图片预算独立，按站点限制重分批，不静默删除题图。
- [x] 三站 adapter 分别测试图片区挂载、上传 pending/failed/ready、TXT 和图片混合、用户已有附件/草稿、发送不确定与重试；保留现有整段 TXT 行为。
- [x] 引入媒体阶段重试游标：只恢复失败图/该题准备阶段，已经完成的别题与已发送请求不重放。
- [x] 媒体不可读的题显示具体原因并保留；有效题继续，最终为部分完成，不虚报全部完成。

### Task 5：跨模块回归与实机验收

> 2026-10-20：混合题型补抓修复后 330/330 单元回归、前端/Electron 类型检查与构建已通过；本地真实 Electron WebView 的双页各 6 道混合题抓取、图片读取、隐藏页操作、分别填入及 GET 导航保留已通过。下列四项线上场景仍待在真实作业与 AI 网站现场验收，不用本地夹具或 mock 结果替代。

- [x] 执行 `npm test`，期望现有与新增回归全部通过；测试个数以实际结果记录，不预报数字。
- [x] 执行 `npx tsc --noEmit` 及 `npx tsc -p tsconfig.electron.json --noEmit`，期望前端/Electron 类型检查通过。
- [x] 执行 `npm run build` 和 `npm run electron:build`，期望生产构建和 preload 打包通过。
- [ ] 实机在 DeepSeek、豆包、千问分别验证一题“AI 必须识别真实图中文字/图形才可答”的用例；检查网页上的实际附件、发送次数及返回答案，不能用 mock 成功替代站点实测。
- [ ] 同时启动 A/B 两页（包括相同短题干、同 provider 不同会话、不同 provider），在它们生成/填入期间来回切换、打开新页、收起侧栏；两页各自完成，暂停/停止/重试互不影响。
- [ ] 验证地址栏/页面链接离开时保留原题页在后台执行；验证 SPA/强制重定向退化为等待原页，返回进度恢复且不重发已完成批。
- [ ] 验证一个任务媒体失败/站点限流时，另一个完成任务仍可庆祝，失败任务不会被标记全部完成。
- [x] 实机只填入不提交，测试账号和题目页由用户现有授权环境提供；真实站点不可用时如实记录受阻环节，不宣称已适配成功。
- [x] 执行 `git diff --check`；核对 diff 与 SHA256 白名单，逐字节确认白名单外已跟踪文件未变，白名单内说明改动函数和理由。
- [x] 输出最终具体位置（实际文件、函数、行号）、测试结果、站点实测范围及未解决限制，不将“测试通过”表述成“所有情况绝无影响”。

定向测试命令示例：

```powershell
npm test -- tests/question-reference.test.ts tests/question-context.test.ts tests/question-extractor.test.ts tests/web-ai-protocol.test.ts
npm test -- tests/web-ai-page-requests.test.ts tests/web-ai-sessions.test.ts tests/web-ai-controller.test.ts
npm test -- tests/web-ai-media.test.ts tests/web-ai-task-resources.test.ts tests/web-ai-send.test.ts tests/web-ai-login.test.ts
```

## 5. 风险评估与控制

| 风险 | 等级 | 控制与可观察结果 |
| --- | --- | --- |
| 多任务回包/题干重复导致串答或写错页面 | 高 | operationId + sessionId + tabId + documentId 校验；每页串行写入；稳定材料身份；旧回包丢弃；两个相同短题干的任务作为强制验收用例。 |
| 导航后原 DOM、POST 会话或考试页面不可恢复 | 高 | 保留原执行页优先；不复制或重放 POST；无法保留时继续收集并等待原题页，不向新页盲填、不自动提交。 |
| 站点图片上传入口、DOM和视觉能力变化 | 高 | 三站独立 adapter 和真实含图用例；确证上传及消息回执；不把文本 URL/AI自述当读图成功；失败有归属和重试。 |
| 图片权限、过期签名、跨域污染导致不可读 | 中高 | 原 Session 获取、原页 blob/data、已渲染图局部截图、限时失败；缺图题保留并暂停该题自动填入。 |
| 上下文错组/互相引用错误导致推理污染 | 中高 | 同材料组、有序邻题、答案来源标识；不跨任务引用、不抓整页；未知观测值不补造。 |
| 已填参考改变 hash 导致误判，或题库同名合并 | 中高 | 静态题身份与动态参考分开，Web 专用精确上下文入库；回归旧题库、手工导入和 API 默认行为。 |
| 同账号多会话限流或站点只能一条会话并行 | 中 | 不共享 AI 聊天标签；根据站点能力限流/排队其发送资源；其他任务状态与答案继续隔离，不承诺突破网站限制。 |
| 原生按键争抢焦点、后台页面被节流 | 中 | 优先直接按钮发送；Enter 短资源锁；保护用户切换；任务租约范围内禁用节流并恢复。 |
| 图片/多 WebView 导致内存增长 | 中 | 图片 8 MiB/32 MiB 预算、保守串行读取、附件分批、任务结束清理；任务不无限自动创建；显示资源不足而不丢弃题目。 |
| 共享接入文件影响 API 或原有界面 | 中 | 增强抓题默认关闭，API handler 兼容分支、精确上下文选项默认关闭；不动 API循环/匹配器/填入算法；全套回归与白名单哈希核对。 |

## 6. 审核结论与确认点

1. 四项需求都需要服务层和浏览器桥接接入；只改提示词或加定时器不能解决源页导航和多任务隔离。以上白名单是本次相关模块范围，并非整项目重构。
2. 最新行为：包括已有填写在内的全部题目重新提取并作答，新答案填回原位置；旧答案仅作参考。运行任务原题页保留在后台，导航去新标签；缺图题保留等待处理；同 provider 发送与收集排队；应用退出不继续执行。
3. 代码实施、330 项回归、前端/Electron 构建与本地真实 Electron WebView 验证已完成。混合题型补抓包含单选、多选、判断、填空、问答和已有填写，不只抓取填空题。真实 DeepSeek、豆包、千问及用户当前线上作业未完成现场验收；未宣称线上全站适配已实测。具体文件/函数位置、范围哈希和限制见 `docs/analysis/2026-10-20-web-context-media-multisession-verification.md`。
