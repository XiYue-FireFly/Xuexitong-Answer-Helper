import { app, BrowserWindow, ipcMain, screen, session, shell, webFrameMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import {
  getErrorLogPath,
  installProcessErrorLogging,
  pruneOldErrorLogs,
  writeErrorLog,
  writeUnknownError
} from './error-logger';

let mainWindow: BrowserWindow | null = null;
const DB_FILE = path.join(app.getPath('userData'), 'studypilot_db.json');
const WEBVIEW_PARTITION = 'persist:studypilot-sites';
const BLOCKED_INTERNAL_TAB_URL = /(addStudentWorkNewWeb|\/mooc-ans\/work\/(?:addStudentWorkNewWeb|save|submit)|\/work\/(?:addStudentWorkNewWeb|save|submit)|(?:submit|save)StudentWork|submitWork|saveWork)/i;

installProcessErrorLogging();

// Ensure DB file exists
function readDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to read db', e);
  }
  return { settings: null, history: [], knowledgeBase: [] };
}

function writeDB(data: any) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write db', e);
  }
}

function shouldSkipConsoleMessage(message: string) {
  if (message.includes('Electron Security Warning')) return true;
  if (/^Mixed Content:/i.test(message)) return true;
  return false;
}

function shouldBlockInternalTabUrl(url: string) {
  return BLOCKED_INTERNAL_TAB_URL.test(String(url || ''));
}

function frameUrl(frame: any) {
  try {
    return frame?.url || frame?.top?.url || '';
  } catch {
    return '';
  }
}

function logWebviewNavigation(source: string, details: any) {
  const targetUrl = String(details?.url || '');
  if (!targetUrl || targetUrl === 'about:blank') return;
  writeErrorLog({
    source,
    level: 'info',
    message: `${source}: ${targetUrl}`,
    url: targetUrl,
    details: {
      isMainFrame: Boolean(details?.isMainFrame),
      isSameDocument: Boolean(details?.isSameDocument),
      frameUrl: frameUrl(details?.frame),
      initiatorUrl: frameUrl(details?.initiator)
    }
  });
}

