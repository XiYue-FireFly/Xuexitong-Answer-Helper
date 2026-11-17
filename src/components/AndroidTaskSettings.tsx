import { useEffect, useState } from 'react';
import { TaskStatus, type TaskCapabilities } from '../platform/taskStatusPlugin';

export function AndroidTaskSettings() {
  const [capabilities, setCapabilities] = useState<TaskCapabilities | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const refresh = () => { void TaskStatus.getCapabilities().then(setCapabilities).catch(() => setError('无法读取系统权限')); };
  useEffect(() => { refresh(); window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); }; }, []);
  const run = async (action: () => Promise<unknown>) => {
    setPending(true); setError('');
    try { await action(); refresh(); } catch { setError('系统未打开此设置，请在手机设置中为本应用开启权限。'); }
    finally { setPending(false); }
  };
  return <section className="glass-panel mobile-task-settings" aria-label="后台答题状态设置">
    <h5>后台答题状态</h5>
    <p>切到其他应用后，通过系统显示当前步骤与完成题数。点击系统胶囊查看展开卡片，点击通知返回任务；任务结束后状态自动移除。</p>
    <div><span>进度通知 {capabilities ? capabilities.notifications ? '· 已开启' : '· 未开启' : ''}</span>
      <button className="btn btn-soft" disabled={pending} onClick={() => run(() => TaskStatus.requestNotifications())}>通知权限</button></div>
    <div><span>系统实时状态 {capabilities ? capabilities.liveUpdates ? '· 已允许' : capabilities.api >= 36 ? '· 需在系统设置中允许' : '· 由手机系统提供' : ''}</span>
      <button className="btn btn-soft" disabled={pending || !capabilities} onClick={() => run(() => TaskStatus.openLiveUpdateSettings())}>实时状态设置</button></div>
    <p>Android 16–17 使用系统实时进度卡片，Android 15 使用持续进度通知。状态栏胶囊、展开方式及动效由手机系统决定。无需悬浮窗权限。</p>
    <div><span>媒体卡片兼容模式 {capabilities?.mediaCard ? '· 已开启' : '· 已关闭'}</span>
      <button className="btn btn-soft" aria-pressed={!!capabilities?.mediaCard} disabled={pending || !capabilities}
        onClick={() => run(() => TaskStatus.setMediaCard({ enabled: !capabilities?.mediaCard }))}>
        {capabilities?.mediaCard ? '使用原生进度' : '开启媒体卡片'}</button></div>
    <p>手机未显示原生岛时可尝试此模式：以系统媒体进度条显示完成比例，暂停键控制自动答题。不播放声音，但会占用媒体控制区，可能影响音乐卡片展示。进度条时间刻度代表题数，不能拖动改变进度；是否上岛及高光动画由手机系统决定。</p>
    <button className="btn btn-soft" disabled={pending} onClick={() => run(() => TaskStatus.openBatterySettings())}>后台与电池设置</button>
    <p>若手机限制后台运行，请在系统设置中允许后台活动。强制停止、清理进程或系统回收后任务不会自动恢复。</p>
    {error && <p role="status">{error}</p>}
  </section>;
}
