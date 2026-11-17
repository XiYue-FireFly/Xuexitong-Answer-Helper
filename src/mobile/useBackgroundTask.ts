import { useEffect } from 'react';
import { answerActivity, apiActivity } from '../answerActivity/activityStore';
import { appStore } from '../store/appStore';
import { webAISessions } from '../webAI/WebAISessionManager';
import { TaskStatus } from '../platform/taskStatusPlugin';
import { mobileTaskStatus } from './taskStatus';

export function useBackgroundTask() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let chain = Promise.resolve();
    const publish = () => {
      const web = webAISessions.getSnapshot();
      const legacy = answerActivity.getSnapshot().task;
      const app = appStore.getState();
      const tasks = [...web.tasks.map(item => item.task), ...(legacy ? [legacy] : [])];
      const state = mobileTaskStatus(tasks, web.busy || app.liveRunning || app.batchRunning || app.status === 'calling_ai');
      const running = tasks.filter(task => task.outcome === 'running');
      state.canPause = running.length > 0 && running.every(task => task.kind === 'web-auto' || task.kind === 'api-apply' && app.liveRunning);
      chain = chain.catch(() => {}).then(async () => { if (!disposed) await TaskStatus.update(state); }).catch(error => {
        console.warn('后台状态更新失败', error?.message);
      });
    };
    const update = () => { clearTimeout(timer); timer = setTimeout(publish, 100); };
    const observe = () => { apiActivity.observe(appStore.getState(), webAISessions.getSnapshot().busy); update(); };
    const off = [appStore.subscribe(observe), answerActivity.subscribe(update), webAISessions.subscribe(observe)];
    const media = TaskStatus.addListener('mediaControl', ({ paused }) => {
      const snapshot = webAISessions.getSnapshot();
      const controllers = new Set([...snapshot.sessions.map(session => session.controller), snapshot.controller]);
      for (const controller of controllers) {
        const state = controller.getSnapshot();
        if (state.busy && state.flow === 'automatic' && state.paused !== paused) controller.togglePause();
      }
      if (appStore.getState().liveRunning) window.dispatchEvent(new CustomEvent('studypilot:api-pause', { detail: { paused } }));
      update();
    });
    const heartbeat = setInterval(publish, 15000);
    const visible = () => publish();
    document.addEventListener('visibilitychange', visible);
    observe(); publish();
    return () => { disposed = true; void media.then(listener => listener.remove()); off.forEach(remove => remove()); clearTimeout(timer); clearInterval(heartbeat); document.removeEventListener('visibilitychange', visible); };
  }, []);
}
