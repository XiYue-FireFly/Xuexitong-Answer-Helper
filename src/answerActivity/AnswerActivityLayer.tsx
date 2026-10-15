import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Activity, CheckCircle2, CirclePause, CircleStop, TriangleAlert, Volume2, VolumeX } from 'lucide-react';
import confetti from 'canvas-confetti';
import { appStore } from '../store/appStore';
import { webAIController } from '../webAI/WebAIController';
import { activityProgress, answerActivity, apiActivity, type ActivityFeedback, type AnswerActivity } from './activityStore';
import { getFeedbackMuted, listenForFeedbackAudioUnlock, playFeedbackAudio, setFeedbackMuted, subscribeFeedbackMuted, unlockFeedbackAudio } from './feedbackAudio';
import './answer-activity.css';

const cryingCatUrl = new URL('./assets/crying-pixel-cat.png', import.meta.url).href;
const STAGE_ONLY = new Set(['starting', 'extracting', 'extracting_question', 'preparing', 'opening', 'waiting_login']);
const ANSWERING = new Set(['sending', 'waiting_answer', 'validating', 'importing', 'checking_source', 'applying', 'calling_ai', 'executing']);
const TITLES = { 'web-auto': '网页自动答题', 'web-read': '网页答案提取', 'api-answer': 'AI 解答', 'api-apply': '答案填入' };
const TRACKS = Array.from({ length: 18 }, (_, index) => ({
  '--meteor-x': `${(index * 31 + 7) % 110 - 10}%`,
  '--meteor-y': `${(index * 17 + 3) % 100 - 15}%`,
  '--meteor-delay': `${-(index * 0.49)}s`,
  '--meteor-duration': `${3.4 + (index % 4) * 0.45}s`,
  '--meteor-length': `${110 + (index % 4) * 28}px`
} as CSSProperties));

type VisibleFeedback = ActivityFeedback & { endsAt: number };
const consumedFeedback = new Set<string>();
const playedFeedback = new Set<string>();
const celebratedFeedback = new Set<string>();
const feedbackQueue: ActivityFeedback[] = [];
const feedbackListeners = new Set<() => void>();
let visibleFeedback: VisibleFeedback | null = null;
let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
let hostCount = 0;
let destructionTimer: ReturnType<typeof setTimeout> | undefined;

function nextFeedback() {
  if (feedbackTimer) clearTimeout(feedbackTimer);
  const event = feedbackQueue.shift();
  visibleFeedback = event ? { ...event, endsAt: Date.now() + (event.kind === 'extracted' ? 2500 : 3800) } : null;
  feedbackListeners.forEach(listener => listener());
  if (visibleFeedback) feedbackTimer = setTimeout(nextFeedback, visibleFeedback.endsAt - Date.now());
}

function collectFeedback() {
  answerActivity.getSnapshot().feedback.forEach(event => {
    if (consumedFeedback.has(event.id)) return;
    consumedFeedback.add(event.id);
    feedbackQueue.push(event);
  });
  if (!visibleFeedback && feedbackQueue.length) nextFeedback();
}

const getVisibleFeedback = () => visibleFeedback;
const subscribeVisibleFeedback = (listener: () => void) => {
  feedbackListeners.add(listener);
  return () => { feedbackListeners.delete(listener); };
};

function formatElapsed(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

function useEnvironment() {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onVisibility = () => setVisible(document.visibilityState !== 'hidden');
    const onMotion = () => setReducedMotion(media.matches);
    document.addEventListener('visibilitychange', onVisibility);
    media.addEventListener('change', onMotion);
    return () => { document.removeEventListener('visibilitychange', onVisibility); media.removeEventListener('change', onMotion); };
  }, []);
  return { visible, reducedMotion };
}

function ActivityDock({ task }: { task: AnswerActivity }) {
  const [now, setNow] = useState(Date.now);
  const lastPhase = useRef({ id: task.id, phase: task.phase });
  if (lastPhase.current.id !== task.id || task.phase !== 'paused') lastPhase.current = { id: task.id, phase: task.phase };
  const muted = useSyncExternalStore(subscribeFeedbackMuted, getFeedbackMuted, getFeedbackMuted);
  useEffect(() => {
    setNow(Date.now());
    if (task.outcome === 'running') {
      const timer = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(timer);
    }
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, (task.endedAt || Date.now()) + 6000 - Date.now()));
    return () => clearTimeout(timer);
  }, [task.id, task.outcome, task.endedAt]);

  if (task.endedAt && now >= task.endedAt + 6000) return null;
  const progress = activityProgress(task);
  const phase = task.phase === 'paused' ? lastPhase.current.phase : task.phase;
  const stageOnly = STAGE_ONLY.has(phase);
  const waitingOnly = task.kind === 'web-read';
  const showRail = !stageOnly && !waitingOnly;
  const indeterminate = task.indeterminate && task.outcome !== 'completed';
  const action = task.kind === 'api-answer' ? '已解答' : '已填入';
  const countText = indeterminate ? `${action} ${progress.count} 题` : `${action} ${progress.count}/${progress.total} 题`;
  const Icon = task.paused ? CirclePause : task.outcome === 'completed' ? CheckCircle2 : task.outcome === 'failed' || task.outcome === 'partial' ? TriangleAlert : task.outcome === 'stopped' ? CircleStop : Activity;
  const label = task.paused ? '任务已暂停' : task.label || '正在准备';
  const soundLabel = muted ? '开启反馈声音' : '关闭反馈声音';
  const stageHint = task.paused ? '已暂停' : task.outcome !== 'running'
    ? task.outcome === 'partial' ? '等待核对' : task.outcome === 'stopped' ? '已停止' : '已结束'
    : waitingOnly ? '等待网页回答' : phase === 'waiting_login' ? '等待登录' : '准备中';

  return <aside className={`answer-activity-dock is-${task.outcome}${task.paused ? ' is-paused' : ''}`} aria-label="答题进度">
    <div className="answer-activity-dock__header">
      <Icon size={15} aria-hidden="true" />
      <strong>{TITLES[task.kind]}</strong>
      <button className="answer-activity-sound" type="button" title={soundLabel} aria-label={soundLabel} aria-pressed={!muted}
        onClick={() => { if (muted) unlockFeedbackAudio(); setFeedbackMuted(!muted); }}>
        {muted ? <VolumeX size={15} aria-hidden="true" /> : <Volume2 size={15} aria-hidden="true" />}
      </button>
    </div>
    <div className="answer-activity-dock__state" role="status" aria-live="polite" aria-atomic="true">{label}</div>
    <div className="answer-activity-dock__rail-slot">
      {showRail && <div className={`answer-activity-rail${indeterminate ? ' is-indeterminate' : ''}`} role="progressbar" aria-label={TITLES[task.kind]}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={indeterminate ? undefined : progress.percent} aria-valuetext={countText}>
        <span className="answer-activity-rail__fill" style={indeterminate ? undefined : { transform: `scaleX(${progress.percent / 100})` }} />
        {!indeterminate && <span className="answer-activity-rail__head" style={{ left: `${progress.percent}%` }} />}
      </div>}
    </div>
    <div className="answer-activity-dock__meta">
      <time aria-label="已用时间">{formatElapsed((task.endedAt || now) - task.startedAt)}</time>
      <span>{showRail ? countText : stageHint}</span>
      {showRail && !indeterminate && <output>{progress.percent}%</output>}
    </div>
  </aside>;
}

