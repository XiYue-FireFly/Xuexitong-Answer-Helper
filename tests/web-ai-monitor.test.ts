import { describe, expect, it } from 'vitest';
import { waitForWebAnswer, waitForWebComposer } from '../src/webAI/pageMonitor';
import type { WebPageState } from '../src/webAI/browserBridge';

const answer = JSON.stringify({ requestId: 'current', answers: [] });
const ready: WebPageState = { ready: true, busy: false, text: '', authState: 'ready', messageKey: 'answer-1', generationState: 'unknown' };

function clock() {
  let time = 0;
  let cancelled = false;
  const notices: string[] = [];
  return {
    notices, cancel: () => { cancelled = true; },
    now: () => time,
    wait: async (ms: number) => { time += ms; },
    checkCancelled: () => { if (cancelled) throw new Error('stopped'); },
    onNotice: (message: string) => { notices.push(message); }
  };
}

describe('Web page monitor', () => {
  it('uses a writable composer without checking login state', async () => {
    const test = clock();
    let scans = 0;
    await waitForWebComposer({ ...test, inspect: async () => { scans++; return { ...ready, authState: 'required' }; } });
    expect(scans).toBe(1);
    expect(test.notices).toEqual([]);
  });

  it('allows a usable guest composer without confirming account selectors', async () => {
    const test = clock();
    let scans = 0;
    const result = await waitForWebComposer({ ...test, inspect: async () => {
      if (++scans === 4) test.cancel();
      return { ...ready, authState: 'unknown' };
    } });
    expect(result.ready).toBe(true);
    expect(scans).toBe(1);
    expect(test.notices).toEqual([]);
  });

  it('asks for retry promptly when no input appears instead of waiting for login', async () => {
    const test = clock();
    await expect(waitForWebComposer({ ...test, inspect: async () => ({ ...ready, ready: false, authState: 'required' }) })).rejects.toThrow('重试');
    expect(test.now()).toBe(0);
    expect(test.notices).toEqual([]);
  });

  it('does not prepare an explicitly disabled input while its element is still present', async () => {
    const test = clock();
    await expect(waitForWebComposer({ ...test, inspect: async () => ({ ...ready, inputEnabled: false }) })).rejects.toThrow('重试');
  });

  it('waits for a current generation to finish before using its composer', async () => {
    const test = clock();
    await waitForWebComposer({ ...test, inspect: async () => ({ ...ready, busy: test.now() < 4000 }) });
    expect(test.now()).toBe(4000);
    expect(test.notices).toEqual([]);
  });

  it('waits for busy to end even if JSON is already complete', async () => {
    const test = clock();
    const text = await waitForWebAnswer({ ...test, requestId: 'current', inspect: async () => ({ ...ready,
      text: answer, busy: test.now() < 9000, generationState: test.now() < 9000 ? 'running' : 'finished'
    }) });
    expect(text).toBe(answer);
    expect(test.now()).toBeGreaterThanOrEqual(12000);
  });

  it('resets stability when text or assistant message changes', async () => {
    const test = clock();
    await waitForWebAnswer({ ...test, requestId: 'current', inspect: async () => ({ ...ready,
      text: test.now() < 3000 ? answer.slice(0, -1) : answer,
      messageKey: test.now() < 6000 ? 'answer-1' : 'answer-2', generationState: 'finished'
    }) });
    expect(test.now()).toBeGreaterThanOrEqual(9000);
  });

  it('uses the longer stable window without a reliable finish signal', async () => {
    const test = clock();
    await waitForWebAnswer({ ...test, requestId: 'current', inspect: async () => ({ ...ready, text: answer }) });
    expect(test.now()).toBeGreaterThanOrEqual(6000);
  });

  it('returns a finished stable malformed response only for automatic recovery', async () => {
    const test = clock();
    const truncated = '{"requestId":"current","answers":[';
    const text = await waitForWebAnswer({ ...test, requestId: 'current', acceptIncomplete: true, baseline: 'old answer',
      inspect: async () => ({ ...ready, text: truncated, generationState: 'finished' }) });
    expect(text).toBe(truncated);
    expect(test.now()).toBe(3000);
  });

  it.each(['running', 'unknown'] as const)('does not recover malformed output when its state is %s', async generationState => {
    const test = clock();
    await expect(waitForWebAnswer({ ...test, requestId: 'current', acceptIncomplete: true, baseline: '', inspect: async () => {
      if (test.now() > 15000) test.cancel();
      return { ...ready, text: 'incomplete answer', generationState };
    } })).rejects.toThrow('stopped');
  });

  it('does not treat the unchanged previous answer as a malformed new response', async () => {
    const test = clock();
    await waitForWebAnswer({ ...test, requestId: 'current', acceptIncomplete: true, baseline: 'old answer',
      inspect: async () => ({ ...ready, text: test.now() < 9000 ? 'old answer' : answer, generationState: 'finished' }) });
    expect(test.now()).toBe(12000);
  });

  it.each(['\n', ' altered rendering'])('does not treat the same old message with %j as a new malformed reply', async suffix => {
    const test = clock();
    const old = '{"requestId":"old","answers":[]}';
    await waitForWebAnswer({ ...test, requestId: 'current', acceptIncomplete: true, baseline: old, baselineKey: 'old-message',
      inspect: async () => ({ ...ready, text: test.now() < 9000 ? old + suffix : answer,
        messageKey: test.now() < 9000 ? 'old-message' : 'new-message', generationState: 'finished' }) });
    expect(test.now()).toBe(12000);
  });

  it('preserves manual monitoring behavior for malformed finished output', async () => {
    const test = clock();
    await expect(waitForWebAnswer({ ...test, requestId: 'current', inspect: async () => {
      if (test.now() > 15000) test.cancel();
      return { ...ready, text: 'incomplete answer', generationState: 'finished' };
    } })).rejects.toThrow('stopped');
  });

  it('rejects old replies and prompt echoes, then accepts only the current request', async () => {
    const test = clock();
    await waitForWebAnswer({ ...test, requestId: 'current', inspect: async () => ({ ...ready,
      text: test.now() < 9000 ? answer.replace('current', 'old') : answer, generationState: 'finished'
    }) });
    expect(test.now()).toBeGreaterThanOrEqual(12000);
  });

  it('reminds after a long wait and continues until an answer arrives', async () => {
    const test = clock();
    await waitForWebAnswer({ ...test, requestId: 'current', inspect: async () => ({ ...ready,
      text: test.now() >= 310000 ? answer : '', generationState: 'finished'
    }) });
    expect(test.notices).toHaveLength(1);
    expect(test.now()).toBeGreaterThan(310000);
  });

  it('ignores an inspection result that arrives after stop', async () => {
    const test = clock();
    await expect(waitForWebAnswer({ ...test, requestId: 'current', inspect: async () => {
      test.cancel(); return { ...ready, text: answer, generationState: 'finished' };
    } })).rejects.toThrow('stopped');
  });

  it('monitors a completed response without account checks or login notices', async () => {
    const test = clock();
    await waitForWebAnswer({ ...test, requestId: 'current',
      inspect: async () => ({ ...ready, text: answer, authState: test.now() < 3000 ? 'required' : 'ready' }) });
    expect(test.notices).toEqual([]);
    expect(test.now()).toBe(6000);
  });

  it('retries transient errors but terminates after three failures', async () => {
    const test = clock();
    let calls = 0;
    await expect(waitForWebAnswer({ ...test, requestId: 'current', inspect: async () => {
      calls++; throw new Error('not loaded');
    } })).rejects.toThrow('not loaded');
    expect(calls).toBe(3);
  });
});