function frameClickBridgeSource() {
  return `
    (() => {
      if (window.__studyPilotFrameClickBridge) return;
      window.__studyPilotFrameClickBridge = true;
      const navigationHint = /(mooc2-ans|mooc-ans|mycourse|dowork|stucoursemiddle|courseid|courseId|clazzid|clazzId|classId|workId|answerId|cpi|chaoxing)/i;
      const attributeHint = /(course|clazz|class|work|answer|cpi|enc|url|href|target|mooc|chaoxing)/i;
      const blockedInternalTabUrl = /(addStudentWorkNewWeb|\\/mooc-ans\\/work\\/(?:addStudentWorkNewWeb|save|submit)|\\/work\\/(?:addStudentWorkNewWeb|save|submit)|(?:submit|save)StudentWork|submitWork|saveWork)/i;
      const answerInlineHandlerHint = /(addMultipleChoice|addChoice|answerContentChange|loadAnswerSheet|setClozeTextAnswer|setBlankAnswer|fillBlank|blankAnswer)/i;
      const answerInteractionSelector = [
        '[qid][qtype]',
        '[qid][data]',
        '[questionid][qtype]',
        '[questionid][data]',
        '.answerBg',
        '.workTextWrap',
        '.stem_answer',
        '.blankInpDiv',
        '.num_option',
        '.num_option_dx',
        '.check_answer',
        '.check_answer_dx',
        '[role="radio"]',
        '[role="checkbox"]',
        'input[type="radio"]',
        'input[type="checkbox"]',
        'textarea',
        'input[type="text"]',
        '[contenteditable="true"]'
      ].join(',');
      const clean = (value, maxLength = 220) => {
        const text = String(value || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
        return text.length > maxLength ? text.slice(0, maxLength) + '...' : text;
      };
      const attrs = (element) => {
        const result = {};
        if (!element || !element.attributes) return result;
        for (const attr of Array.from(element.attributes)) {
          const name = attr.name;
          if (String(name || '').toLowerCase() === 'action') continue;
          const value = clean(attr.value, 360);
          if (
            name === 'href' ||
            name === 'target' ||
            name === 'onclick' ||
            name === 'role' ||
            name === 'aria-label' ||
            name === 'title' ||
            name === 'name' ||
            name === 'value' ||
            name === 'data' ||
            name.startsWith('data-') ||
            attributeHint.test(name) ||
            navigationHint.test(value)
          ) {
            result[name] = value;
          }
        }
        return result;
      };
      const summary = (element) => {
        if (!element) return null;
        const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : null;
        return {
          tag: element.tagName ? element.tagName.toLowerCase() : '',
          id: element.id || undefined,
          className: clean(element.className, 160) || undefined,
          text: clean(element.innerText || element.textContent || '', 180) || undefined,
          attributes: attrs(element),
          rect: rect ? {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          } : undefined
        };
      };
      const chainFor = (target) => {
        const chain = [];
        let current = target && target.nodeType === 1 ? target : null;
        while (current && chain.length < 8) {
          chain.push(current);
          current = current.parentElement;
        }
        return chain;
      };
      const clickableFor = (target) => {
        return target && target.closest ? target.closest([
          'a[href]',
          'area[href]',
          'button',
          '[role="button"]',
          '[onclick]',
          '[data-url]',
          '[data-href]',
          '[data-target-url]',
          '[data-courseid]',
          '[courseid]',
          '[courseId]',
          '[clazzid]',
          '[clazzId]',
          '[classId]'
        ].join(',')) : null;
      };
      const isAnswerInteraction = (target) => {
        for (const element of chainFor(target)) {
          if (element.matches && element.matches(answerInteractionSelector)) return true;
          const inlineHandler = (element.getAttribute && element.getAttribute('onclick')) || String(element.onclick || '');
          if (answerInlineHandlerHint.test(inlineHandler)) return true;
        }
        return false;
      };
      const normalizeUrl = (rawValue) => {
        let raw = String(rawValue || '').replace(/&amp;/g, '&').replace(/\\\\u0026/g, '&').trim();
        raw = raw.replace(/^[\`'"]+|[\`'",;)\\]]+$/g, '');
        if (!raw || raw === 'about:blank' || /^javascript:/i.test(raw)) return '';
        try {
          const url = new URL(raw, window.location.href).toString();
          return /^https?:\\/\\//i.test(url) ? url : '';
        } catch {
          return '';
        }
      };
      const addUrl = (list, rawValue) => {
        const url = normalizeUrl(rawValue);
        if (url && !list.includes(url)) list.push(url);
      };
      const urlsFromText = (text) => {
        const list = [];
        const value = String(text || '');
        for (const match of value.matchAll(/https?:\\/\\/[^\\s"'<>\\\\)]+/gi)) addUrl(list, match[0]);
        for (const match of value.matchAll(/(?:^|["'\`])((?:\\/|\\.\\.?\\/)?(?:mooc2-ans|mooc-ans|mycourse|visit|course|zt|work)\\/[^"'\`<>\\s\\\\)]*)/gi)) addUrl(list, match[1]);
        for (const match of value.matchAll(/(\\/(?:mooc2-ans|mooc-ans|visit|mycourse|work)\\/[^\\s"'<>\\\\)]*)/gi)) addUrl(list, match[1]);
        return list;
      };
      const readParam = (text, names) => {
        for (const name of names) {
          const pattern = new RegExp(name + "\\\\s*[:=]\\\\s*([^&\\\\s,;)}]+)", "i");
          const match = String(text || '').match(pattern);
          if (match && match[1]) return match[1].replace(/^[\\"']+|[\\"']+$/g, '');
        }
        return '';
      };
      const courseParams = (chain) => {
        const chunks = [];
        for (const element of chain) {
          const record = attrs(element);
          for (const key of Object.keys(record)) chunks.push(key + '=' + record[key]);
        }
        const text = chunks.join('&');
        return {
          courseid: readParam(text, ['courseid', 'courseId']),
          clazzid: readParam(text, ['clazzid', 'clazzId', 'classid', 'classId']),
          cpi: readParam(text, ['cpi']),
          enc: readParam(text, ['enc'])
        };
      };
      const buildCourseUrl = (params) => {
        if (!params.courseid || !params.clazzid || !params.cpi || !params.enc) return '';
        const query = new URLSearchParams({
          courseid: params.courseid,
          clazzid: params.clazzid,
          cpi: params.cpi,
          enc: params.enc,
          t: String(Date.now()),
          pageHeader: '8',
          v: '2',
          hideHead: '0'
        });
        return 'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?' + query.toString();
      };
      const isLikelyNavigation = (url) => {
        if (!/^https?:\\/\\//i.test(url)) return false;
        if (blockedInternalTabUrl.test(String(url || ''))) return false;
        if (/\\.(?:png|jpe?g|gif|webp|svg|ico)(?:[?#]|$)/i.test(url)) return false;
        if (/\\/visit\\/interaction(?:[?#]|$)/i.test(url)) return false;
        return /(mycourse\\/stu|mooc2\\/work\\/dowork|stucoursemiddle|courseid=|courseId=|clazzid=|clazzId=|classId=|workId=|answerId=)/i.test(url);
      };
      const candidatesFor = (target) => {
        const chain = chainFor(target);
        const list = [];
        for (const element of chain) {
          const anchor = element.closest && element.closest('a[href], area[href]');
          if (anchor && anchor.href) addUrl(list, anchor.href);
          const record = attrs(element);
          for (const value of Object.values(record)) {
            addUrl(list, value);
            urlsFromText(value).forEach((url) => addUrl(list, url));
          }
          const inlineHandler = (element.getAttribute && element.getAttribute('onclick')) || String(element.onclick || '');
          urlsFromText(inlineHandler).forEach((url) => addUrl(list, url));
        }
        addUrl(list, buildCourseUrl(courseParams(chain)));
        return list.filter(isLikelyNavigation);
      };
      const post = (message) => {
        try {
          window.top.postMessage(message, '*');
        } catch (_) {}
      };
      document.addEventListener('click', (event) => {
        const target = event.target && event.target.nodeType === 1 ? event.target : null;
        if (!target) return;
        if (isAnswerInteraction(target)) return;
        const chain = chainFor(target);
        const clickable = clickableFor(target);
        const candidates = candidatesFor(target);
        const selectedUrl = candidates[0] || '';
        const payload = {
          source: 'webview:frame-click-debug',
          level: 'info',
          message: selectedUrl ? 'Frame click captured with navigation candidate: ' + selectedUrl : 'Frame click captured without navigation candidate',
          frameUrl: window.location.href,
          title: document.title,
          target: summary(target),
          clickable: summary(clickable),
          ancestors: chain.map(summary),
          candidates,
          courseParams: courseParams(chain),
          selectedUrl,
          client: {
            x: Math.round(event.clientX),
            y: Math.round(event.clientY)
          }
        };
        if (selectedUrl || /chaoxing/i.test(window.location.hostname) || chain.some((element) => navigationHint.test(element.outerHTML || ''))) {
          post({ __studyPilotFrameClickDebug: true, payload });
        }
        if (selectedUrl) {
          post({
            __studyPilotFrameOpenTab: true,
            url: selectedUrl,
            title: clean((clickable && clickable.textContent) || document.title || selectedUrl, 80)
          });
          event.preventDefault();
          event.stopPropagation();
        }
      }, true);
    })();
  `;
}

