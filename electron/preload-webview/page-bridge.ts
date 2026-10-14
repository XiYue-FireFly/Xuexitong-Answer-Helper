// 页面上下文桥：preload 运行在隔离世界（contextIsolation=yes），
// 页面自身的全局函数（setBlankAnswer/UE.getEditor 等）对 preload 不可见，
// 直接 `window.xxx` 调用恒为 undefined（死代码）。
// 本模块把调用转发给注入页面上下文的脚本执行，通过 CustomEvent 双向通信。
//
// 请求体为字符串 JSON，结果统一回传 { requestId, ok, data?, error? }。
//
// 注：章节学习功能已移除，本桥仅保留答题填入同步与字体反爬解码所需的钩子。

type PageBridgeAction =
  | { kind: 'syncCompletion'; qid: string; value: string }
  | { kind: 'syncJudgement'; qid: string; value: string }
  | { kind: 'syncChoice'; qid: string; values: string[] }
  | { kind: 'cxReadTtfList'; urls: string[] };

interface PageBridgeResult {
  requestId: string;
  ok: boolean;
  action?: string;
  detail?: string;
  data?: unknown;
  error?: string;
}

let installed = false;
let requestSeq = 0;
const pending = new Map<string, (result: PageBridgeResult) => void>();

const PAGE_BRIDGE_SOURCE = `
(function () {
  if (window.__studyPilotPageBridgeInstalled) return;
  window.__studyPilotPageBridgeInstalled = true;
  function report(requestId, ok, action, detail) {
    window.dispatchEvent(new CustomEvent('studypilot:page-bridge-result', {
      detail: { requestId: requestId, ok: ok, action: action || '', detail: detail || '' }
    }));
  }
  window.addEventListener('studypilot:page-bridge-call', function (event) {
    var payload = event.detail || {};
    var requestId = payload.requestId || '';
    var action = payload.action || {};
    function reportData(ok, data, err) {
      window.dispatchEvent(new CustomEvent('studypilot:page-bridge-result', {
        detail: { requestId: requestId, ok: !!ok, data: data, error: err || '' }
      }));
    }
    try {
      switch (action.kind) {
        case 'syncCompletion': {
          var called = [];
          ['setBlankAnswer', 'setClozeTextAnswer', 'fillBlank'].forEach(function (name) {
            if (typeof window[name] === 'function') {
              try { window[name](action.qid, action.value); called.push(name); } catch (e) {}
            }
          });
          // UEditor 填空同步
          try {
            if (window.UE && typeof window.UE.getEditor === 'function') {
              var editor = window.UE.getEditor('editor' + action.qid) || window.UE.getEditor(action.qid);
              if (editor && typeof editor.setContent === 'function') {
                editor.setContent(action.value);
                called.push('UE');
              }
            }
          } catch (e) {}
          if (typeof window.answerContentChange === 'function') {
            try { window.answerContentChange(); called.push('answerContentChange'); } catch (e) {}
          }
          report(requestId, called.length > 0, 'syncCompletion', called.join(','));
          break;
        }
        case 'syncJudgement': {
          var jCalled = [];
          if (typeof window.loadAnswerSheet === 'function') {
            try { window.loadAnswerSheet(action.qid); jCalled.push('loadAnswerSheet'); } catch (e) {}
          }
          if (typeof window.answerContentChange === 'function') {
            try { window.answerContentChange(); jCalled.push('answerContentChange'); } catch (e) {}
          }
          report(requestId, jCalled.length > 0, 'syncJudgement', jCalled.join(','));
          break;
        }
        case 'syncChoice': {
          var cCalled = [];
          var values = action.values || [];
          if (typeof window.addMultipleChoice === 'function') {
            try { window.addMultipleChoice(action.qid, values.join('')); cCalled.push('addMultipleChoice'); } catch (e) {}
          } else if (typeof window.addChoice === 'function') {
            try {
              values.forEach(function (value) { window.addChoice(action.qid, value); });
              cCalled.push('addChoice');
            } catch (e) {}
          }
          if (typeof window.answerContentChange === 'function') {
            try { window.answerContentChange(); cCalled.push('answerContentChange'); } catch (e) {}
          }
          report(requestId, cCalled.length > 0, 'syncChoice', cCalled.join(','));
          break;
        }
        case 'cxReadTtfList': {
          // 串行尝试字体映射表 URL，命中即返回 JSON
          // 字体表是公开静态资源，用 credentials:'omit' 避免把超星 cookie 发给第三方域
          (function readNext(i) {
            if (i >= action.urls.length) { reportData(false, null, 'all-ttf-failed'); return; }
            fetch(action.urls[i], { credentials: 'omit' })
              .then(function (r) { return r.text(); })
              .then(function (text) {
                try { JSON.parse(text); reportData(true, text); }
                catch (e) { readNext(i + 1); }
              })
              .catch(function () { readNext(i + 1); });
          })(0);
          break;
        }
        default:
          report(requestId, false, '', 'unknown-kind');
      }
    } catch (error) {
      report(requestId, false, action.kind || '', String(error));
    }
  });
})();
`;

function injectPageBridge() {
  try {
    const script = document.createElement('script');
    script.textContent = PAGE_BRIDGE_SOURCE;
    (document.documentElement || document.head || document.body)?.appendChild(script);
    script.remove();
  } catch {
    // 注入失败时桥不可用，调用方按 ok=false 兜底
  }
}

export function installPageBridge() {
  if (installed) return;
  installed = true;
  window.addEventListener('studypilot:page-bridge-result' as any, ((event: CustomEvent) => {
    const detail = event.detail as PageBridgeResult | undefined;
    if (!detail?.requestId) return;
    const resolver = pending.get(detail.requestId);
    if (resolver) {
      pending.delete(detail.requestId);
      resolver(detail);
    }
  }) as EventListener);
  if (document.documentElement || document.head || document.body) injectPageBridge();
  else document.addEventListener('DOMContentLoaded', injectPageBridge, { once: true });
}

/** 调用页面上下文钩子；返回 null 表示桥不可用或页面无对应函数（调用方应走 DOM 兜底）。 */
export function callPageHook(action: PageBridgeAction, timeoutMs = 3000): Promise<PageBridgeResult | null> {
  installPageBridge();
  const requestId = `pb_${Date.now().toString(36)}_${(requestSeq += 1)}`;
  return new Promise((resolve) => {
    const timeoutId = window.setTimeout(() => {
      pending.delete(requestId);
      resolve(null);
    }, timeoutMs);
    pending.set(requestId, (result) => {
      window.clearTimeout(timeoutId);
      resolve(result);
    });
    window.dispatchEvent(new CustomEvent('studypilot:page-bridge-call', {
      detail: { requestId, action }
    }));
  });
}
