import { ipcRenderer, webFrame } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type {
  AnswerApplyPayload,
  AutomationPlan,
  AutomationStep,
  ChapterLearningCommand
} from './preload-webview/types';
import { installBridgeErrorHandlers } from './preload-webview/bridge';
import { dispatchInput } from './preload-webview/dom-utils';
import { captureSnapshot } from './preload-webview/snapshot';
import { handleChapterLearningCommand, installChapterFrameMessageHandler } from './preload-webview/chapter-learning';
import { extractQuestions } from './preload-webview/question-extractor';
import { syncAnswersBeforeSave } from './preload-webview/submit-sync';
import { clickNextExamQuestion } from './preload-webview/exam-flow';
import { installBrowserNavigationPatch } from './preload-webview/navigation';
import { applyAnswerV2 } from './preload-webview/answer-applier';
import { loadFontMap } from './preload-webview/font-decode';

installBridgeErrorHandlers();
installChapterFrameMessageHandler();
installBrowserNavigationPatch(syncAnswersBeforeSave);
// 超星字体反爬映射表预加载：抓题前异步拉取，extractQuestions 调用时同步命中
void loadFontMap();

// GM_xmlhttpRequest 运行在页面主世界，而章节脚本经常需要跨超星子域名请求。
// 通过 DOM 事件把请求交给 preload，再由主进程使用 WebView session 代理，避免页面 fetch 的 CORS 限制。
const pendingGmRequests = new Map<string, boolean>();
window.addEventListener('cx:gm-xhr-call', (event) => {
  const detail = (event as CustomEvent).detail || {};
  const requestId = String(detail.requestId || '');
  const url = String(detail.url || '');
  if (!requestId || !url) return;
  pendingGmRequests.set(requestId, true);
  void ipcRenderer.invoke('cx:api-fetch', {
    requestId,
    url,
    method: detail.method,
    headers: detail.headers,
    body: detail.body,
    pageUrl: detail.pageUrl || window.location.href,
    userAgent: detail.userAgent || navigator.userAgent
  }).then((result) => {
    if (!pendingGmRequests.get(requestId)) return;
    window.dispatchEvent(new CustomEvent('cx:gm-xhr-result', { detail: { requestId, ...(result || {}) } }));
  }).catch((error: any) => {
    if (!pendingGmRequests.get(requestId)) return;
    window.dispatchEvent(new CustomEvent('cx:gm-xhr-result', {
      detail: { requestId, success: false, error: error?.message || String(error), statusText: '代理请求失败' }
    }));
  }).finally(() => {
    pendingGmRequests.delete(requestId);
  });
});
window.addEventListener('cx:gm-xhr-abort', (event) => {
  const requestId = String((event as CustomEvent).detail?.requestId || '');
  if (!requestId) return;
  pendingGmRequests.delete(requestId);
  ipcRenderer.send('cx:api-fetch-abort', requestId);
});

let embeddedChapterUserscriptSource: string | null = null;

function getEmbeddedChapterUserscriptSource() {
  if (embeddedChapterUserscriptSource !== null) return embeddedChapterUserscriptSource;
  try {
    embeddedChapterUserscriptSource = fs.readFileSync(path.join(__dirname, 'preload-webview', 'chaoxing-chapter-userscript.js'), 'utf8');
  } catch {
    embeddedChapterUserscriptSource = '';
  }
  return embeddedChapterUserscriptSource;
}