async function injectFrameClickBridge(frame: any, reason: string) {
  try {
    if (!frame || !frame.url || frame.url === 'about:blank') return;
    await frame.executeJavaScript(frameClickBridgeSource(), false);
    writeErrorLog({
      source: 'webview:frame-bridge-inject',
      level: 'info',
      message: `Injected frame click bridge: ${frame.url}`,
      url: frame.url,
      details: {
        reason,
        frameTreeNodeId: frame.frameTreeNodeId,
        routingId: frame.routingId
      }
    });
  } catch (error) {
    writeUnknownError('webview:frame-bridge-inject-failed', error, {
      reason,
      frameUrl: frameUrl(frame)
    }, 'warn');
  }
}

async function injectAllFrameClickBridges(contents: any, reason: string) {
  try {
    const frames = contents?.mainFrame?.framesInSubtree || [];
    await Promise.all(frames
      .filter((frame: any) => frame?.parent)
      .map((frame: any) => injectFrameClickBridge(frame, reason)));
  } catch (error) {
    writeUnknownError('webview:frame-bridge-inject-all-failed', error, { reason }, 'warn');
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    titleBarStyle: 'hidden', // Premium borderless titlebar
    titleBarOverlay: {
      color: '#080711',
      symbolColor: '#f8fafc',
      height: 40
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true // Crucial for embedding the learning webpage in left pane
    },
    icon: path.join(__dirname, '../public/icon.png')
  });

  // Load Vite Dev server if available, otherwise load built dist
  const devUrl = 'http://localhost:3000';
  if (app.isPackaged || process.env.NODE_ENV === 'production') {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  } else {
    // Try dev server first, fallback to built files
    const http = require('http');
    const req = http.get(devUrl, (res: any) => {
      if (res.statusCode === 200 && mainWindow) {
        mainWindow.loadURL(devUrl);
        mainWindow.webContents.openDevTools();
      } else if (mainWindow) {
        mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
      }
      req.destroy();
    });
    req.on('error', () => {
      mainWindow?.loadFile(path.join(__dirname, '../dist/index.html'));
      req.destroy();
    });
    req.setTimeout(2000, () => {
      mainWindow?.loadFile(path.join(__dirname, '../dist/index.html'));
      req.destroy();
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (shouldSkipConsoleMessage(message)) return;
    if (level < 2) return;
    const tag = level >= 2 ? 'WARN' : 'INFO';
    console.log(`[StudyPilot Renderer ${tag}] ${message} (${sourceId}:${line})`);
    writeErrorLog({
      source: 'renderer:console',
      level: level >= 3 ? 'error' : 'warn',
      message,
      url: sourceId,
      line
    });
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return;
    console.error(`[StudyPilot Renderer] Failed to load ${validatedURL}: ${errorCode} ${errorDescription}`);
    writeErrorLog({
      source: 'renderer:did-fail-load',
      level: 'error',
      message: `${errorCode} ${errorDescription}`,
      url: validatedURL
    });
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    writeErrorLog({
      source: 'renderer:render-process-gone',
      level: 'fatal',
      message: `Renderer process gone: ${details.reason}`,
      details
    });
  });

  mainWindow.webContents.on('unresponsive', () => {
    writeErrorLog({
      source: 'renderer:unresponsive',
      level: 'warn',
      message: 'Renderer became unresponsive'
    });
  });
}

