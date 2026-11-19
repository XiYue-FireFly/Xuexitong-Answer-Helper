/** Transport only: the frozen Electron preload owns all page/business behavior. */
export const GUEST_PROTOCOL = 'studypilot-rust-page-v1';
export const GUEST_REQUEST_CHANNELS = [
  'studypilot:snapshot',
  'studypilot:web-document-request',
  'studypilot:web-cancel-operation',
  'studypilot:extract-question',
  'studypilot:execute-plan',
  'studypilot:apply-answer',
  'studypilot:exam-next-question',
] as const;

const RESULT_CHANNELS = new Set([
  'studypilot:snapshot-result', 'studypilot:web-document', 'studypilot:question-result',
  'studypilot:execute-result', 'studypilot:apply-answer-result', 'studypilot:exam-next-question-result',
  'studypilot:error-log', 'studypilot:click-debug', 'studypilot:open-tab',
]);

export type NativeBridgeConfig = {
  protocolVersion: 1;
  documentGeneration: number;
  /** Native binds this nonce to its actual frame/document; the nonce alone is not authority. */
  documentToken: string;
  /** Native chooses a fresh unpredictable property name for each document. It is not an authority token. */
  dispatchHook: string;
};

export type EvaluationOutcome =
  | { status: 'fulfilled'; value: { type: 'undefined' } | { type: 'json'; value: unknown } }
  | { status: 'rejected'; error: { name: string; message: string } }
  | { status: 'cancelled' | 'timeout' };

export type GuestEnvelope = {
  protocol: typeof GUEST_PROTOCOL;
  kind: 'event' | 'evaluation-result' | 'ready';
  documentGeneration: number;
  documentToken: string;
  channel: string;
  payload: unknown;
  requestToken?: string;
};

export type GuestEnvironment = {
  postMessage: (message: GuestEnvelope) => void;
  evaluate: (script: string) => unknown;
};

type LegacyListener = (event: Readonly<Record<string, never>>, ...args: any[]) => unknown;
type Evaluation = { timer: ReturnType<typeof setTimeout>; finish: (result: EvaluationOutcome) => void };

