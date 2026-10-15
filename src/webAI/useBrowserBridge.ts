import { useEffect } from 'react';
import type { MutableRefObject } from 'react';
import { WEB_AI_BROWSER_EVENT, webPageAction } from './browserBridge';
import { composerTextMatches } from './composerText';
import type { WebCommand } from './browserBridge';
import { WEB_AI_PROVIDERS } from './protocol';

type View = { getURL?: () => string; focus?: () => void; sendInputEvent?: (event: { type: 'keyDown' | 'keyUp'; keyCode: string }) => void | Promise<void>; executeJavaScript?: (code: string, userGesture?: boolean) => Promise<any> };
export function useBrowserBridge(enabled: boolean, views: MutableRefObject<Record<string, View>>, activeId: string,
  open: (url: string, title: string) => string, focus: (id: string) => void) {
  useEffect(() => {
    const handler = (event: Event) => {
      const command = (event as CustomEvent).detail as WebCommand & { onComplete: (value: any) => void };
      void (async () => {
        if (command.isCancelled?.()) throw new Error('操作已停止。');
        if (!enabled) throw new Error('请先在设置中启用真实 WebView。');
        if (command.action === 'open') {
          const provider = WEB_AI_PROVIDERS.find(value => value.id === command.provider);
          if (!provider) throw new Error('未知网页 AI。');
          return { tabId: open(provider.url, provider.name), url: provider.url };
        }
        const tabId = command.tabId || activeId;
        const view = views.current[tabId];
        if (!view) throw new Error('原标签已关闭，请重新抓题或打开 AI 网站。');
        const url = view.getURL?.() || '';
        if (command.action === 'source') return { tabId, url };
        if (command.action === 'focus') { focus(tabId); return { tabId, url }; }
        if (!view.executeJavaScript) throw new Error('网页尚未就绪。');
        const result = await view.executeJavaScript(`(${webPageAction.toString()})(${JSON.stringify(command.action)}, ${JSON.stringify(command.provider)}, ${JSON.stringify(command.prompt || '')}, ${JSON.stringify(command.deadline || 0)}, (${composerTextMatches.toString()}))`, true);
        if (command.isCancelled?.()) throw new Error('操作已停止。');
        if (command.action === 'send' && result?.needsEnter) {
          if (!view.sendInputEvent) return { ...result, reason: '当前浏览器不支持自动按键，请手动发送。' };
          focus(tabId);
          view.focus?.();
          try { await view.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); }
          finally { await view.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' }); }
          return { ...result, attempted: true, needsEnter: false };
        }
        return result;
      })().then(command.onComplete, error => command.onComplete({ error: error.message }));
    };
    window.addEventListener(WEB_AI_BROWSER_EVENT, handler);
    return () => window.removeEventListener(WEB_AI_BROWSER_EVENT, handler);
  }, [enabled, views, activeId, open, focus]);
}