async function runEmbeddedChapterUserscript() {
  const source = getEmbeddedChapterUserscriptSource();
  if (!source) return { success: false, error: '内置章节脚本文件不存在。' };
  const allowedHosts = [
    'cx.icodef.com', 'api.tikuhai.com', 'sso.chaoxing.com', 'mooc1-api.chaoxing.com',
    'mooc1-1.chaoxing.com', 'mooc1-2.chaoxing.com', 'mooc2-ans.chaoxing.com',
    'cdn.bootcdn.net', 'cdnjs.cloudflare.com', 'mooc1.chaoxing.com', 'chaoxing.com',
    'fystat-ans.chaoxing.com', 'stat2-ans.chaoxing.com', 'mooc1.gdhkmooc.com',
    'mooc2-ans.hnsyu.net', 'mooc1.hnsyu.net', 'mooc1.hlju.edu.cn', 'forestpolice.org',
    'muketool.com', 'ocsjs.com', 'lib.baomitu.com', 'mirrors.sustech.edu.cn'
  ];
  try {
    return await webFrame.executeJavaScript(`(async () => {
      if (window.__studyPilotEmbeddedChapterUserscript) return { success: true, reused: true };
      const allowedHosts = ${JSON.stringify(allowedHosts)};
      const isAllowed = (rawUrl) => { try { const host = new URL(String(rawUrl), location.href).hostname.toLowerCase(); return allowedHosts.includes(host); } catch { return false; } };
      const loadScript = (url) => new Promise((resolve, reject) => { if (!isAllowed(url)) return reject(new Error('脚本依赖域名不在白名单中。')); const script = document.createElement('script'); script.src = url; script.onload = resolve; script.onerror = () => reject(new Error('依赖加载失败：' + url)); (document.head || document.documentElement).appendChild(script); });
      const values = Object.create(null), resources = Object.create(null);
      window.GM_info = { script: { name: 'StudyPilot 章节学习', version: 'embedded-1.0.0' } }; window.unsafeWindow = window;
      window.GM_getValue = (key, fallback) => Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback;
      window.GM_setValue = (key, value) => { values[key] = value; };
      window.GM_addStyle = (css) => { const style = document.createElement('style'); style.textContent = css || ''; (document.head || document.documentElement).appendChild(style); };
      window.GM_getResourceText = (name) => resources[name] || '';
       window.GM_xmlhttpRequest = (details) => { if (!details || !isAllowed(details.url)) return details?.onerror?.({ error: '请求域名不在白名单中。', statusText: 'blocked' }); const requestId = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('gm-' + Date.now() + '-' + Math.random().toString(16).slice(2)); let cancelled = false; const onResult = (event) => { const result = event.detail || {}; if (result.requestId !== requestId || cancelled) return; window.removeEventListener('cx:gm-xhr-result', onResult); if (result.success === false) return details.onerror && details.onerror({ error: result.error || '代理请求失败。', statusText: result.statusText || 'error' }); const text = String(result.text || ''); details.onload && details.onload({ status: result.status || 0, statusText: result.statusText || '', responseText: text, response: new Blob([text]), finalUrl: result.finalUrl || details.url, responseHeaders: result.responseHeaders || '' }); }; window.addEventListener('cx:gm-xhr-result', onResult); window.dispatchEvent(new CustomEvent('cx:gm-xhr-call', { detail: { requestId, url: details.url, method: details.method || 'GET', headers: details.headers || {}, body: details.data, pageUrl: location.href, userAgent: navigator.userAgent } })); return { abort() { if (cancelled) return; cancelled = true; window.removeEventListener('cx:gm-xhr-result', onResult); window.dispatchEvent(new CustomEvent('cx:gm-xhr-abort', { detail: { requestId } })); } }; };
      await loadScript('https://lib.baomitu.com/jquery/3.6.0/jquery.min.js');
      await loadScript('https://mirrors.sustech.edu.cn/cdnjs/ajax/libs/layx/2.5.4/layx.min.js');
      await loadScript('https://mirrors.sustech.edu.cn/cdnjs/ajax/libs/blueimp-md5/2.19.0/js/md5.min.js');
      for (const [name, url] of Object.entries({ layxcss: 'https://mirrors.sustech.edu.cn/cdnjs/ajax/libs/layx/2.5.4/layx.min.css', layuicss: 'https://mirrors.sustech.edu.cn/cdnjs/ajax/libs/layui/2.12.0/css/layui.min.css' })) {
        if (isAllowed(url)) { try { resources[name] = await (await fetch(url, { credentials: 'include' })).text(); } catch {} }
      }
      // executeJavaScript 在 preload 隔离世界执行；仅在这里设置 window.GM_*，
      // 页面插入的 script 仍然位于 main world，因此必须把 API 实现在同一个 inline script 中。
      const sourceCode = '(function(){\\n' +
        'if (window.__studyPilotEmbeddedChapterUserscript) return;\\n' +
        'const __values = Object.create(null);\\n' +
        'const __resources = ' + JSON.stringify(resources) + ';\\n' +
        'const __allowedHosts = ' + JSON.stringify(allowedHosts) + ';\\n' +
        'const __allowed = (raw) => { try { const u = new URL(String(raw || ""), location.href); return (u.protocol === "http:" || u.protocol === "https:") && __allowedHosts.some((h) => u.hostname === h || u.hostname.endsWith("." + h)); } catch (_) { return false; } };\\n' +
        'window.unsafeWindow = window;\\n' +
        'window.GM_info = { script: { name: "StudyPilot 章节学习", version: "embedded-1.0.0" } };\\n' +
        'window.GM_getValue = (key, fallback) => Object.prototype.hasOwnProperty.call(__values, key) ? __values[key] : fallback;\\n' +
        'window.GM_setValue = (key, value) => { __values[key] = value; };\\n' +
        'window.GM_addStyle = (css) => { const style = document.createElement("style"); style.textContent = css || ""; (document.head || document.documentElement).appendChild(style); return style; };\\n' +
        'window.GM_getResourceText = (name) => __resources[name] || "";\\n' +
        'const __gmResultListeners = new Map();\\n' +
        'window.addEventListener("cx:gm-xhr-result", (event) => { const result = event.detail || {}; const listener = __gmResultListeners.get(result.requestId); if (listener) listener(result); });\\n' +
        'window.GM_xmlhttpRequest = (details) => { if (!details || !__allowed(details.url)) { details && details.onerror && details.onerror({ error: "请求域名不在白名单中。", statusText: "blocked" }); return { abort() {} }; } const requestId = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : ("gm-" + Date.now() + "-" + Math.random().toString(16).slice(2)); let cancelled = false; const listener = (result) => { if (cancelled) return; __gmResultListeners.delete(requestId); if (result.success === false) { details.onerror && details.onerror({ error: result.error || "代理请求失败。", statusText: result.statusText || "error" }); return; } const text = String(result.text || ""); details.onload && details.onload({ status: result.status || 0, statusText: result.statusText || "", responseText: text, response: new Blob([text], { type: (result.headers && (result.headers["content-type"] || result.headers["Content-Type"])) || "text/plain" }), finalUrl: result.finalUrl || details.url, responseHeaders: result.responseHeaders || "" }); }; __gmResultListeners.set(requestId, listener); window.dispatchEvent(new CustomEvent("cx:gm-xhr-call", { detail: { requestId, url: details.url, method: details.method || "GET", headers: details.headers || {}, body: details.data, pageUrl: location.href, userAgent: navigator.userAgent } })); return { abort() { if (cancelled) return; cancelled = true; __gmResultListeners.delete(requestId); window.dispatchEvent(new CustomEvent("cx:gm-xhr-abort", { detail: { requestId } })); } }; };\\n' +
        'const GM_info = window.GM_info, unsafeWindow = window, GM_getValue = window.GM_getValue, GM_setValue = window.GM_setValue, GM_addStyle = window.GM_addStyle, GM_getResourceText = window.GM_getResourceText, GM_xmlhttpRequest = window.GM_xmlhttpRequest;\\n' +
        ${JSON.stringify(source)} + '\\nwindow.__studyPilotEmbeddedChapterUserscript = true;\\n})();';
      const inline = document.createElement('script');
      inline.textContent = sourceCode;
      (document.head || document.documentElement).appendChild(inline);
      inline.remove();
      return { success: true };
    })()`, true);
  } catch (error: any) {
    return { success: false, error: error?.message || '内置章节脚本启动失败。' };
  }
}

