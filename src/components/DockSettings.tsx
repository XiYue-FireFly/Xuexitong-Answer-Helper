import { ArrowDownToLine, ArrowLeftToLine, ArrowRightToLine, ArrowUpToLine, BookOpen, Bug, Coins, History } from 'lucide-react';
import { useDockPreferences, updateDockPreferences, type DockEdge } from '../ui/dockPreferences';
export function DockSettings() {
  const preferences = useDockPreferences();
  const mobile = (window as any).Capacitor?.getPlatform?.() === 'android';
  return <section className="glass-panel dock-settings" aria-label="工具栏外观">
    <h5>工具栏与液态玻璃</h5>
    <p>选择抽屉位置。下滑网页时平滑收为答题按钮，回到顶部自动展开；自动答题期间收起，结束后展开。</p>
    <div className="dock-settings__edges" role="group" aria-label="工具栏位置">
      {([['left', '左侧抽屉', ArrowLeftToLine], ['right', '右侧抽屉', ArrowRightToLine],
        ['bottom', '底部抽屉', ArrowDownToLine], ['top', '上部抽屉', ArrowUpToLine]] as const).map(([edge,label,Icon]) =>
        <button type="button" key={edge} aria-pressed={preferences.edge === edge} onClick={() => updateDockPreferences({ edge: edge as DockEdge })}>
          <Icon size={19} aria-hidden="true" /><span>{label}</span>
        </button>)}
    </div>
    <div className="dock-settings__quality" role="group" aria-label="液态玻璃效果">
      {(['standard', 'ultra'] as const).map(glass => <button type="button" key={glass} aria-pressed={preferences.glass === glass}
        onClick={() => updateDockPreferences({ glass })}>{glass === 'ultra' ? '极致 · 实时折射' : '标准 · 柔和玻璃'}</button>)}
    </div>
    <label className="dock-settings__toggle"><input type="checkbox" checked={preferences.autoCollapse}
      onChange={event => updateDockPreferences({ autoCollapse: event.target.checked })} />下滑网页时自动收起</label>
    <p>收起后点击“答题”展开工具栏；再次点击可打开答题页。系统开启“减少动态效果”时缩短过渡。</p>
    {mobile && <><h5>更多工具</h5><div className="dock-settings__edges" role="group" aria-label="更多工具">
      {([['tokens','Token 用量',Coins],['history','运行记录',History],['bugs','错误报告',Bug],['tutorial','使用教程',BookOpen]] as const)
        .map(([tab,label,Icon]) => <button type="button" key={tab} onClick={() => window.dispatchEvent(new CustomEvent('studypilot:open-tool', { detail: tab }))}>
          <Icon size={19} aria-hidden="true" /><span>{label}</span></button>)}
    </div></>}
  </section>;
}
