interface AppliedAnswerRecord {
  qid: string;
  answer: string;
  labels: string[];
  updatedAt: number;
}

function appliedAnswerStore(): Record<string, AppliedAnswerRecord> {
  const pageAny = window as any;
  if (!pageAny.__studyPilotAppliedAnswers) pageAny.__studyPilotAppliedAnswers = {};
  return pageAny.__studyPilotAppliedAnswers;
}

export function rememberAppliedAnswer(qid: string, answer: string, labels: string[]) {
  if (!qid || !answer) return;
  appliedAnswerStore()[qid] = {
    qid,
    answer,
    labels,
    updatedAt: Date.now()
  };
}

export function appliedAnswerFor(qid: string) {
  const record = appliedAnswerStore()[qid];
  if (!record) return null;
  if (Date.now() - record.updatedAt > 30 * 60 * 1000) return null;
  return record;
}