function Feedback({ event, decorations }: { event: VisibleFeedback; decorations: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (playedFeedback.has(event.id)) return;
    playedFeedback.add(event.id);
    playFeedbackAudio(event.kind);
  }, [event.id, event.kind]);
  useEffect(() => {
    if (event.kind !== 'completed' || !decorations || !canvas.current || celebratedFeedback.has(event.id)) return;
    const burst = confetti.create(canvas.current, { resize: true, useWorker: false });
    let frame = 0;
    let lastBurst = 0;
    const animate = (time: number) => {
      if (Date.now() >= event.endsAt) { burst.reset(); return; }
      celebratedFeedback.add(event.id);
      if (time - lastBurst >= 240) {
        lastBurst = time;
        for (const side of [0.12, 0.88]) void burst({ particleCount: 8, spread: 68, startVelocity: 42, gravity: 0.85, scalar: 0.8, ticks: 130,
          angle: side < 0.5 ? 60 : 120, origin: { x: side, y: 0.8 },
          colors: ['#a78bfa', '#22d3ee', '#34d399', '#f9a8d4', '#fbbf24'], disableForReducedMotion: true });
      }
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => { cancelAnimationFrame(frame); burst.reset(); };
  }, [event.id, event.kind, event.endsAt, decorations]);

  return <>
    {event.kind === 'completed' && <canvas ref={canvas} className="answer-activity-confetti" aria-hidden="true" />}
    <div className={`answer-activity-feedback is-${event.kind}`} role="status" aria-live="polite" aria-atomic="true">
      {event.kind === 'extracted'
        ? <img src={cryingCatUrl} width="88" height="88" alt="哭泣像素猫" />
        : <span className="answer-activity-feedback__celebration" aria-hidden="true">🎉</span>}
      <span>{event.kind === 'extracted' ? '答案已提取' : '全部完成'}</span>
    </div>
  </>;
}

export function AnswerActivityLayer() {
  const { task } = useSyncExternalStore(answerActivity.subscribe, answerActivity.getSnapshot, answerActivity.getSnapshot);
  const feedback = useSyncExternalStore(subscribeVisibleFeedback, getVisibleFeedback, getVisibleFeedback);
  const { visible, reducedMotion } = useEnvironment();

  useEffect(() => {
    hostCount++;
    if (destructionTimer) clearTimeout(destructionTimer);
    const observe = () => apiActivity.observe(appStore.getState(), webAIController.getSnapshot().busy);
    const unsubscribeApp = appStore.subscribe(observe);
    const unsubscribeWeb = webAIController.subscribe(observe);
    const unsubscribeFeedback = answerActivity.subscribe(collectFeedback);
    const removeAudioUnlock = listenForFeedbackAudioUnlock();
    observe();
    collectFeedback();
    return () => {
      unsubscribeApp(); unsubscribeWeb(); unsubscribeFeedback(); removeAudioUnlock();
      hostCount--;
      // StrictMode immediately installs the host again; a real destruction leaves no host.
      destructionTimer = setTimeout(() => { if (!hostCount) webAIController.stop(); }, 0);
    };
  }, []);

  const answering = Boolean(task && task.outcome === 'running' && !task.paused && ANSWERING.has(task.phase));
  const decorations = visible && !reducedMotion;
  return <>
    <div className={`answer-activity-layer${visible ? '' : ' is-hidden'}`}>
      {task && <ActivityDock task={task} />}
    </div>
    {createPortal(<div className={`answer-activity-effects${visible ? '' : ' is-hidden'}${reducedMotion ? ' is-reduced-motion' : ''}`}>
      {answering && decorations && <div className="answer-activity-meteors" aria-hidden="true">
        {TRACKS.map((style, index) => <span className="answer-activity-meteor" key={index} style={style} />)}
      </div>}
      {feedback && visible && <Feedback key={feedback.id} event={feedback} decorations={decorations} />}
    </div>, document.body)}
  </>;
}
