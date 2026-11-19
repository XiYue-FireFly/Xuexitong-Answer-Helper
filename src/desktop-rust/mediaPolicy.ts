import type { QuestionMediaRead, WebAITaskLease } from '../../electron/web-ai-task-resources';
import { getRustHost, type RustHostTransport } from './hostClient';

/** Payloads retain the original source WebContents ID, URL, task and question
 * identities. Only native registration may establish guest/frame/document trust. */
export function createMediaPolicy(host: RustHostTransport) {
  return {
    leaseWebAITask: (payload: WebAITaskLease) => host.invoke('media:lease', payload),
    readQuestionMedia: (payload: QuestionMediaRead) => host.invoke('media:read', payload),
    releaseWebAITask: (sessionId: string) => host.invoke('media:release', sessionId),
  };
}

const installed = new WeakSet<RustHostTransport>();
/** Install before the legacy facade captures its transport. All policy still
 * executes in the frozen page functions and native source-bound resource lease. */
export function installMediaPolicy(host: RustHostTransport = getRustHost()): void {
  if (installed.has(host)) return;
  const invoke = host.invoke.bind(host);
  const channels: Record<string, string> = {
    'web-ai:lease-task': 'media:lease',
    'web-ai:read-question-media': 'media:read',
    'web-ai:release-task': 'media:release',
  };
  host.invoke = <T,>(command: string, payload?: unknown) => invoke<T>(channels[command] ?? command, payload);
  installed.add(host);
}
