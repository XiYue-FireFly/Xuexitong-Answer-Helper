# 实施与验证记录（2026-10-14）

用户在分析、计划和 HTML 参考稿完成后回复“可以改”，本次据此实施。UI 采用参考稿 A“克制玻璃”，延续现有主题、配色、布局与交互。提示词总长为 **300000 字符**，不是 30000；单题仍超过完整提示词预算时仅跳过本次发送，保留原题。

## 实际改动

| 范围 | 实施结果 |
| --- | --- |
| 章节学习 | 移除 BrowserPanel 专用导航辅助与事件监听、AIPanel 无生产者的章节批量监听、网页 AI 的 learning 忙碌状态；关闭构建脚本对旧 userscript 的复制；移除当前 README 功能与指南，保留历史版本事实。 |
| 字符分批 | 取消固定 50 题限制。精确计算模板、请求 ID、题干、上下文、选项、JSON 转义与空白的 UTF-16 长度。整题按序加入；当前批放不下则进入下一批；单题仍超限则明确跳过。返回数据深拷贝。 |
| 网页 AI 工作流 | 显示实际批序号、本批/待处理/跳过数量与原因；全部跳过不产生空发送，不清除此前已入库答案。合法旧草稿沿用 requestId，损坏或超长草稿提示重新生成；复制/发送前保留校验。 |
| 使用教程 | 新增右侧入口、七个章节与可复制示例，目录可展开并聚焦指定章节；明确内置与外部模式差异和题库入口实际名称。 |
| 网页 AI 按钮 | 局部主要、次要、轻量与停止按钮，保留原点击函数与业务锁；支持深浅主题、焦点和禁用状态、减少动效。 |
| 答题进度 | 保留真实计数、370px 居中胶囊及结束隐藏逻辑。轨道内部低对比流光，仅运行时启用；完成、错误与减少动效停用；局部定位规则兼容共享指针效果。 |

## 代码完整性

执行前保存全部 72 个原有 Git 路径的原文与 SHA-256，以当前工作区而非 HEAD 为基线。已有 11 个修改/删除路径未被重置。原有三个章节文件保持删除。

本次改动 10 个已有路径，均属计划白名单；新增 TutorialPanel.tsx 与 tutorial.css。**其余 62 个保护路径与基线完全一致**。共享字体链 readTtfList / cxReadTtfList、syncChoice / syncJudgement / syncCompletion、主进程、preload、store、题库、设置、历史、Token 等保护文件均未被本次改写。package.json、package-lock.json、版本号、CI 未变。

BrowserPanel 的增量仅为章节辅助与监听删除；AIPanel 的增量仅为章节监听删除；App 的增量仅为教程导入、导航枚举、入口与渲染。index.css 的增量仅作用于 browser-solving-dock 和其动画。运行目录搜索未发现章节动作、专用模块或旧复制入口残留；共享文件名保留。

## 已取得的验证证据

- `node node_modules/typescript/bin/tsc --noEmit`：通过。
- `node node_modules/typescript/bin/tsc -p tsconfig.electron.json --noEmit`：通过。
- `git diff --check`：通过；Git 对原有 preload 文件仅提示 LF/CRLF 转换，未发现空白错误。
- 三份受影响 CSS 经 PostCSS 解析：通过。
- 全部七个测试文件经**额外诊断运行器**运行：67 项通过，0 项失败。使用 TypeScript 内存转译、Node 测试生命周期、真实 @vitest/expect 断言；没有重写测试断言或修改原测试以获得通过。
- 组件 SSR 诊断：教程七章与实际入口名称可渲染；合法旧草稿保留 requestId；四种损坏/超长草稿不显示可发送提示词；无草稿不误报损坏。
- 静态规格审查通过，已修正多选示例题型标记与题库按钮名称。
- 最终代码质量审查通过，未发现关键、高优先级或需要修复的具体缺陷；运行验证限制保留。

诊断运行器不等同于标准 Vitest，不验证 Vite 配置、浏览器 DOM、焦点交互、效果或覆盖率。SSR 使用真实 store 状态替代没有服务端快照的订阅钩子，仅测试初始渲染与草稿恢复，不宣称验证了异步浏览器流程。

外部验证文件保存于 `C:\Users\pyh20\.codex\visualizations\2026\10\14\01a13a84-3e2a-7b42-bf08-16c3b85a85da`：execution-baseline、run-tests-in-process.cjs、check-ui-render.cjs。原 ui-reference.html 参考稿仍保留。

## 未完成的验证与原因

正常 `npm ci` 被环境的 `spawn EPERM` 阻止执行依赖安装脚本；`npm ci --ignore-scripts --no-audit --no-fund` 成功安装锁定的 418 个包，未修改锁文件。提权安装请求因自动审批服务返回 HTTP 503 未执行，属于审核服务故障，未判定操作不安全。

`npm test` 在配置加载阶段被 `spawn EPERM` 阻止。`npm run build`、`npm run electron:build`、`npm run pack:win` 的 TypeScript 阶段通过，但 Vite/esbuild 子进程被相同环境限制阻止。因此未生成本次完整安装包，未运行 app.asar bundle 校验，未完成真实 Electron/WebView 的登录、五题型抓取、字体映射、填入同步、逐题、三站聊天或实际 UI/键盘冒烟。

本地 codex 分支创建同样未执行：Git 目录只读，提权请求因审核服务 503 失败。本次保留当前工作区改动，没有提交、推送或发布。以上未完成验证须在允许正常子进程的终端完成；不能将诊断测试结果表述为已确认全部功能在真实环境不受影响。
