import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { sendWebPrompt, WebAISendError } from '../src/webAI/sendPrompt';
import type { WebPageState } from '../src/webAI/browserBridge';

const draft: WebPageState = { ready: true, busy: false, text: 'previous answer', inputText: 'prompt' };
const generating: WebPageState = { ready: true, busy: true, text: 'previous answer', inputText: '' };

function scenario() {
  let time = 0;
  let cancelled = false;
  const messages: string[] = [];
  return {
    messages,
    cancel: () => { cancelled = true; },
    options: {
      baseline: draft.text,
      now: () => time,
      wait: async () => { time += 500; },
      checkCancelled: () => { if (cancelled) throw new Error('cancelled'); },
      onManualSend: (message: string) => { messages.push(message); }
    }
  };
}

describe('Web AI send acknowledgement', () => {
  it('sends a TXT after a long upload without asking for manual sending', async () => {
    const test = scenario();
    let clicks = 0;
    await sendWebPrompt({ ...test.options,
      inspect: async () => clicks ? generating : { ...draft, inputText: '', promptReady: true, attachmentState: test.options.now() < 30000 ? 'pending' : 'ready' },
      send: async () => {
        if (test.options.now() < 30000) return { ...draft, attempted: false, attachmentState: 'pending' };
        clicks++; return { ...draft, attempted: true };
      }
    });
    assert.equal(clicks, 1);
    assert.equal(test.messages.length, 0);
  });
  it('does not acknowledge an attachment still present in the composer as sent', async () => {
    const test = scenario();
    await assert.rejects(sendWebPrompt({ ...test.options,
      inspect: async () => ({ ...generating, attachmentState: 'ready', promptReady: true }),
      send: async () => ({ ...draft, attempted: true })
    }), WebAISendError);
  });
  it('starts a fresh send window after a TXT changes from ready to uploading to ready', async () => {
    const test = scenario();
    let calls = 0;
    let sent = false;
    await sendWebPrompt({ ...test.options,
      inspect: async () => sent ? generating : { ...draft, inputText: '', promptReady: true,
        attachmentState: calls > 0 && test.options.now() < 30000 ? 'pending' : 'ready' },
      send: async () => {
        calls++;
        if (test.options.now() < 30000) return { ...draft, attempted: false, attachmentState: 'pending' };
        sent = true; return { ...draft, attempted: true };
      }
    });
    assert.equal(calls, 2);
    assert.equal(sent, true);
    assert.equal(test.messages.length, 0);
  });
  it('waits for a disabled button to enable instead of aborting after 600ms', async () => {
    const test = scenario();
    let clicks = 0;
    await sendWebPrompt({ ...test.options,
      inspect: async () => clicks ? generating : draft,
      send: async () => {
        if (test.options.now() < 2500) return { ...draft, attempted: false, reason: 'button disabled' };
        clicks++;
        return { ...draft, attempted: true };
      }
    });
    assert.equal(clicks, 1);
    assert.ok(test.options.now() >= 2500);
    assert.equal(test.messages.length, 0);
  });

  it('does not treat an ignored click as success or repeat a submission', async () => {
    const test = scenario();
    let clicks = 0;
    await assert.rejects(sendWebPrompt({ ...test.options,
      inspect: async () => draft,
      send: async () => { clicks++; return { ...draft, attempted: true }; }
    }), WebAISendError);
    assert.equal(clicks, 1);
    assert.equal(test.messages.length, 1);
  });

  it('resumes automatically after the user sends manually', async () => {
    const test = scenario();
    let attempts = 0;
    await sendWebPrompt({ ...test.options,
      inspect: async () => test.options.now() >= 20000 ? generating : draft,
      send: async () => { attempts++; return { ...draft, attempted: true }; }
    });
    assert.equal(attempts, 1);
    assert.equal(test.messages.length, 1);
  });

  it('does not send again if the user already sent before the first check', async () => {
    const test = scenario();
    let attempts = 0;
    await sendWebPrompt({ ...test.options,
      inspect: async () => generating,
      send: async () => { attempts++; return draft; }
    });
    assert.equal(attempts, 0);
  });

  it('requires response activity, not merely an empty input or missing composer', async () => {
    for (const state of [{ ...draft, inputText: '' }, { ...generating, ready: false, inputText: undefined }]) {
      const test = scenario();
      await assert.rejects(sendWebPrompt({ ...test.options,
        inspect: async () => state,
        send: async () => ({ ...state, attempted: false })
      }), WebAISendError);
    }
  });

  it('accepts an already completed response without requiring a stop button', async () => {
    const test = scenario();
    await sendWebPrompt({ ...test.options,
      inspect: async () => ({ ...draft, inputText: '', text: 'new answer' }),
      send: async () => { throw new Error('must not send'); }
    });
  });

  it('never repeats a send after an uncertain browser acknowledgement', async () => {
    const test = scenario();
    let attempts = 0;
    await sendWebPrompt({ ...test.options,
      inspect: async () => test.options.now() >= 3000 ? generating : draft,
      send: async () => { attempts++; throw new Error('IPC timeout after click'); }
    });
    assert.equal(attempts, 1);
  });

  it('cancels before sending if stopped while inspecting', async () => {
    const test = scenario();
    let attempts = 0;
    await assert.rejects(sendWebPrompt({ ...test.options,
      inspect: async () => { test.cancel(); return draft; },
      send: async () => { attempts++; return draft; }
    }), /cancelled/);
    assert.equal(attempts, 0);
  });

  it('keeps a browser inspection failure in the nonmodal send-error path', async () => {
    const test = scenario();
    await assert.rejects(sendWebPrompt({ ...test.options,
      inspect: async () => { throw new Error('page closed'); },
      send: async () => draft
    }), WebAISendError);
  });
});
