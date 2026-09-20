import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildWebPrompt, hasCompleteWebResponse, optionPairs, parseWebAnswer, prepareWebBatch, sameQuestions, validateWebPrompt, WEB_AI_PROMPT_LIMIT } from '../src/webAI/protocol';
import type { WebBatch } from '../src/webAI/protocol';
import type { QuestionItem } from '../src/store/appStore';

const question: QuestionItem = { id: 'first', hash: 'h1', type: 'single', question: 'Which one?', options: ['C. Cherry', 'A. Apple', 'B. Banana'], source: 'webview', capturedAt: 0 };
const batch: WebBatch = { requestId: 'test-request', questions: [question, { ...question, id: 'second', hash: 'h2', type: 'completion', options: [] }] };
const choice = { id: 'q1', answer: 'Banana', choiceLabels: ['B'], matchedOptions: ['Banana'], confidence: 0.9, analysis: '', warnings: [] };
const completion = { ...choice, id: 'q2', answer: 'first##second', choiceLabels: [], matchedOptions: [] };
const response = (answers: any[], requestId = batch.requestId) => JSON.stringify({ requestId, answers });

describe('Web AI answer boundary', () => {
  it('preserves displayed labels and excludes selectors and page credentials from prompt', () => {
    const prompt = buildWebPrompt({ ...batch, questions: [{ ...question, pageUrl: 'https://example.com/?token=secret', selector: '#secret' }] });
    assert.ok(prompt.includes('"label": "C"'));
    assert.ok(!prompt.includes('secret'));
  });
  it('maps reordered answers by id and B by the page label rather than index', () => {
    const parsed = parseWebAnswer(response([completion, choice]), batch, 'web');
    assert.equal(parsed.automatic, true);
    assert.deepEqual(parsed.items[0].answer.choiceLabels, ['B']);
    assert.deepEqual(parsed.items[0].answer.matchedOptions, ['Banana']);
    assert.equal(parsed.items[1].answer.answer, 'first##second');
  });
  it('preserves paragraph indentation and line breaks for fill-in answers', () => {
    const indented = { ...completion, answer: '　　第一行\n　　第二行' };
    const parsed = parseWebAnswer(response([choice, indented]), batch, 'web');
    assert.equal(parsed.items[1].answer.answer, '　　第一行\n　　第二行');
  });
  it('rejects mismatched option letters and content', () => {
    const parsed = parseWebAnswer(response([{ ...choice, choiceLabels: ['A'] }, completion]), batch, 'web');
    assert.equal(parsed.automatic, false);
    assert.equal(parsed.items.length, 1);
    assert.ok(parsed.errors[0].includes('不一致'));
  });
  it('does not accept answers from another request or a prompt echo', () => {
    assert.equal(parseWebAnswer(response([choice, completion], 'old'), batch, 'web').items.length, 0);
    assert.equal(hasCompleteWebResponse(buildWebPrompt(batch), batch.requestId), false);
  });
  it('blocks duplicate, missing and unknown ids', () => {
    assert.ok(parseWebAnswer(response([choice, choice, completion]), batch, 'web').errors[0].includes('重复'));
    assert.ok(parseWebAnswer(response([choice]), batch, 'web').errors[0].includes('缺少'));
    assert.equal(parseWebAnswer(response([choice, completion, { ...choice, id: 'q99' }]), batch, 'web').automatic, false);
  });
  it('waits for complete JSON and accepts a fenced answer', () => {
    const text = response([choice, completion]);
    assert.equal(hasCompleteWebResponse(text.slice(0, -1), batch.requestId), false);
    assert.equal(parseWebAnswer('```json\n' + text + '\n```', batch, 'web').automatic, true);
  });
  it('keeps low-confidence or warned answers for review only', () => {
    assert.equal(parseWebAnswer(response([{ ...choice, confidence: 0.4 }, completion]), batch, 'web').automatic, false);
    assert.equal(parseWebAnswer(response([{ ...choice, warnings: ['uncertain'] }, completion]), batch, 'web').automatic, false);
  });
  it('validates multiple choice and judgement', () => {
    const multiple = { requestId: batch.requestId, questions: [{ ...question, type: 'multiple' as const }] };
    assert.equal(parseWebAnswer(response([{ ...choice, choiceLabels: ['A', 'C'], matchedOptions: ['Apple', 'Cherry'] }]), multiple, 'web').automatic, true);
    const judgement = { ...multiple, questions: [{ ...question, type: 'judgement' as const }] };
    assert.equal(parseWebAnswer(response([{ ...choice, answer: 'true', choiceLabels: [], matchedOptions: [] }]), judgement, 'web').automatic, true);
    assert.equal(parseWebAnswer(response([choice]), judgement, 'web').items.length, 0);
  });
  it('rejects same-id questions when option order or context changed', () => {
    assert.equal(sameQuestions([question], [{ ...question, options: [...question.options].reverse() }]), false);
    assert.equal(sameQuestions([question], [{ ...question, context: 'new passage' }]), false);
    assert.equal(sameQuestions([question], [question]), true);
  });
  it('preserves full-width labels and captured target labels for unprefixed options', () => {
    assert.deepEqual(optionPairs({ ...question, options: ['Ｂ．Banana', 'Ａ）Apple'] }), [{ label: 'B', text: 'Banana' }, { label: 'A', text: 'Apple' }]);
    const captured = { ...question, options: ['Banana', 'Apple'], optionTargets: [{ label: 'B', text: 'Banana' }, { label: 'A', text: 'Apple' }] };
    assert.equal(optionPairs(captured)[0].label, 'B');
    assert.equal(sameQuestions([captured], [{ ...captured, optionTargets: [] }]), false);
  });
  it('uses verified option content, rejecting unknown labels and malformed fields', () => {
    const valid = parseWebAnswer(response([{ ...choice, answer: 'Apple' }, completion]), batch, 'web');
    assert.equal(valid.items[0].answer.answer, 'Banana');
    for (const patch of [{ choiceLabels: ['Z'] }, { confidence: 'high' }, { warnings: null }, { matchedOptions: [42] }]) {
      assert.equal(parseWebAnswer(response([{ ...choice, ...patch }, completion]), batch, 'web').automatic, false);
    }
  });
});

