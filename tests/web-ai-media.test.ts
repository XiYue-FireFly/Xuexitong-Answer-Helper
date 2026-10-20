import { describe, expect, it, vi } from 'vitest';
import { prepareQuestionMedia, releaseQuestionMedia, buildMediaManifest } from '../src/webAI/questionMedia';
import { prepareWebBatch } from '../src/webAI/protocol';
import type { QuestionItem } from '../src/store/appStore';
import { webActionScript } from '../src/webAI/browserBridge';
import { composerTextMatches } from '../src/webAI/composerText';
const question = (hash: string, count = 1): QuestionItem => ({ id: hash, hash, question: '看图作答？', options: [], type: 'essay', source: 'webview', capturedAt: 0,
  media: Array.from({ length: count }, (_, i) => ({ id: `img${i}`, role: 'stem', alt: '', selector: `#${hash}-${i}`, sourceUrl: 'https://school.test/image', status: 'discovered' })) });
describe('Web question media preparation', () => {
  it('keeps attachment file extensions consistent with actual bytes and prompt manifests', async () => {
    for (const [mime, extension] of [['image/jpeg', '.jpg'], ['image/webp', '.webp'], ['image/svg+xml', '.svg']]) {
      const item = question(extension);
      const result = await prepareQuestionMedia(`mime${extension}`, [item], async () => ({ ok: true, bytes: [1, 2], mime, digest: mime }));
      expect(result.attachments[0].name).toMatch(new RegExp(`\\${extension}$`));
      expect(buildMediaManifest(result.ready[0])[0].fileName).toBe(result.attachments[0].name);
      expect(prepareWebBatch(result.ready, 'deepseek').prompt).toContain(result.attachments[0].name);
      releaseQuestionMedia(`mime${extension}`);
    }
  });
  it('transfers image bytes only on upload, never on response polling or send', () => {
    const attachment = { name: 'img.png', mime: 'image/png', bytes: [123, 212, 56, 98], digest: 'digest', questionHash: 'hash', mediaId: 'media' };
    expect(webActionScript({ action: 'prepare', attachments: [attachment] }, composerTextMatches)).toContain('"bytes":[123,212,56,98]');
    for (const action of ['inspect', 'send'] as const) {
      const script = webActionScript({ action, attachments: [attachment] }, composerTextMatches);
      expect(script).toContain('"bytes":[]'); expect(script).not.toContain('"bytes":[123,212,56,98]');
    }
  });
  it('retains failed image questions, continues others and retries only uncached images', async () => {
    const first = question('a'); const failed = question('b'); const plain = question('plain', 0);
    let available = false;
    const reader = vi.fn(async ({ questionHash }: { questionHash: string }) => questionHash === 'b' && !available ? { ok: false, error: '403' } : { ok: true, bytes: [1, 2], mime: 'image/png', digest: questionHash });
    const initial = await prepareQuestionMedia('one', [first, failed, plain], reader);
    expect(initial.ready.map(q => q.hash)).toEqual(['a', 'plain']); expect(initial.failures[0].reason).toBe('403');
    available = true;
    const retry = await prepareQuestionMedia('one', [first, failed], reader);
    expect(retry.failures).toEqual([]); expect(reader).toHaveBeenCalledTimes(3);
    expect(retry.attachments.map(file => file.name)).toEqual([buildMediaManifest(first)[0].fileName, buildMediaManifest(failed)[0].fileName]);
    await prepareQuestionMedia('two', [first], reader); expect(reader).toHaveBeenCalledTimes(4);
    releaseQuestionMedia('one'); releaseQuestionMedia('two');
  });
  it('rejects non-image/oversize data and stale results after cancellation', async () => {
    const first = question('c');
    expect((await prepareQuestionMedia('bad', [first], async () => ({ ok: true, bytes: [1], mime: 'text/html', digest: 'bad' }))).failures).toHaveLength(1);
    let cancelled = false;
    await expect(prepareQuestionMedia('cancelled', [first], async () => { cancelled = true; return { ok: true, bytes: [1], mime: 'image/png', digest: 'c' }; }, () => cancelled)).rejects.toThrow('停止');
    expect((await prepareQuestionMedia('too-many', [question('many', 9)], async () => ({ ok: false }))).failures[0].reason).toContain('8 张');
    ['bad', 'cancelled', 'too-many'].forEach(releaseQuestionMedia);
  });
  it('splits complete image questions to the attachment budget', () => {
    const result = prepareWebBatch([question('a', 5), question('b', 4)], 'qwen');
    expect(result.batch?.questions.map(q => q.hash)).toEqual(['a']); expect(result.remaining.map(q => q.hash)).toEqual(['b']);
    expect(result.prompt).toContain('sp-a-img0.png'); expect(result.prompt).not.toContain('base64');
  });
});
