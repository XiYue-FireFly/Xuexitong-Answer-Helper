import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { WEB_AI_BROWSER_EVENT, webActionScript } from './browserBridge';
import { composerTextMatches } from './composerText';
import type { WebCommand } from './browserBridge';
import { WEB_AI_PROVIDERS } from './protocol';
import { webAISessions } from './WebAISessionManager';

type View = { getURL?: () => string; getWebContentsId?: () => number; focus?: () => void; sendInputEvent?: (event: { type: 'keyDown' | 'keyUp'; keyCode: string }) => void | Promise<void>; executeJavaScript?: (code: string, userGesture?: boolean) => Promise<any> };
let enterQueue: Promise<unknown> = Promise.resolve();
export function useBrowserBridge(enabled: boolean, views: MutableRefObject<Record<string, View>>, activeId: string,
  open: (url: string, title: string, background?: boolean) => string, focus: (id: string) => void) {
  const active = useRef(activeId); active.current = activeId;
  useEffect(() => {
    const handler = (event: Event) => {
      const command = (event as CustomEvent).detail as WebCommand & { onComplete: (value: any) => void };
      void (async () => {
        if (command.isCancelled?.()) throw new Error('操作已停止。');
        if (!enabled) throw new Error('请先在设置中启用真实 WebView。');
        if (command.action === 'open') {
          const provider = WEB_AI_PROVIDERS.find(value => value.id === command.provider);
          if (!provider) throw new Error('未知网页 AI。');
          return { tabId: open(provider.url, provider.name, Boolean(command.sessionId)), url: provider.url };
        }
        const tabId = command.tabId || activeId;
        const view = views.current[tabId];
        if (!view) throw new Error('原标签已关闭，请重新抓题或打开 AI 网站。');
        const url = view.getURL?.() || '';
        if (command.sessionId) {
          const session = webAISessions.getSnapshot().sessions.find(item => item.id === command.sessionId);
          const binding = session?.source || command.resourceSource;
          const source = binding && views.current[binding.tabId];
          const api = (window as any).electronAPI;
          if (binding && source?.getWebContentsId && api?.leaseWebAITask && source.getURL?.() === binding.url) {
            const result = await api.leaseWebAITask({ sessionId: command.sessionId, sourceContentsId: source.getWebContentsId(), sourceUrl: binding.url,
              ...(tabId !== binding.tabId ? { aiContentsId: view.getWebContentsId?.() } : {}) });
            if (!result.ok) throw new Error(result.error || '任务页面资源不可用。');
          }
        }
        if (command.action === 'source') return { tabId, url };
        if (command.action === 'focus') { focus(tabId); return { tabId, url }; }
        if (!view.executeJavaScript) throw new Error('网页尚未就绪。');
        const result = await view.executeJavaScript(webActionScript(command, composerTextMatches), true);
        if (command.isCancelled?.()) throw new Error('操作已停止。');
        if (command.action === 'send' && result?.needsEnter) {
          if (!view.sendInputEvent) return { ...result, reason: '当前浏览器不支持自动按键，请手动发送。' };
          const previous = active.current;
          const press = async () => {
            if (command.isCancelled?.()) throw new Error('操作已停止。');
            focus(tabId); view.focus?.();
            try { await view.sendInputEvent!({ type: 'keyDown', keyCode: 'Enter' }); }
            finally { await view.sendInputEvent!({ type: 'keyUp', keyCode: 'Enter' });
              if (command.sessionId && (active.current === previous || active.current === tabId)) focus(previous);
            }
          };
          enterQueue = enterQueue.catch(() => undefined).then(press);
          await enterQueue;
          return { ...result, attempted: true, needsEnter: false };
        }
        return result;
      })().then(command.onComplete, error => command.onComplete({ error: error.message }));
    };
    window.addEventListener(WEB_AI_BROWSER_EVENT, handler);
    return () => window.removeEventListener(WEB_AI_BROWSER_EVENT, handler);
  }, [enabled, views, activeId, open, focus]);
}