// Window actions
ipcMain.on('window:minimize', () => {
  mainWindow?.minimize();
});

ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});

ipcMain.on('window:close', () => {
  mainWindow?.close();
});

// IPC Handler: Settings
ipcMain.handle('settings:get', () => {
  const db = readDB();
  return db.settings;
});

ipcMain.handle('settings:set', (_, settings) => {
  const db = readDB();
  db.settings = settings;
  writeDB(db);
  return { success: true };
});

ipcMain.handle('settings:get-webview-preload', () => {
  return path.join(__dirname, 'preload-webview.js');
});

ipcMain.handle('diagnostics:get-error-log-path', () => {
  return getErrorLogPath();
});

ipcMain.handle('session:clear-webview-login', async () => {
  const webviewSession = session.fromPartition(WEBVIEW_PARTITION);
  await webviewSession.clearStorageData();
  await webviewSession.clearCache();
  return { success: true };
});

// System logs
ipcMain.on('system:log', (_, payload: { level: string; message: string }) => {
  console.log(`[${payload.level.toUpperCase()}] ${payload.message}`);
});

ipcMain.on('diagnostics:error-log', (_, payload) => {
  writeErrorLog({
    source: payload?.source || 'renderer:diagnostics',
    level: payload?.level || 'error',
    message: String(payload?.message || 'Unknown renderer error'),
    stack: payload?.stack ? String(payload.stack) : undefined,
    url: payload?.url ? String(payload.url) : undefined,
    line: typeof payload?.line === 'number' ? payload.line : undefined,
    column: typeof payload?.column === 'number' ? payload.column : undefined,
    details: payload?.details
  });
});

// IPC Handler: Navigate WebView
ipcMain.handle('browser:navigate', async (_, url: string) => {
  if (!mainWindow) return { success: false, error: 'Main window not initialized' };
  // In a real Electron setup, we can control a webview directly from the renderer,
  // so this handles any backend sync or tab state.
  return { success: true, url };
});

