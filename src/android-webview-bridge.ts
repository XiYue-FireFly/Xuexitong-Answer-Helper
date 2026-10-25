/** Pure DOM bridge installed at document start in every Android WebView frame. */
import { extractQuestions } from '../electron/preload-webview/question-extractor';
import { applyAnswerV2 } from '../electron/preload-webview/answer-applier';
import { clickNextExamQuestion } from '../electron/preload-webview/exam-flow';

const STATE_KEY = '__studyPilotAndroidBridge';
type FrameRequest = { kind: 'extract' | 'apply' | 'next'; payload?: any; path?: number[]; depth?: number };

if (!(window as any)[STATE_KEY]) {
  (window as any)[STATE_KEY] = true;
  const pending = new Map<string, { source: Window; complete: (value: any) => void }>();
  const frameCall = (target: Window, request: FrameRequest): Promise<any> => new Promise(resolve => {
    const id = 'frame_' + Date.now() + '_' + Math.random();
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ success: false, error: '题目子页面尚未就绪，请等待加载完成后重试。' });
    }, 2500);
    pending.set(id, { source: target, complete: value => { clearTimeout(timer); pending.delete(id); resolve(value); } });
    target.postMessage({ studyPilotFrame: 'request', id, request }, '*');
  });
  const run = async (request: FrameRequest): Promise<any> => {
    const path = request.path || [];
    if (path.length) {
      const target = window.frames[path[0]];
      if (!target) return { success: false, error: '原题目子页面已关闭，请重新抓题。' };
      return frameCall(target, { ...request, path: path.slice(1) });
    }
    if (request.kind === 'extract') {
      if ((request.depth || 0) >= 8) return { success: true, questions: [] };
      const local = document.body ? extractQuestions({ webEnhanced: true }).map(question => ({
        ...question, androidFramePath: [] as number[], androidFrameUrl: location.href,
      })) : [];
      const children = await Promise.all(Array.from({ length: window.frames.length }, (_, index) =>
        frameCall(window.frames[index], { kind: 'extract', depth: (request.depth || 0) + 1 })
          .then(result => ({ index, result }))));
      const questions = [...local];
      for (const { index, result } of children) {
        for (const question of result.questions || []) questions.push({ ...question, androidFramePath: [index, ...(question.androidFramePath || [])] });
      }
      return { success: true, questions };
    }
    if (request.kind === 'apply') {
      if (request.payload?.question?.androidFrameUrl && request.payload.question.androidFrameUrl !== location.href) {
        return { success: false, error: '原题目子页面已跳转，请重新抓题。' };
      }
      return applyAnswerV2(request.payload);
    }
    const next = await clickNextExamQuestion();
    if (next.success) return next;
    if ((request.depth || 0) >= 8) return next;
    for (let index = 0; index < window.frames.length; index++) {
      const result = await frameCall(window.frames[index], { kind: 'next', depth: (request.depth || 0) + 1 });
      if (result.success) return result;
    }
    return next;
  };

  window.addEventListener('message', event => {
    const data = event.data;
    if (data?.studyPilotFrame === 'result') {
      const entry = pending.get(data.id);
      if (entry?.source === event.source) entry.complete(data.result);
    } else if (data?.studyPilotFrame === 'request' && event.source === window.parent && window.parent !== window) {
      void run(data.request).then(result => window.parent.postMessage({ studyPilotFrame: 'result', id: data.id, result }, '*'))
        .catch(error => window.parent.postMessage({ studyPilotFrame: 'result', id: data.id, result: { success: false, error: error.message } }, '*'));
    }
  });
  const listen = (event: string, channel: string, makeRequest: (detail: any) => FrameRequest) => {
    window.addEventListener(event, ev => {
      const detail = (ev as CustomEvent).detail || {};
      void run(makeRequest(detail)).then(result => window.dispatchEvent(new CustomEvent(channel, { detail: { ...result, requestId: detail.requestId } })))
        .catch(error => window.dispatchEvent(new CustomEvent(channel, { detail: { requestId: detail.requestId, success: false, error: error.message } })));
    });
  };
  listen('studypilot:android-extract', 'studypilot:android-extract-result', () => ({ kind: 'extract' }));
  listen('studypilot:android-apply', 'studypilot:android-apply-result', detail => ({ kind: 'apply', payload: detail.payload, path: detail.payload?.question?.androidFramePath }));
  listen('studypilot:android-exam-next', 'studypilot:android-exam-next-result', () => ({ kind: 'next' }));
}