function errorDetails(error: unknown): { name: string; message: string } {
  try {
    if (error && typeof error === 'object') {
      const value = error as { name?: unknown; message?: unknown };
      return { name: String(value.name || 'Error'), message: String(value.message || error) };
    }
    return { name: 'Error', message: String(error) };
  } catch { return { name: 'Error', message: 'Page evaluation failed' }; }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Native MUST bind actual WebView/frame/current document and pending request
 * before consuming these messages. No identity supplied by this JS is trusted. */
export function createGuestTransport(configuration: NativeBridgeConfig, environment: GuestEnvironment) {
  if (!configuration || configuration.protocolVersion !== 1
      || !Number.isSafeInteger(configuration.documentGeneration) || configuration.documentGeneration < 0
      || typeof configuration.documentToken !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(configuration.documentToken)
      || !/^[A-Za-z_$][A-Za-z0-9_$]{15,159}$/.test(configuration.dispatchHook)) {
    throw new Error('Invalid native guest bridge configuration');
  }
  const generation = configuration.documentGeneration;
  const documentToken = configuration.documentToken;
  const listeners = new Map<string, LegacyListener[]>();
  const requests = new Set<string>(GUEST_REQUEST_CHANNELS);
  const evaluations = new Map<string, Evaluation>();
  const usedTokens = new Set<string>();
  const event = Object.freeze({});
  let disposed = false;
  let ready = false;

  function emit(kind: GuestEnvelope['kind'], channel: string, payload: unknown, requestToken?: string) {
    if (disposed) return;
    const envelope: GuestEnvelope = { protocol: GUEST_PROTOCOL, kind, documentGeneration: generation, documentToken, channel, payload };
    if (requestToken !== undefined) envelope.requestToken = requestToken;
    // Match the JSON wire representation of WebView2. Undefined legacy args
    // become null array entries; no claimed frame/guest/source fields are added.
    environment.postMessage(JSON.parse(JSON.stringify(envelope)) as GuestEnvelope);
  }

  const ipcRenderer = Object.freeze({
    on(channel: string, listener: LegacyListener) {
      if (!requests.has(channel) || typeof listener !== 'function' || disposed) {
        throw new Error(`Unsupported guest receive channel: ${channel}`);
      }
      listeners.set(channel, [...(listeners.get(channel) || []), listener]);
      return ipcRenderer;
    },
    sendToHost(channel: string, ...args: unknown[]) {
      if (!RESULT_CHANNELS.has(channel)) throw new Error(`Unsupported guest result channel: ${channel}`);
      emit('event', channel, args);
    },
  });

  function evaluate(message: Record<string, unknown>, nativeEvaluation?: () => unknown): boolean {
    const { requestToken, script, deadline } = message;
    if (typeof requestToken !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(requestToken)
        || typeof script !== 'string' || script.length > 1024 * 1024
        || typeof deadline !== 'number' || !Number.isSafeInteger(deadline)
        || deadline > Date.now() + 300_000 || usedTokens.has(requestToken)
        || usedTokens.size >= 65536 || evaluations.size >= 64) return false;
    usedTokens.add(requestToken);
    if (deadline <= Date.now()) {
      emit('evaluation-result', 'studypilot:evaluation-result', { status: 'timeout' }, requestToken);
      return true;
    }
    let settled = false;
    const finish = (result: EvaluationOutcome) => {
      if (settled) return;
      settled = true;
      const pending = evaluations.get(requestToken);
      if (pending) clearTimeout(pending.timer);
      evaluations.delete(requestToken);
      emit('evaluation-result', 'studypilot:evaluation-result', result, requestToken);
    };
    const timer = setTimeout(() => finish({ status: 'timeout' }), Math.max(0, deadline - Date.now()));
    evaluations.set(requestToken, { timer, finish });
    try {
      // Cancellation stops observation of a result; it cannot roll back page
      // side effects or interrupt JS already executing in the page.
      // Native embeds a callable in ExecuteScript so strict page CSP does not
      // require unsafe-eval. String evaluation is a compatibility fallback.
      Promise.resolve(nativeEvaluation ? nativeEvaluation() : environment.evaluate(script)).then(value => {
        if (settled) return;
        if (Date.now() >= deadline) { finish({ status: 'timeout' }); return; }
        if (value === undefined) { finish({ status: 'fulfilled', value: { type: 'undefined' } }); return; }
        try {
          if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-finite result');
          const json = JSON.stringify(value);
          if (json === undefined) throw new Error('Non-JSON result');
          finish({ status: 'fulfilled', value: { type: 'json', value: JSON.parse(json) } });
        } catch (error) {
          finish({ status: 'rejected', error: { name: 'SerializationError', message: errorDetails(error).message } });
        }
      }, error => finish(Date.now() >= deadline ? { status: 'timeout' } : { status: 'rejected', error: errorDetails(error) }));
    } catch (error) {
      finish(Date.now() >= deadline ? { status: 'timeout' } : { status: 'rejected', error: errorDetails(error) });
    }
    return true;
  }

  /** Native calls this property with a serialized object, never page DOM events. */
  function dispatch(message: unknown, nativeEvaluation?: () => unknown): boolean {
    if (disposed || !record(message) || message.documentGeneration !== generation) return false;
    if (message.kind === 'ipc') {
      if (typeof message.channel !== 'string' || !requests.has(message.channel) || !Array.isArray(message.args)) return false;
      const handlers = listeners.get(message.channel);
      if (!handlers?.length) return false;
      for (const listener of handlers) {
        try {
          Promise.resolve(listener(event, ...message.args)).catch(error => {
            ipcRenderer.sendToHost('studypilot:error-log', { source: 'rust-bridge:dispatch', ...errorDetails(error) });
          });
        } catch (error) {
          ipcRenderer.sendToHost('studypilot:error-log', { source: 'rust-bridge:dispatch', ...errorDetails(error) });
        }
      }
      return true;
    }
    if (message.kind === 'evaluate') {
      if (nativeEvaluation !== undefined && typeof nativeEvaluation !== 'function') return false;
      return evaluate(message, nativeEvaluation);
    }
    if (message.kind === 'cancel' && typeof message.requestToken === 'string') {
      const pending = evaluations.get(message.requestToken);
      if (!pending) return false;
      pending.finish({ status: 'cancelled' });
      return true;
    }
    return false;
  }

  function markReady() {
    if (ready || disposed) return;
    if (GUEST_REQUEST_CHANNELS.some(channel => !listeners.has(channel))) {
      throw new Error('The frozen preload did not register every legacy receive channel');
    }
    ready = true;
    emit('ready', 'studypilot:bridge-ready', { protocolVersion: 1, requestChannels: [...GUEST_REQUEST_CHANNELS] });
  }

  function dispose() {
    if (disposed) return;
    for (const pending of [...evaluations.values()]) pending.finish({ status: 'cancelled' });
    disposed = true;
    listeners.clear();
  }

  return { ipcRenderer, webFrame: Object.freeze({}), dispatch, markReady, dispose };
}

type GuestWindow = Window & { chrome?: { webview?: { postMessage: (message: string) => void } } };

/** Install before the frozen preload runs; the generated entry calls markReady
 * only after that entry registered its original handlers and queues. */
export function createWebView2GuestTransport(configuration: NativeBridgeConfig, scope: GuestWindow = window) {
  if (Object.prototype.hasOwnProperty.call(scope, configuration.dispatchHook)) {
    throw new Error('Guest bridge already installed for this document');
  }
  const webview = scope.chrome?.webview;
  if (!webview || typeof webview.postMessage !== 'function') throw new Error('Native WebView2 page transport is unavailable');
  const postMessage = webview.postMessage.bind(webview);
  const transport = createGuestTransport(configuration, {
    // wry registers its own WebMessageReceived handler before the native frame
    // binder. It calls TryGetWebMessageAsString, so object messages can abort
    // delivery to later handlers. The binder unwraps this one JSON string.
    postMessage: envelope => postMessage(JSON.stringify(envelope)),
    evaluate: script => (0, eval)(script),
  });
  Object.defineProperty(scope, configuration.dispatchHook, {
    value: transport.dispatch, writable: false, configurable: false, enumerable: false,
  });
  scope.addEventListener('pagehide', transport.dispose, { once: true });
  return transport;
}
