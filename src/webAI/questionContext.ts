import type { QuestionItem } from '../store/appStore';
import type { AnswerItem } from './protocol';

export type WebPromptReference = {
  pageTitle: string; chapterTitle?: string; sectionTitle?: string; material?: string;
  neighbours: { index: number; question: string }[];
  previousAnswers: { index: number; question: string; answer: string; source: 'page-filled' | 'web-generated' }[];
  reduced?: boolean;
};
export function stableWebQuestionKey(question: QuestionItem) {
  const ref = question.webReference;
  return ref ? JSON.stringify([ref.groupKey, ref.sourceQuestionId, question.hash]) : question.hash;
}
export function buildWebReferences(questions: QuestionItem[], generated: AnswerItem[] = []): Record<string, WebPromptReference> {
  const references: Record<string, WebPromptReference> = {};
  const answers = new Map(generated.map(item => [stableWebQuestionKey(item.question), item.answer.answer]));
  for (const question of questions) {
    const ref = question.webReference;
    if (!ref) continue;
    const group = questions.filter(item => item.webReference?.groupKey === ref.groupKey);
    const position = group.indexOf(question);
    const neighbours = group.slice(Math.max(0, position - 2), position + 3).filter(item => item !== question)
      .map(item => ({ index: item.index || questions.indexOf(item) + 1, question: item.question }));
    const previousAnswers: WebPromptReference['previousAnswers'] = group.slice(0, position).flatMap(item => {
      const filled = item.webReference?.filledValues.filter(value => value.trim()).join('##');
      const generatedAnswer = answers.get(stableWebQuestionKey(item));
      const answer = generatedAnswer || filled;
      return answer ? [{ index: item.index || questions.indexOf(item) + 1, question: item.question, answer,
        source: generatedAnswer ? 'web-generated' as const : 'page-filled' as const }] : [];
    }).slice(-5);
    // Optional context has a bounded budget. Never truncate the target stem or options.
    const material = [...new Set([question.context, ref.material].filter(Boolean))].join('\n');
    const reference: WebPromptReference = { pageTitle: ref.pageTitle.slice(0, 1000), chapterTitle: ref.chapterTitle?.slice(0, 2000),
      sectionTitle: ref.sectionTitle?.slice(0, 2000), material: material.slice(0, 11000), neighbours, previousAnswers };
    if (material.length > 11000) reference.reduced = true;
    while (JSON.stringify({ neighbours, previousAnswers }).length > 12000 && (neighbours.length || previousAnswers.length)) {
      if (neighbours.length) neighbours.pop(); else previousAnswers.shift();
      reference.reduced = true;
    }
    references[question.hash] = reference;
  }
  return references;
}

/** Only static scoped materials enter the shared bank. Live answers never do. */
export function toWebBankQuestion(question: QuestionItem): QuestionItem {
  const ref = question.webReference;
  if (!ref) return question;
  const context = JSON.stringify({ pageTitle: ref.pageTitle, chapterTitle: ref.chapterTitle, sectionTitle: ref.sectionTitle,
    groupKey: ref.groupKey, sourceQuestionId: ref.sourceQuestionId, material: ref.material || question.context || '',
    media: (question.media || []).map(media => ({ role: media.role, optionLabel: media.optionLabel, sourceUrl: media.sourceUrl, alt: media.alt })) });
  const { webReference: _reference, media: _media, ...staticQuestion } = question;
  return { ...staticQuestion, context };
}
