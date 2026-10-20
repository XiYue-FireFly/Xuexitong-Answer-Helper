import type { QuestionItem } from '../store/appStore';

export type WebMediaAttachment = { name: string; mime: string; bytes: number[]; digest: string; questionHash: string; mediaId: string };
type MediaResult = { ok: boolean; bytes?: number[]; mime?: string; digest?: string; error?: string };
export type MediaReader = (payload: { sessionId: string; questionHash: string; mediaId: string; selector: string; sourceUrl?: string }) => Promise<MediaResult>;
const cache = new Map<string, Map<string, WebMediaAttachment>>();
export function mediaFileName(question: QuestionItem, media: NonNullable<QuestionItem['media']>[number]) {
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  const extension: Record<string, string> = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
    'image/avif': 'avif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico' };
  return `sp-${safe(question.hash)}-${safe(media.id)}.${extension[media.mime || ''] || 'png'}`;
}
export function buildMediaManifest(question: QuestionItem) {
  return (question.media || []).map(media => ({ id: media.id, role: media.role, optionLabel: media.optionLabel,
    fileName: mediaFileName(question, media), alt: media.alt, caption: media.caption,
    sourceUrl: /^(?:https?:)/.test(media.sourceUrl || '') ? media.sourceUrl : undefined }));
}
export async function prepareQuestionMedia(sessionId: string, questions: QuestionItem[], reader: MediaReader,
  cancelled: () => boolean = () => false) {
  let stored = cache.get(sessionId);
  if (!stored) { stored = new Map(); cache.set(sessionId, stored); }
  const attachments: WebMediaAttachment[] = [];
  const failures: { question: QuestionItem; reason: string }[] = [];
  for (const question of questions) {
    const prepared: WebMediaAttachment[] = [];
    try {
      if ((question.media?.length || 0) > 8) throw new Error('单题图片超过当前每批 8 张的附件能力，请手动处理');
      for (const media of question.media || []) {
        if (cancelled()) throw new Error('操作已停止。');
        const key = `${question.hash}:${media.id}`;
        let attachment = stored.get(key);
        if (!attachment) {
          const result = await reader({ sessionId, questionHash: question.hash, mediaId: media.id, selector: media.selector || '', sourceUrl: media.sourceUrl });
          if (cancelled()) throw new Error('操作已停止。');
          if (!result.ok || !result.bytes?.length || !result.mime?.startsWith('image/') || !result.digest) throw new Error(result.error || '图片无法读取');
          if (result.bytes.length > 8 * 1024 * 1024) throw new Error('单张图片超过 8 MiB');
          if ([...stored.values()].reduce((sum, file) => sum + file.bytes.length, 0) + result.bytes.length > 32 * 1024 * 1024) throw new Error('任务图片超过 32 MiB');
          attachment = { name: mediaFileName(question, { ...media, mime: result.mime }), mime: result.mime, bytes: result.bytes, digest: result.digest, questionHash: question.hash, mediaId: media.id };
          stored.set(key, attachment);
        }
        prepared.push(attachment);
      }
      attachments.push(...prepared);
    } catch (error) {
      if (cancelled()) throw error;
      failures.push({ question, reason: (error as Error).message });
    }
  }
  return { attachments, failures, ready: questions.filter(question => !failures.some(item => item.question.hash === question.hash)).map(question =>
    question.media?.length ? { ...question, media: question.media.map(media => ({ ...media, mime: stored!.get(`${question.hash}:${media.id}`)?.mime })) } : question) };
}
export function releaseQuestionMedia(sessionId: string) { cache.delete(sessionId); }
