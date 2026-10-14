import { useRef } from 'react';
import { ArrowUpRight, BookOpen, CheckCircle2, Globe, ListChecks } from 'lucide-react';
import './tutorial.css';

const sections = [
  ['prepare', '开始前'], ['web', '网页 AI 六步'], ['budget', '字符与分批'],
  ['external', '外部浏览器'], ['api', 'API AI'], ['bank', '本地题库'], ['help', '进度与排错']
] as const;

const choiceExample = `题目：（多选题）下列哪些属于可再生能源？
A. 太阳能
B. 煤炭
C. 风能
D. 石油
答案：A、C
解析：太阳能与风能属于可再生能源。`;
const completionExample = `题目：水的化学式是____。
答案：H₂O
解析：由两个氢原子和一个氧原子构成。`;

export function TutorialPanel() {
  const panelRef = useRef<HTMLDivElement>(null);
  const reveal = (id: string) => {
    const section = panelRef.current?.querySelector<HTMLDetailsElement>(`#tutorial-${id}`);
    if (!section) return;
    section.open = true;
    section.querySelector('summary')?.focus({ preventScroll: true });
    section.scrollIntoView({ block: 'start', behavior: 'auto' });
  };

  return <div className="tutorial-panel" ref={panelRef}>
    <header className="tutorial-panel__hero">
      <span className="tutorial-panel__eyebrow"><BookOpen size={14} />操作指南</span>
      <h2>使用教程</h2>
      <p>从获取题目到核对填入，按当前界面的操作顺序一步步完成。</p>
      <div className="tutorial-panel__path"><Globe size={14} /><span>抓取题目</span><ArrowUpRight size={12} /><span>解析与入库</span><ArrowUpRight size={12} /><span>核对填入</span></div>
    </header>

    <nav className="tutorial-panel__contents" aria-label="教程目录">
      {sections.map(([id, title], index) => <button key={id} onClick={() => reveal(id)}><span>{String(index + 1).padStart(2, '0')}</span>{title}</button>)}
    </nav>

    <details id="tutorial-prepare" open>
      <summary><span>01</span>开始前</summary>
      <div className="tutorial-panel__content">
        <ol>
          <li>在 Electron 桌面应用的右侧“设置”中开启<strong>真实 WebView</strong>。未开启时，演示页面只用于体验流程。</li>
          <li>在左侧内置浏览器打开学习通并登录，进入实际展示题干和选项的题目页，等待加载完成。</li>
          <li>打开右侧“答题”，选择“网页 AI”或“API AI”。两种方式共用本地题库，解析后先核对答案，再填入。</li>
        </ol>
        <p>网页登录状态会保存在本机，重启后可继续使用。需要更换账号时，在“设置 → 网页登录状态”点击“清除登录”，然后重新登录。</p>
      </div>
    </details>

    <details id="tutorial-web" open>
      <summary><span>02</span>网页 AI 六步</summary>
      <div className="tutorial-panel__content">
        <p>在“答题”中选择网页 AI，选定 DeepSeek、豆包或千问，并使用“应用内浏览器”。网页 AI 使用目标网站的聊天能力，无需填写 API Key。</p>
        <ol className="tutorial-panel__steps">
          <li><strong>开始抓题</strong><p>回到题目标签，点击“获取页面题目”。展开“选择题目”核对和勾选，再点击“生成提示词”。</p></li>
          <li><strong>打开网页 AI</strong><p>点击“打开”所选网站，在新标签内完成登录、进入聊天页。保留原题标签。</p></li>
          <li><strong>填入提示词</strong><p>登录完成后点击“发送提示词到 AI”，等待生成结束。同一批发送后会锁定重复发送；如需重做，请重新生成提示词。</p></li>
          <li><strong>提取答案</strong><p>点击“从 AI 页面提取答案”，也可将完整回答粘贴到“AI 回答”框。回答必须包含本批 requestId 和完整 answers 数组。</p></li>
          <li><strong>录入题库</strong><p>核对每题预览、答案、置信度和警告，点击“确认入库”。本批全部题目的有效答案入库后，才能“生成下一批”；缺题时先补齐当前回答。</p></li>
          <li><strong>开始填入</strong><p>完成核对后，点击“确认填入 … 题到原页面”。应用会切回来源标签并比对原题；页面题目或选项变化会停止填入，入库答案保留。此操作不会最终提交作业或考试。</p></li>
        </ol>
        <p className="tutorial-panel__note"><CheckCircle2 size={15} /><span>处理多批时，已入库答案会累积；全部完成后可一起核对填入。停止操作后，网站已收到的请求可能仍在生成。</span></p>
      </div>
    </details>

    <details id="tutorial-budget">
      <summary><span>03</span>字符与分批</summary>
      <div className="tutorial-panel__content">
        <div className="tutorial-panel__budget"><strong>300000</strong><span>每批完整提示词字符上限 · 不限题数</span></div>
        <ul>
          <li>字符计数包含题干、阅读上下文、选项、请求 ID 和提示词模板，以界面实际计数为准。</li>
          <li>按选择后的原顺序整题加入。当前批次放不下的题目保留到下一批，不截断题干或选项。</li>
          <li>一题连同必要模板单独发送仍超过上限时，整题跳过本次提示词，并显示题号和原因；抓题结果与题库原题保留。</li>
          <li>目标 AI 网站可能有更小的输入或输出限制。若被网站拒绝或回答缺题，可手动少选题目后重新生成。</li>
        </ul>
        <p>生成后可编辑提示词。超过上限或缺少本批请求 ID 时，复制和发送会被阻止；请修正或重新生成。</p>
      </div>
    </details>

    <details id="tutorial-external">
      <summary><span>04</span>外部浏览器</summary>
      <div className="tutorial-panel__content">
        <ol>
          <li>在网页 AI 中选择“系统默认浏览器”，抓题并生成提示词。</li>
          <li>点击“打开”网站，在系统浏览器登录；点击“复制提示词”，手动粘贴到网站发送。</li>
          <li>等待回答完成，复制完整 JSON 回答，粘回本应用“AI 回答”框。</li>
          <li>检查预览并确认入库。有下一批时，继续生成、复制、回答、入库。</li>
        </ol>
        <p>此模式需手动复制回答，应用不会读取系统浏览器的登录状态和聊天内容。外部模式不显示第六步直接填入；入库后可回到原题页，切换 API AI，获取题目并解析，优先命中本地题库，再核对填入。</p>
      </div>
    </details>

    <details id="tutorial-api">
      <summary><span>05</span>API AI</summary>
      <div className="tutorial-panel__content">
        <ol>
          <li>在“设置”选择服务商，确认 Base URL、模型、认证方式和 API Key。云端接口通常需要密钥；本地服务按实际情况选择“无需认证”。</li>
          <li>保存配置后，使用设置页的“AI 测试聊天”验证连接、模型与额度。需要密钥时，可点输入框旁的“没有秘钥，前往”查看教程。</li>
          <li>回到“答题 → API AI”，获取页面题目，解析单题或批量解析，核对后填入。题库命中优先返回本地答案，未命中才请求接口。</li>
          <li>需要边查边填时，使用“并发查询并自动填入”。并发可设 1–5，默认 5；429 限流会提示并降低下次并发，余额或配额不足时检查服务商额度。</li>
        </ol>
        <p>未配置需要的 API Key 时会使用本地演示答案，仅适合验证流程，不能作为真实答案。逐题考试模式会处理当前题并进入下一题，请保持原题页面可用并留意运行状态。</p>
      </div>
    </details>

    <details id="tutorial-bank">
      <summary><span>06</span>本地题库</summary>
      <div className="tutorial-panel__content">
        <p>打开“本地题库”，可搜索和查看答案，使用“导出备份”保存 JSON，使用“导入题库”恢复已有 JSON。同题导入会更新现有记录；题库数据保存在本机。</p>
        <p>点击“录入新题”，粘贴下面格式的题目文本，再点击“加入题库”。点击示例后可选中文字复制；多选答案支持 <code>A、C</code> 或 <code>AC</code>。</p>
        <label className="tutorial-panel__example">多选题示例<textarea aria-label="可复制的多选题格式示例" readOnly rows={8} value={choiceExample} /></label>
        <label className="tutorial-panel__example">填空题示例<textarea aria-label="可复制的填空题格式示例" readOnly rows={4} value={completionExample} /></label>
        <p>多道题可连续粘贴，也可用空行或 <code>---</code> 分隔。网页 AI 的 JSON 回答应粘贴到网页 AI 的“AI 回答”框，不能作为上述手工文本直接加入。</p>
      </div>
    </details>

    <details id="tutorial-help">
      <summary><span>07</span>进度与排错</summary>
      <div className="tutorial-panel__content">
        <p><ListChecks size={15} className="tutorial-panel__inline-icon" />浏览器底部的进度胶囊显示真实解析与填入计数。运行时有流光，完成时为绿色，错误时为红色；结束后短暂显示再隐藏。暂停后请通过原任务控制继续，动效不会代替任务进度。</p>
        <dl>
          <dt>抓不到题目</dt><dd>确认已开启真实 WebView、正在题目标签、页面加载完成且题干可见，再重新获取题目。</dd>
          <dt>回答不完整或无法入库</dt><dd>等待网站生成结束，复制完整 JSON；核对 requestId 与当前提示词一致、题目 ID 无缺失和重复。保留 <code>##</code> 多空分隔符。</dd>
          <dt>原题比对失败</dt><dd>页面或选项变化后重新抓题并生成；此前已入库的答案仍可通过题库查询使用。</dd>
          <dt>接口失败或 Token 没有增长</dt><dd>检查服务商地址、模型、认证和额度。Token 页仅记录接口实际返回的 usage，网页 AI 聊天与未返回 usage 的接口不会计入。</dd>
          <dt>需要查看具体错误</dt><dd>查看右侧“错误报告”“运行记录”和底部日志，结合失败时的页面与任务状态排查。</dd>
        </dl>
      </div>
    </details>
  </div>;
}
