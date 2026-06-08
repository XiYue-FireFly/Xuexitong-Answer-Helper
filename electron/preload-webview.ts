import { ipcRenderer } from 'electron';
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

installBridgeErrorHandlers();
installChapterFrameMessageHandler();
installBrowserNavigationPatch(syncAnswersBeforeSave);

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
  const result = await applyAnswerV2(payload);
  ipcRenderer.sendToHost('studypilot:apply-answer-result', result);
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
    await handleChapterLearningCommand(command, extractQuestions);
  } catch (error: any) {
    ipcRenderer.sendToHost('studypilot:chapter-learning-result', {
      success: false,
      error: error.message || '章节学习辅助执行失败。'
    });
  }
});

console.log('[StudyPilot] Authorized web automation bridge loaded.');
