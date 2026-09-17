import type { WebPageState } from './browserBridge';

export class WebAISendError extends Error {}

// An attempted click/key press is not an acknowledgement from the website.
export async function sendWebPrompt(options: {
  inspect: () => Promise<WebPageState>;
  send: () => Promise<WebPageState>;
  wait: () => Promise<void>;
  checkCancelled: () => void;
  onManualSend: (message: string) => void;
  baseline: string;
  now?: () => number;
}) {
  const now = options.now || Date.now;
  const started = now();
  let attempted = false;
  let notified = false;
  let reason = '';
  // Let the site's input handler commit its composer state before the first send.
  await options.wait();
  while (now() - started < 120000) {
    options.checkCancelled();
    let state: WebPageState;
    try { state = await options.inspect(); }
    catch (error) { options.checkCancelled(); throw new WebAISendError(`无法确认发送状态：${(error as Error).message}`); }
    options.checkCancelled();
    if (state.ready && state.inputText?.trim() === '' && (state.busy || Boolean(state.text && state.text !== options.baseline))) return;
    if (!attempted && now() - started < 15000) {
      try {
        const result = await options.send();
        attempted = Boolean(result.attempted);
        reason = result.reason || reason;
      } catch (error) {
        // A lost acknowledgement can follow a successful click. Do not resend.
        attempted = true;
        reason = (error as Error).message;
      }
      options.checkCancelled();
    }
    if (now() - started >= 15000 && !notified) {
      notified = true;
      options.onManualSend(`${reason || '尚未确认发送成功。'}请在网页点击发送，回答完成后点击“提取答案”。`);
    }
    await options.wait();
  }
  throw new WebAISendError('未确认提示词已发送，已保留网页和提示词。请在网站发送后点击“提取答案”。');
}
