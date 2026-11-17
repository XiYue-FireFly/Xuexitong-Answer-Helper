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
    <p>切到其他应用后显示当前步骤和已完成题数，点击状态可回到答题。任务结束后停止后台服务。</p>
    <div><span>进度通知 {capabilities ? capabilities.notifications ? '· 已开启' : '· 未开启' : ''}</span>
      <button className="btn btn-soft" disabled={pending} onClick={() => run(() => TaskStatus.requestNotifications())}>通知权限</button></div>
    <div><span>顶部状态胶囊 {capabilities?.overlayEnabled && capabilities.overlay ? '· 已开启' : '· 已关闭'}</span>
      <button className="btn btn-soft" disabled={pending || !capabilities} onClick={() => run(() => TaskStatus.setOverlay({ enabled: !capabilities?.overlayEnabled }))}>
        {capabilities?.overlayEnabled ? '关闭状态胶囊' : '开启状态胶囊'}</button></div>
    <p>顶部胶囊需要“显示在其他应用上层”权限。Android 16 可向系统请求实时更新，最终显示形式由系统决定；其他版本使用持续进度通知。</p>
    <button className="btn btn-soft" disabled={pending} onClick={() => run(() => TaskStatus.openBatterySettings())}>后台与电池设置</button>
    <p>若手机限制后台运行，请在系统设置中允许后台活动。强制停止、清理进程或系统回收后任务不会自动恢复。</p>
    {error && <p role="status">{error}</p>}
  </section>;
}
