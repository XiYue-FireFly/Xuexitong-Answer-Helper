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

export interface QuestionPayload {
  hash: string;
  question: string;
  options: string[];
  optionTargets?: QuestionOptionTarget[];
  type?: QuestionType;
  selector?: string;
  index?: number;
  context?: string;
}

export interface AnswerApplyPayload {
  questionHash: string;
  answer: string;
  choiceLabels?: string[];
  matchedOptions?: string[];
  question?: QuestionPayload;
}
