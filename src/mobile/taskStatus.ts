import type { AnswerActivity } from '../answerActivity/activityStore';

export type MobileTaskStatus = {
  running: boolean; paused: boolean; title: string; phase: string;
  completed: number; total: number; skipped: number; indeterminate: boolean; outcome: string;
};

/** Only counters and generic phase text leave the task layer; never page content. */
export function mobileTaskStatus(tasks: AnswerActivity[], busy = false): MobileTaskStatus {
  const running = tasks.filter(task => task.outcome === 'running');
  const current = running.length ? running : [...tasks].sort((a, b) => (b.endedAt || b.startedAt) - (a.endedAt || a.startedAt)).slice(0, 1);
  const task = current[0];
  const paused = running.length > 0 && running.every(item => item.paused);
  const phases: Record<string, string> = { extracting: '正在读取题目', preparing: '正在整理题目', opening: '正在打开 AI', sending: '正在发送提示词',
    waiting_answer: '正在等待 AI 回答', waiting_source: '正在等待原题页', validating: '正在校验答案', importing: '正在保存答案',
    checking_source: '正在核对原题页', applying: '正在填入答案', paused: '任务已暂停', calling_ai: '正在请求 AI', executing: '正在填入答案',
    extracting_question: '正在读取题目', completed: '答题已完成', partial: '任务结束，请查看结果', failed: '需要回到应用处理', stopped: '任务已停止' };
  return {
    running: running.length > 0 || busy, paused,
    title: running.length > 1 ? `${running.length} 个答题任务` : '学习助手答题',
    phase: paused ? '任务已暂停' : phases[(running.length || busy ? task?.phase : task?.outcome) || ''] || (busy ? '正在处理题目' : task ? '任务已结束' : '暂无答题任务'),
    completed: current.reduce((sum, item) => sum + (item.kind === 'api-answer' ? item.resolved.length : item.applied.length), 0),
    total: current.reduce((sum, item) => sum + item.targets.length, 0),
    skipped: current.reduce((sum, item) => sum + item.skipped.length, 0),
    indeterminate: current.some(item => item.indeterminate) || !current.length,
    outcome: running.length || busy ? 'running' : task?.outcome || 'idle',
  };
}
