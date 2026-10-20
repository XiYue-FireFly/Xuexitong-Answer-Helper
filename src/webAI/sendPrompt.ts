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
  requireAttachmentReceipt?: boolean;
  now?: () => number;
}) {
  const now = options.now || Date.now;
  const started = now();
  let attempted = false;
  let notified = false;
  let reason = '';
  let readySince: number | null = null;
  // Let the site's input handler commit its composer state before the first send.
  await options.wait();
  while (now() - started < 120000) {
    options.checkCancelled();
    let state: WebPageState;
    try { state = await options.inspect(); }
    catch (error) { options.checkCancelled(); throw new WebAISendError(`无法确认发送状态：${(error as Error).message}`); }
    options.checkCancelled();
    if (state.ready && state.inputText?.trim() === '' && !state.attachmentState && (!options.requireAttachmentReceipt || state.sentReceipt === true) && (state.busy || Boolean(state.text && state.text !== options.baseline))) return;
    if (state.attachmentState === 'failed') throw new WebAISendError('附件上传失败，请在网页重试上传后点击“重试”。');
    if (state.attachmentState === 'pending') { if (!attempted) readySince = null; await options.wait(); continue; }
    readySince ??= now();
    if (!attempted && now() - readySince < 15000) {
      try {
        const result = await options.send();
        attempted = Boolean(result.attempted);
        if (!attempted && result.attachmentState === 'pending') readySince = null;
        reason = result.reason || reason;
      } catch (error) {
        // A lost acknowledgement can follow a successful click. Do not resend.
        attempted = true;
        reason = (error as Error).message;
      }
      options.checkCancelled();
    }
    if (readySince !== null && now() - readySince >= 15000 && !notified) {
      notified = true;
      options.onManualSend(`${reason || '尚未确认发送成功。'}请检查网页发送状态，确认后将自动检测并提取回答。`);
    }
    await options.wait();
  }
  throw new WebAISendError('未确认提示词已发送，已保留网页和提示词。请检查网页后点击“重试”。');
}
