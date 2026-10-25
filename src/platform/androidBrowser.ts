import { appStore, type QuestionItem } from '../store/appStore';
import { WEB_AI_BROWSER_EVENT, webActionScript, type WebCommand } from '../webAI/browserBridge';
import { WEB_AI_PROVIDERS } from '../webAI/protocol';
import { composerTextMatches } from '../webAI/composerText';
import { NativeWebView } from './nativeWebViewPlugin';

type RequestDetail = Record<string, any>;

export function startAndroidBrowser(): () => void {
  const listeners: [string, EventListener][] = [];
  const listen = (channel: string, operation: (detail: RequestDetail) => Promise<any>) => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      void operation(detail).then(result => detail.onComplete?.(result)).catch(error => {
        const message = error?.message || '页面操作失败。';
        appStore.setStatus('error', message);
        detail.onComplete?.({ success: false, error: message });
      });
    };
    listeners.push([channel, listener]);
    window.addEventListener(channel, listener);
  };
  const check = (detail: RequestDetail) => {
    if (detail.isCancelled?.()) throw new Error('操作已取消。');
  };
  const source = async (detail: RequestDetail) => {
    check(detail);
    const state = await NativeWebView.getState(detail.targetTabId || detail.tabId);
    if (!state.url || state.loading) throw new Error(detail.provider
      ? '网页尚未就绪，正在等待 AI 页面加载。' : '原题目页面正在加载，请等待页面就绪后重试。');
    const expectedUrl = detail.expectedUrl || (detail.resourceSource?.tabId === state.tabId ? detail.resourceSource.url : undefined);
    if (expectedUrl && expectedUrl !== state.url) throw new Error('原题目页面已跳转，请重新抓题。');
    check(detail);
    return state;
  };
  const dispatch = async (detail: RequestDetail, event: string, resultChannel: string, payload = {}) => {
    const state = await source(detail);
    await NativeWebView.injectBridge(state.tabId);
    check(detail);
    const result = await NativeWebView.dispatchBridgeEvent({ event, resultChannel, detail: payload, tabId: state.tabId });
    check(detail);
    if (!result.success) throw new Error(result.error || '页面操作失败。');
    return { result, state };
  };
  const extract = async (detail: RequestDetail) => {
    appStore.setStatus('extracting_question', '正在从当前浏览器页面抓取题目。');
    const { result, state } = await dispatch(detail, 'studypilot:android-extract', 'studypilot:android-extract-result');
    const questions = (result.questions || []).filter(Boolean).map((question: any, index: number): QuestionItem => ({
      ...question, id: question.id || question.hash, index: question.index || index + 1,
      type: question.type || 'unknown', source: 'webview', pageUrl: state.url, capturedAt: Date.now(),
    }));
    if (!questions.length) throw new Error('当前页面未识别到题目，请打开具体作业或考试题目页后重试。');
    appStore.setQuestions(questions);
    appStore.setStatus('done', `题目抓取完成，共 ${questions.length} 题。`);
    return { ...result, questions, data: questions[0] };
  };
  listen('studypilot:extract-question-request', extract);
  listen('studypilot:automation-action', async detail => detail.action === 'extract-question' ? extract(detail) : { success: false, error: '不支持的操作。' });
  listen('studypilot:apply-answers', async detail => {
    check(detail);
    if (!detail.items?.length) throw new Error('没有可填入的答案。');
    const original = await source({ ...detail, expectedUrl: detail.expectedUrl || detail.items[0].question.pageUrl });
    await NativeWebView.focusTab(original.tabId);
    check(detail);
    window.dispatchEvent(new CustomEvent('studypilot:show-source', { detail: { tabId: original.tabId } }));
    const results = [];
    for (const item of detail.items) {
      const { result } = await dispatch({ ...detail, expectedUrl: detail.expectedUrl || item.question.pageUrl },
        'studypilot:android-apply', 'studypilot:android-apply-result', { payload: {
          questionHash: item.question.hash, question: item.question, answer: item.answer.answer,
          choiceLabels: item.answer.choiceLabels, matchedOptions: item.answer.matchedOptions,
        } });
      results.push(result);
    }
    return { success: true, results };
  });
  listen('studypilot:exam-next-question', async detail =>
    (await dispatch(detail, 'studypilot:android-exam-next', 'studypilot:android-exam-next-result')).result);
  listen(WEB_AI_BROWSER_EVENT, async request => {
    const detail = request as WebCommand;
    check(detail);
    if (detail.action === 'open') {
      const provider = WEB_AI_PROVIDERS.find(item => item.id === detail.provider);
      if (!provider) throw new Error('请选择 AI 网站。');
      return NativeWebView.createTab(provider.url);
    }
    if (detail.action === 'focus') {
      if (!detail.tabId) throw new Error('没有可切换的标签页。');
      return NativeWebView.focusTab(detail.tabId);
    }
    const state = await source(detail);
    if (detail.action === 'source') {
      if (detail.sessionId && detail.resourceSource) {
        const original = await source({ ...detail, tabId: detail.resourceSource.tabId, expectedUrl: detail.resourceSource.url });
        await NativeWebView.leaseWebAITask({ sessionId: detail.sessionId, sourceTabId: original.tabId, sourceUrl: original.url });
      }
      return { tabId: state.tabId, url: state.url };
    }
    const { result } = await NativeWebView.executeScript(webActionScript(detail, composerTextMatches), state.tabId);
    check(detail);
    const parsed = typeof result === 'string' ? JSON.parse(result) : result;
    if (detail.action === 'send' && parsed?.needsEnter) {
      check(detail);
      await NativeWebView.sendEnter(state.tabId);
      return { ...parsed, attempted: true, needsEnter: false };
    }
    return parsed;
  });
  return () => listeners.forEach(([channel, listener]) => window.removeEventListener(channel, listener));
}