describe('Web AI 50-question batches', () => {
  const makeQuestions = (count: number) => Array.from({ length: count }, (_, index) => ({ ...question, id: `id-${index}`, hash: `hash-${index}`, question: `Question ${index + 1}: ${'long passage '.repeat(100)}` }));

  it('includes all 50 long questions without the old 30000-character truncation', () => {
    const source = makeQuestions(50);
    const result = prepareWebBatch(source, 'deepseek');
    assert.equal(result.batch.questions.length, 50);
    assert.equal(result.remaining.length, 0);
    assert.ok(result.prompt.length > 30000);
    assert.ok(result.prompt.length < WEB_AI_PROMPT_LIMIT);
    for (const question of source) assert.ok(result.prompt.includes(question.question));
    assert.ok(result.prompt.includes('"id": "q50"'));
  });

  it('preserves the 51st question for an explicitly generated next batch', () => {
    const source = makeQuestions(51);
    const first = prepareWebBatch(source, 'doubao');
    assert.equal(first.batch.questions.length, 50);
    assert.deepEqual(first.remaining.map(q => q.hash), ['hash-50']);
    const second = prepareWebBatch(first.remaining, 'doubao');
    assert.equal(second.batch.questions.length, 1);
    assert.equal(second.batch.questions[0].hash, 'hash-50');
    assert.equal(second.remaining.length, 0);
    assert.notEqual(first.batch.requestId, second.batch.requestId);
  });

  it('maps a reversed 50-answer response to the correct original questions', () => {
    const { batch } = prepareWebBatch(makeQuestions(50), 'qwen');
    const answers = batch.questions.map((_, index) => ({ ...choice, id: `q${index + 1}` })).reverse();
    const preview = parseWebAnswer(JSON.stringify({ requestId: batch.requestId, answers }), batch, 'qwen');
    assert.equal(preview.errors.length, 0);
    assert.equal(preview.items.length, 50);
    assert.equal(preview.items[49].question.hash, 'hash-49');
    assert.deepEqual(preview.items[49].answer.choiceLabels, ['B']);
  });

  it('checks edited prompts at the new length boundary and preserves batch identity', () => {
    const { batch } = prepareWebBatch(makeQuestions(1), 'deepseek');
    const prompt = batch.requestId + 'x'.repeat(WEB_AI_PROMPT_LIMIT - batch.requestId.length);
    assert.doesNotThrow(() => validateWebPrompt(prompt, batch));
    assert.throws(() => validateWebPrompt(prompt + 'x', batch), /30 万/);
    assert.throws(() => validateWebPrompt('unrelated prompt', batch), /ID/);
    assert.throws(() => prepareWebBatch([], 'deepseek'));
  });
});