// IPC Handler: OCR / Screenshot
ipcMain.handle('browser:screenshot', async (_, rect) => {
  if (!mainWindow) return { success: false, error: 'Main window not initialized' };
  
  try {
    const view = rect 
      ? await mainWindow.webContents.capturePage(rect)
      : await mainWindow.webContents.capturePage();
      
    const pngBuffer = view.toPNG();
    const base64Data = pngBuffer.toString('base64');
    
    return { 
      success: true, 
      image: `data:image/png;base64,${base64Data}` 
    };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

// IPC Handler: Page Automation Snapshot
ipcMain.handle('automation:snapshot', async () => {
  if (!mainWindow) return { success: false, error: 'Main window not initialized' };
  return { success: true, message: 'Forwarding snapshot request to webview container' };
});

// IPC Handler: Execute Approved Automation Plan
ipcMain.handle('automation:execute-plan', async (_, payload) => {
  if (!mainWindow) return { success: false, error: 'Main window not initialized' };
  return { success: true, payload };
});

// Helper to perform simple GET requests from native process
function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', (err) => { reject(err); });
  });
}

// IPC Handler: Fetch Font Decryption Table
ipcMain.handle('browser:fetch-font-table', async () => {
  const ttflist = [
    'https://cdn.ocsjs.com/resources/font/table.json',
    'https://www.forestpolice.org/ttf/2.0/table.json',
    'https://static.muketool.com/scripts/cx/v2/fonts/cxsecret.json'
  ];
  
  for (const url of ttflist) {
    try {
      const data = await fetchJson(url);
      if (data && typeof data === 'object') {
        return { success: true, table: data };
      }
    } catch (e: any) {
      console.error(`[StudyPilot Main] Failed to fetch font table from ${url}:`, e.message);
    }
  }
  return { success: false, error: 'All fallback font tables failed to resolve' };
});