async function setEmbeddedChapterLearningEnabled(enabled: boolean) {
  try {
    await webFrame.executeJavaScript(`sessionStorage.setItem('studypilot-chapter-userscript-enabled', ${JSON.stringify(enabled ? '1' : '0')})`, true);
  } catch {
    // 页面尚未创建文档时忽略，下一次章节导航会重新读取状态。
  }
}

async function runStep(step: AutomationStep) {
  if (step.action === 'wait') {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return;
  }
  if (!step.selector) throw new Error(`Step "${step.label}" has no selector.`);

  const element = document.querySelector(step.selector) as HTMLElement | null;
  if (!element) throw new Error(`Element not found: ${step.selector}`);

  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  await new Promise((resolve) => setTimeout(resolve, 120));

  if (step.action === 'fill') {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.focus();
      element.value = step.value || '';
      dispatchInput(element);
      return;
    }
    if (element.isContentEditable) {
      element.focus();
      element.textContent = step.value || '';
      dispatchInput(element);
      return;
    }
    throw new Error(`Element is not fillable: ${step.selector}`);
  }

  if (step.action === 'select') {
    if (element instanceof HTMLSelectElement) {
      const requested = step.value || '';
      const option = Array.from(element.options).find((item) => item.value === requested || item.text.toLowerCase().includes(requested.toLowerCase()));
      if (option) element.value = option.value;
      dispatchInput(element);
      return;
    }
    throw new Error(`Element is not a select: ${step.selector}`);
  }

  if (step.action === 'click') element.click();
}

