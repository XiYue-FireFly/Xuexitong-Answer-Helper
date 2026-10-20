import { ipcRenderer, webFrame } from 'electron';
import type {
  AnswerApplyPayload,
  AutomationPlan,
  AutomationStep
} from './preload-webview/types';
import { installBridgeErrorHandlers } from './preload-webview/bridge';
import { dispatchInput } from './preload-webview/dom-utils';
import { captureSnapshot } from './preload-webview/snapshot';
import { extractQuestions } from './preload-webview/question-extractor';
import { syncAnswersBeforeSave } from './preload-webview/submit-sync';
import { clickNextExamQuestion } from './preload-webview/exam-flow';
import { installBrowserNavigationPatch } from './preload-webview/navigation';
import { applyAnswerV2 } from './preload-webview/answer-applier';
import { loadFontMap } from './preload-webview/font-decode';

// 章节学习功能已移除：本 preload 只保留答题辅助相关的页面桥接。

installBridgeErrorHandlers();
installBrowserNavigationPatch(syncAnswersBeforeSave);
// 超星字体反爬映射表预加载：抓题前异步拉取，extractQuestions 调用时同步命中
void loadFontMap();

// 保留 webFrame 引用占位：未来如需在 preload 隔离世界执行脚本可复用。
void webFrame;

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

let webDocumentId = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
ipcRenderer.on('studypilot:web-document-request', (_, renew?: boolean) => {
  if (renew) webDocumentId = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  ipcRenderer.sendToHost('studypilot:web-document', webDocumentId);
});
let webApplyQueue: Promise<unknown> = Promise.resolve();
const cancelledWebOperations = new Set<string>();
ipcRenderer.on('studypilot:web-cancel-operation', (_, operationId: string) => {
  cancelledWebOperations.add(operationId);
  setTimeout(() => cancelledWebOperations.delete(operationId), 60000);
});
function webReply(payload: any, result: Record<string, unknown>) {
  return payload?.operationId ? { ...result, sessionId: payload.sessionId, operationId: payload.operationId, targetTabId: payload.targetTabId, documentId: webDocumentId } : result;
}
ipcRenderer.on('studypilot:extract-question', (_, payload?: any) => {
  try {
    if (payload?.operationId && payload.documentId !== webDocumentId) throw new Error('原题目页面已重新加载。');
    const questions = extractQuestions(payload?.sessionId ? { webEnhanced: true } : undefined);
    if (questions.length === 0) {
      ipcRenderer.sendToHost('studypilot:question-result', webReply(payload, { success: false, error: '未在当前页面识别到题目。' }));
      return;
    }
    ipcRenderer.sendToHost('studypilot:question-result', webReply(payload, { success: true, data: questions[0], questions }));
  } catch (error: any) {
    ipcRenderer.sendToHost('studypilot:question-result', webReply(payload, { success: false, error: error.message }));
  }
});

ipcRenderer.on('studypilot:execute-plan', async (_, plan: AutomationPlan) => {
  const result = await executePlan(plan);
  ipcRenderer.sendToHost('studypilot:execute-result', result);
});

ipcRenderer.on('studypilot:apply-answer', (_, payload: AnswerApplyPayload & { operationId?: string; documentId?: string; expiresAt?: number }) => {
  const apply = async () => {
  try {
    if (payload?.operationId && payload.documentId !== webDocumentId) throw new Error('原题目页面已重新加载。');
    if (payload.operationId && (cancelledWebOperations.has(payload.operationId) || Date.now() >= (payload.expiresAt || Infinity))) throw new Error('填入操作已取消或超时。');
    const result = await applyAnswerV2(payload);
    ipcRenderer.sendToHost('studypilot:apply-answer-result', webReply(payload, result));
  } catch (error: any) {
    ipcRenderer.sendToHost('studypilot:apply-answer-result', webReply(payload, { success: false, error: error?.message || 'unknown' }));
  }
  finally { if (payload.operationId) cancelledWebOperations.delete(payload.operationId); }
  };
  // A cancelled host request may finish before the page editor finishes. Keep
  // this page-side barrier until the underlying write has actually settled.
  if (payload.operationId) webApplyQueue = webApplyQueue.catch(() => undefined).then(apply);
  else void apply();
});

ipcRenderer.on('studypilot:exam-next-question', async () => {
  try {
    const result = await clickNextExamQuestion();
    ipcRenderer.sendToHost('studypilot:exam-next-question-result', result);
  } catch (error: any) {
    ipcRenderer.sendToHost('studypilot:exam-next-question-result', { success: false, error: error.message });
  }
});

console.log('[StudyPilot] Authorized web automation bridge loaded.');