app.whenReady().then(() => {
  pruneOldErrorLogs();
  createWindow();

  const webviewSession = session.fromPartition(WEBVIEW_PARTITION);
  webviewSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowedPermissions = new Set([
      'clipboard-read',
      'media',
      'geolocation',
      'notifications',
      'fullscreen',
      'pointerLock'
    ]);
    callback(allowedPermissions.has(permission));
  });
  webviewSession.on('will-download', (_event, item) => {
    const fileName = item.getFilename();
    item.setSavePath(path.join(app.getPath('downloads'), fileName));
  });

  // Intercept webview new window creation requests native-side and forward them
  // to the renderer so the embedded browser can create an internal tab.
  app.on('web-contents-created', (_, contents) => {
    if (contents.getType() === 'webview') {
      contents.on('console-message', (_event, level, message, line, sourceId) => {
        if (shouldSkipConsoleMessage(message)) return;
        if (level < 2) return;
        writeErrorLog({
          source: 'webview:console',
          level: level >= 3 ? 'error' : 'warn',
          message,
          url: sourceId,
          line
        });
      });

      contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
        if (errorCode === -3) return;
        writeErrorLog({
          source: 'webview:did-fail-load',
          level: 'error',
          message: `${errorCode} ${errorDescription}`,
          url: validatedURL
        });
      });

      contents.on('render-process-gone', (_event, details) => {
        writeErrorLog({
          source: 'webview:render-process-gone',
          level: 'fatal',
          message: `WebView process gone: ${details.reason}`,
          details
        });
      });

      contents.on('did-start-navigation', (details: any) => {
        logWebviewNavigation('webview:did-start-navigation', details);
      });

      contents.on('will-frame-navigate', (details: any) => {
        logWebviewNavigation('webview:will-frame-navigate', details);
      });

      contents.on('did-frame-navigate', (_event, targetUrl, httpResponseCode, httpStatusText, isMainFrame, frameProcessId, frameRoutingId) => {
        writeErrorLog({
          source: 'webview:did-frame-navigate',
          level: 'info',
          message: `webview:did-frame-navigate: ${targetUrl}`,
          url: targetUrl,
          details: {
            httpResponseCode,
            httpStatusText,
            isMainFrame,
            frameProcessId,
            frameRoutingId
          }
        });
        if (isMainFrame) {
          void injectAllFrameClickBridges(contents, 'main-frame-navigate');
        } else {
          const frame = webFrameMain.fromId(frameProcessId, frameRoutingId);
          void injectFrameClickBridge(frame, 'did-frame-navigate');
        }
      });

      contents.on('did-finish-load', () => {
        void injectAllFrameClickBridges(contents, 'did-finish-load');
      });

      const openInternalTab = (targetUrl: string, title?: string) => {
        if (/^(mailto|tel):/i.test(targetUrl)) {
          shell.openExternal(targetUrl);
          return;
        }
        if (!/^https?:\/\//i.test(targetUrl)) return;
        if (shouldBlockInternalTabUrl(targetUrl)) {
          writeErrorLog({
            source: 'webview:block-internal-tab',
            level: 'info',
            message: `Blocked form/save endpoint from opening as a tab: ${targetUrl}`,
            url: targetUrl,
            details: { title }
          });
          return;
        }
        if (mainWindow?.isDestroyed()) return;
        writeErrorLog({
          source: 'webview:open-internal-tab',
          level: 'info',
          message: `Opening internal tab: ${targetUrl}`,
          url: targetUrl,
          details: { title }
        });
        mainWindow?.webContents.send('browser:open-tab', { url: targetUrl, title });
      };

      contents.on('did-create-window', (childWindow) => {
        let closeScheduled = false;
        const closeChildWhenSettled = (reason: string) => {
          if (closeScheduled) return;
          closeScheduled = true;
          setTimeout(() => {
            try {
              writeErrorLog({
                source: 'webview:hidden-form-window-close',
                level: 'info',
                message: `Closing hidden form/save window: ${reason}`,
                url: childWindow.webContents.getURL()
              });
              if (!childWindow.isDestroyed()) childWindow.close();
            } catch (error) {
              writeUnknownError('webview:hidden-child-close', error, undefined, 'warn');
            }
          }, 2500);
        };
        const forwardChildUrl = (targetUrl: string) => {
          if (shouldBlockInternalTabUrl(targetUrl)) {
            writeErrorLog({
              source: 'webview:hidden-form-window',
              level: 'info',
              message: `Keeping form/save endpoint in hidden child window: ${targetUrl}`,
              url: targetUrl
            });
            try {
              childWindow.hide();
            } catch (error) {
              writeUnknownError('webview:hidden-child-hide', error, undefined, 'warn');
            }
            childWindow.webContents.once('did-stop-loading', () => closeChildWhenSettled('did-stop-loading'));
            childWindow.webContents.once('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
              writeErrorLog({
                source: 'webview:hidden-form-window-load-failed',
                level: errorCode === -3 ? 'info' : 'warn',
                message: `${errorCode} ${errorDescription}`,
                url: validatedURL || targetUrl
              });
              closeChildWhenSettled(`did-fail-load:${errorCode}`);
            });
            setTimeout(() => closeChildWhenSettled('timeout'), 15000);
            return;
          }
          let title = '';
          try {
            title = childWindow.webContents.getTitle();
          } catch (error) {
            writeUnknownError('webview:child-window-title', error);
          }
          openInternalTab(targetUrl, title);
          if (!childWindow.isDestroyed()) childWindow.close();
        };
        let initialUrl = '';
        try {
          initialUrl = childWindow.webContents.getURL();
        } catch (error) {
          writeUnknownError('webview:child-window-url', error);
        }
        if (initialUrl && initialUrl !== 'about:blank') forwardChildUrl(initialUrl);
        childWindow.webContents.on('will-navigate', (_event, targetUrl) => forwardChildUrl(targetUrl));
        childWindow.webContents.on('did-navigate', (_event, targetUrl) => forwardChildUrl(targetUrl));
      });

      contents.setWindowOpenHandler((details) => {
        const targetUrl = details.url || '';
        writeErrorLog({
          source: 'webview:set-window-open-handler',
          level: 'info',
          message: `Window open requested: ${targetUrl || 'about:blank'}`,
          url: targetUrl,
          details
        });
        if (!targetUrl || targetUrl === 'about:blank' || shouldBlockInternalTabUrl(targetUrl)) {
          return {
            action: 'allow',
            overrideBrowserWindowOptions: {
              show: false,
              webPreferences: {
                nodeIntegration: false,
                contextIsolation: true
              }
            }
          };
        }
        openInternalTab(targetUrl);
        return { action: 'deny' };
      });
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