async function executePlan(plan: AutomationPlan) {
  if (!plan.approved) return { success: false, error: 'Plan is not approved.' };
  try {
    for (const step of plan.steps) await runStep(step);
    return { success: true, message: `Executed ${plan.steps.length} steps on the active page.` };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

ipcRenderer.on('studypilot:snapshot', () => {
  try {
    ipcRenderer.sendToHost('studypilot:snapshot-result', captureSnapshot());
  } catch (error: any) {
    ipcRenderer.sendToHost('studypilot:snapshot-result', { success: false, error: error.message });
  }
});

ipcRenderer.on('studypilot:extract-question', () => {
  try {
    const questions = extractQuestions();
    if (questions.length === 0) {
      ipcRenderer.sendToHost('studypilot:question-result', { success: false, error: '未在当前页面识别到题目。' });
      return;
    }
    ipcRenderer.sendToHost('studypilot:question-result', { success: true, data: questions[0], questions });
  } catch (error: any) {
    ipcRenderer.sendToHost('studypilot:question-result', { success: false, error: error.message });
  }
});

ipcRenderer.on('studypilot:execute-plan', async (_, plan: AutomationPlan) => {
  const result = await executePlan(plan);
  ipcRenderer.sendToHost('studypilot:execute-result', result);
});

ipcRenderer.on('studypilot:apply-answer', async (_, payload: AnswerApplyPayload) => {
  try {
    const result = await applyAnswerV2(payload);
    ipcRenderer.sendToHost('studypilot:apply-answer-result', result);
  } catch (error: any) {
    ipcRenderer.sendToHost('studypilot:apply-answer-result', { success: false, error: error?.message || 'unknown' });
  }
});

ipcRenderer.on('studypilot:exam-next-question', async () => {
  try {
    const result = await clickNextExamQuestion();
    ipcRenderer.sendToHost('studypilot:exam-next-question-result', result);
  } catch (error: any) {
    ipcRenderer.sendToHost('studypilot:exam-next-question-result', { success: false, error: error.message });
  }
});

ipcRenderer.on('studypilot:chapter-learning', async (_, command: ChapterLearningCommand) => {
  try {
    if (command.action === 'start' || command.action === 'play') {
      await setEmbeddedChapterLearningEnabled(true);
      const scriptResult = await runEmbeddedChapterUserscript();
      if (scriptResult.success) {
        ipcRenderer.sendToHost('studypilot:chapter-learning-result', {
          success: true,
          data: { running: true, lastMessage: '内置油猴章节脚本已启动。' }
        });
        return;
      }
      ipcRenderer.sendToHost('studypilot:chapter-learning-result', {
        success: false,
        error: scriptResult.error || '内置油猴章节脚本启动失败。'
      });
      return;
    }
    if (command.action === 'stop' || command.action === 'pause') await setEmbeddedChapterLearningEnabled(false);
    await handleChapterLearningCommand(command, extractQuestions);
  } catch (error: any) {
    ipcRenderer.sendToHost('studypilot:chapter-learning-result', {
      success: false,
      error: error.message || '章节学习辅助执行失败。'
    });
  }
});

window.addEventListener('DOMContentLoaded', () => {
  if (!/chaoxing\.com|xuexi365\.com|gdhkmooc\.com|hnsyu\.net|hlju\.edu\.cn/i.test(location.hostname)) return;
  const chapterPage = /\/mycourse\/(?:stu|studentstudy)(?:[/?]|$)/i.test(location.pathname + location.search);
  try {
    // 章节页进入后自动显示网页内油猴浮动窗口；应用侧不再需要第二套章节控制 UI。
    if (chapterPage || sessionStorage.getItem('studypilot-chapter-userscript-enabled') === '1') {
      void runEmbeddedChapterUserscript().then((result) => {
        if (!result.success) console.error('[StudyPilot] 内置章节脚本启动失败：' + (result.error || 'unknown'));
      });
    }
  } catch {
    // 非章节页面或禁用存储时忽略自动注入。
  }
}, { once: true });

console.log('[StudyPilot] Authorized web automation bridge loaded.');
