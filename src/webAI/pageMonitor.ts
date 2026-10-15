import type { WebPageState } from './browserBridge';
import { hasCompleteWebResponse } from './protocol';

type MonitorOptions = {
  inspect: () => Promise<WebPageState>;
  wait: (milliseconds: number) => Promise<void>;
  checkCancelled: () => void;
  onNotice: (message: string) => void;
  now?: () => number;
};

function reminder(options: MonitorOptions, firstMessage?: string) {
  const now = options.now || Date.now;
  let next = now() + 300000;
  if (firstMessage) options.onNotice(firstMessage);
  return (message: string) => {
    if (now() < next) return;
    options.onNotice(message);
    next = now() + 600000;
  };
}

function reader(options: MonitorOptions) {
  let failures = 0;
  return async (): Promise<WebPageState | null> => {
    options.checkCancelled();
    try {
      const state = await options.inspect();
      options.checkCancelled();
      failures = 0;
      return state;
    } catch (error) {
      options.checkCancelled();
      if (/原标签已关闭|当前标签不是所选|未知网页|已崩溃/.test((error as Error).message) || ++failures >= 3) throw error;
      await options.wait(2000 * 2 ** (failures - 1));
      options.checkCancelled();
      return null;
    }
  };
}

export async function waitForWebComposer(options: MonitorOptions): Promise<WebPageState> {
  const inspect = reader(options);
  const remind = reminder(options);
  for (;;) {
    const state = await inspect();
    if (!state) continue;
    if (!state.ready) throw new Error('未检测到 AI 网页输入框，请等待页面加载完成后点击“重试”。');
    if (!state.busy && state.inputEnabled === false) throw new Error('AI 网页输入框暂不可输入，请检查页面后点击“重试”。');
    if (!state.busy) return state;
    remind('AI 网页仍在生成，请查看网页；当前回答结束后继续。');
    await options.wait(2000);
    options.checkCancelled();
  }
}

export async function waitForWebAnswer(options: MonitorOptions & { requestId: string }): Promise<string> {
  const now = options.now || Date.now;
  const inspect = reader(options);
  const remind = reminder(options);
  let lastText = '';
  let lastKey = '';
  let stableSince = now();
  let samples = 0;
  for (;;) {
    const state = await inspect();
    if (!state) { samples = 0; continue; }
    const complete = hasCompleteWebResponse(state.text, options.requestId);
    const key = state.messageKey || 'assistant';
    const candidate = complete && !state.busy && state.generationState !== 'running';
    if (!candidate || state.text !== lastText || key !== lastKey) {
      stableSince = now();
      samples = candidate ? 1 : 0;
      lastText = state.text;
      lastKey = key;
    } else samples++;
    const windowMs = state.generationState === 'finished' ? 3000 : 6000;
    if (candidate && samples >= 3 && now() - stableSince >= windowMs) return state.text;
    remind(state.busy ? 'AI 仍在生成，已等待较长时间，请查看 AI 网页。' : '长时间未获取完整答案，请查看 AI 网页。');
    await options.wait(1500);
    options.checkCancelled();
  }
}
