export type WebPageOperation = { sessionId: string; operationId: string; targetTabId: string; documentId: string };
type Reply = Record<string, any> & Partial<WebPageOperation>;

// Web requests have their own routes. Legacy API requests never enter this registry.
export class WebPageRequestRegistry {
  private documents = new Map<string, string>();
  private pending = new Map<string, { operation: WebPageOperation; channel: string; settle: (value: Reply) => void }>();
  private queues = new Map<string, Promise<unknown>>();
  documentFor(tabId: string) { return this.documents.get(tabId); }
  setDocument(tabId: string, documentId: string) {
    if (this.documents.get(tabId) !== documentId) this.cancelTab(tabId, '原题目页面正在重新加载，等待页面就绪后重试。');
    this.documents.set(tabId, documentId);
  }
  cancelTab(tabId: string, error = '原题目页面已关闭。') {
    this.documents.delete(tabId);
    for (const entry of [...this.pending.values()]) if (entry.operation.targetTabId === tabId) entry.settle({ success: false, error });
  }
  cancelSession(sessionId: string) {
    for (const entry of [...this.pending.values()]) if (entry.operation.sessionId === sessionId) entry.settle({ success: false, error: '操作已停止。' });
  }
  resolve(tabId: string, channel: string, reply: Reply) {
    const entry = reply?.operationId ? this.pending.get(reply.operationId) : undefined;
    if (!entry || channel !== entry.channel || tabId !== entry.operation.targetTabId ||
      reply.targetTabId !== entry.operation.targetTabId || reply.sessionId !== entry.operation.sessionId || reply.documentId !== entry.operation.documentId ||
      this.documents.get(tabId) !== entry.operation.documentId) return false;
    entry.settle(reply);
    return true;
  }
  request(tabId: string, sessionId: string, channel: string, payload: Record<string, unknown>,
    send: (payload: Record<string, unknown>) => void, isCancelled: () => boolean = () => false, timeout = 15000,
    cancel?: (operationId: string) => void): Promise<Reply> {
    const documentId = this.documents.get(tabId);
    if (!documentId) return Promise.resolve({ success: false, error: '原题目页面尚未就绪。' });
    if (isCancelled()) return Promise.resolve({ success: false, error: '操作已停止。' });
    const operation = { sessionId, operationId: crypto.randomUUID(), targetTabId: tabId, documentId };
    return new Promise(resolve => {
      const settle = (reply: Reply) => {
        if (!this.pending.delete(operation.operationId)) return;
        if (reply.success === false) { try { cancel?.(operation.operationId); } catch { /* A destroyed view has already stopped. */ } }
        clearTimeout(timer); clearInterval(cancelTimer); resolve(reply);
      };
      const timer = setTimeout(() => settle({ success: false, error: '原题目页面响应超时。' }), timeout);
      const cancelTimer = setInterval(() => { if (isCancelled()) settle({ success: false, error: '操作已停止。' }); }, 100);
      this.pending.set(operation.operationId, { operation, channel, settle });
      try { send({ ...payload, ...operation, expiresAt: Date.now() + timeout }); }
      catch (error) { settle({ success: false, error: (error as Error).message }); }
    });
  }
  enqueue<T>(tabId: string, action: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(tabId) || Promise.resolve()).catch(() => undefined).then(action);
    this.queues.set(tabId, next);
    void next.finally(() => { if (this.queues.get(tabId) === next) this.queues.delete(tabId); }).catch(() => undefined);
    return next;
  }
}

export const webPageRequests = new WebPageRequestRegistry();

export async function applyWebAnswers<T>(items: T[], send: (item: T) => Promise<Reply>, cancelled: () => boolean,
  wait: (milliseconds: number) => Promise<void>, onSkipped: (item: T) => void) {
  let skipped = 0;
  for (const item of items) {
    if (cancelled()) return { success: false, error: '填入已取消。' };
    let result = await send(item);
    if (!result.success && /填空答案写入后校验失败/.test(String(result.error))) {
      await wait(420);
      if (cancelled()) return { success: false, error: '填入已取消。' };
      result = await send(item);
      if (!result.success && /填空答案写入后校验失败/.test(String(result.error))) { skipped++; onSkipped(item); continue; }
    }
    if (!result.success) return result;
  }
  return { success: true, ...(skipped ? { partial: true, skipped } : {}) };
}
