export type AutomationAction = 'click' | 'fill' | 'select' | 'wait';
export type QuestionType = 'single' | 'multiple' | 'judgement' | 'completion' | 'essay' | 'unknown';

export interface AutomationStep {
  id: string;
  action: AutomationAction;
  selector?: string;
  value?: string;
  label: string;
  required: boolean;
}

export interface AutomationPlan {
  id: string;
  goal: string;
  steps: AutomationStep[];
  approved: boolean;
}

export interface QuestionOptionTarget {
  label: string;
  text: string;
  selector?: string;
  inputSelector?: string;
  clickSelector?: string;
  value?: string;
}

export interface WebReference {
  pageTitle: string;
  chapterTitle?: string;
  sectionTitle?: string;
  groupKey: string;
  sourceQuestionId: string;
  material?: string;
  filledValues: string[];
}

export interface QuestionMedia {
  id: string;
  role: 'stem' | 'option' | 'material';
  optionLabel?: string;
  sourceUrl?: string;
  alt: string;
  caption?: string;
  width?: number;
  height?: number;
  status: 'discovered' | 'ready' | 'unavailable';
  reason?: string;
  contentDigest?: string;
  mime?: string;
  selector?: string;
}

export interface QuestionPayload {
  hash: string;
  question: string;
  options: string[];
  optionTargets?: QuestionOptionTarget[];
  type?: QuestionType;
  selector?: string;
  index?: number;
  context?: string;
  webReference?: WebReference;
  media?: QuestionMedia[];
}

export interface AnswerApplyPayload {
  questionHash: string;
  answer: string;
  choiceLabels?: string[];
  matchedOptions?: string[];
  question?: QuestionPayload;
}
