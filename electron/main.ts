import { app, BrowserWindow, Menu, clipboard, ipcMain, Notification, screen, session, shell, webFrameMain } from 'electron';
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
const BLOCKED_STAT_KNOWLEDGE_URL = /\/\/stat\d*-ans\.chaoxing\.com\/study-knowledge\/ans/i;
const INCOMPLETE_EXAM_LIST_PATH = /\/exam-ans\/mooc2\/exam\/exam-list\/?$/i;
const RELEASE_API_URL = 'https://api.github.com/repos/XiYue-FireFly/Xuexitong-Answer-Helper/releases/latest';
const RELEASES_PAGE_URL = 'https://github.com/XiYue-FireFly/Xuexitong-Answer-Helper/releases/latest';

installProcessErrorLogging();
if (process.platform === 'win32') app.setAppUserModelId('com.studypilot.desktop');

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

function shouldDropStatKnowledgeUrl(url: string) {
  return BLOCKED_STAT_KNOWLEDGE_URL.test(String(url || ''));
}

function isIncompleteExamListUrl(url: string) {
  try {
    const parsed = new URL(String(url || ''));
    if (!INCOMPLETE_EXAM_LIST_PATH.test(parsed.pathname)) return false;
    const query = parsed.searchParams;
    return !(
      query.has('courseId') ||
      query.has('courseid') ||
      query.has('classId') ||
      query.has('clazzid') ||
      query.has('relationId') ||
      query.has('examId') ||
      query.has('answerId')
    );
  } catch {
    return false;
  }
}

function isExamListUrl(url: string) {
  try {
    const parsed = new URL(String(url || ''));
    return INCOMPLETE_EXAM_LIST_PATH.test(parsed.pathname);
  } catch {
    return false;
  }
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

function compareVersion(left: string, right: string) {
  const clean = (value: string) => String(value || '').replace(/^v/i, '').split(/[.-]/).map((part) => Number(part) || 0);
  const leftParts = clean(left);
  const rightParts = clean(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function readRecentErrorLogs(limit = 80) {
  const logPath = getErrorLogPath();
  if (!fs.existsSync(logPath)) return { success: true, path: logPath, entries: [] };
  const lines = fs.readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-Math.max(1, Math.min(limit, 300)));
  const entries = lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return {
        timestamp: new Date().toISOString(),
        level: 'error',
        source: 'diagnostics:parse',
        message: line
      };
    }
  }).reverse();
  return { success: true, path: logPath, entries };
}

function createRequestHeaders(url: string) {
  const headers: Record<string, string> = {
    'User-Agent': `StudyPilot/${app.getVersion()} (Windows Electron)`,
    Accept: 'application/json, text/plain;q=0.8, */*;q=0.5'
  };
  if (/api\.github\.com/i.test(url)) headers['X-GitHub-Api-Version'] = '2022-11-28';
  return headers;
}

function safeParseJson(text: string, url: string) {
  try {
    return JSON.parse(text);
  } catch (error: any) {
    const preview = text.replace(/\s+/g, ' ').trim().slice(0, 300) || '空响应';
    throw new Error(`接口未返回 JSON：${preview}`);
  }
}

function buildWebviewContextMenu(contents: Electron.WebContents, params: Electron.ContextMenuParams) {
  const template: Electron.MenuItemConstructorOptions[] = [];
  const editFlags = params.editFlags || {};
  const hasSelection = Boolean(params.selectionText);
  const hasLink = Boolean(params.linkURL);
  const isEditable = Boolean(params.isEditable);

  if (hasLink) {
    template.push(
      {
        label: '在新标签页打开链接',
        click: () => mainWindow?.webContents.send('browser:open-tab', { url: params.linkURL, title: params.linkText || '新标签页' })
      },
      {
        label: '复制链接地址',
        click: () => clipboard.writeText(params.linkURL)
      },
      { type: 'separator' }
    );
  }

  if (isEditable) {
    template.push(
      { label: '撤销', role: 'undo', enabled: Boolean(editFlags.canUndo) },
      { label: '重做', role: 'redo', enabled: Boolean(editFlags.canRedo) },
      { type: 'separator' },
      { label: '剪切', role: 'cut', enabled: Boolean(editFlags.canCut) },
      { label: '复制', role: 'copy', enabled: Boolean(editFlags.canCopy) },
      { label: '粘贴', role: 'paste', enabled: Boolean(editFlags.canPaste) },
      { label: '全选', role: 'selectAll', enabled: Boolean(editFlags.canSelectAll) }
    );
  } else {
    template.push(
      { label: '后退', enabled: contents.canGoBack(), click: () => contents.goBack() },
      { label: '前进', enabled: contents.canGoForward(), click: () => contents.goForward() },
      { label: '刷新', click: () => contents.reload() },
      { type: 'separator' },
      { label: '复制', role: 'copy', enabled: hasSelection },
      { label: '全选', role: 'selectAll' }
    );
  }

  template.push(
    { type: 'separator' },
    {
      label: '复制当前页面地址',
      click: () => {
        const targetUrl = contents.getURL();
        if (targetUrl) clipboard.writeText(targetUrl);
      }
    },
    {
      label: '检查元素',
      click: () => contents.inspectElement(params.x, params.y)
    }
  );

  return Menu.buildFromTemplate(template);
}

function frameClickBridgeSource() {
  return `
    (() => {
      if (window.__studyPilotFrameClickBridge) return;
      window.__studyPilotFrameClickBridge = true;
      const navigationHint = /(mooc2-ans|mooc-ans|exam-ans|viewExamAnswer|goTest|jumpRetest|retest|mycourse|dowork|stucoursemiddle|courseid|courseId|clazzid|clazzId|classId|workId|answerId|examAnswerId|examId|cpi|chaoxing)/i;
      const attributeHint = /(course|clazz|class|work|answer|cpi|enc|url|href|target|mooc|chaoxing|exam)/i;
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
          '[role="option"]',
          '[onclick]',
          '[onclick*="viewExamAnswer"]',
          '[onclick*="goTest"]',
          '[tabindex][onclick]',
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
      const isNativeExamEntry = (target) => {
        for (const element of chainFor(target)) {
          const id = element.id || '';
          const className = String(element.className || '');
          const inlineHandler = (element.getAttribute && element.getAttribute('onclick')) || String(element.onclick || '');
          const text = clean(element.innerText || element.textContent || '', 40);
          if (/^(startBtn|tabIntoexam2)$/i.test(id)) return true;
          if (/(preEnterExam|enterExamCallBack|checkLoadError)/i.test(inlineHandler)) return true;
          if (/(entrybtn|confirm|btnBlue|next_btn_div)/i.test(className) && /进入考试/.test(text)) return true;
        }
        return false;
      };
      const normalizeUrl = (rawValue) => {
        let raw = String(rawValue || '').replace(/&amp;/g, '&').replace(/\\\\u0026/g, '&').trim();
        raw = raw.replace(/^[\`'"]+|[\`'",;)\\]]+$/g, '');
        if (!raw || raw === 'about:blank' || /^javascript:/i.test(raw)) return '';
        try {
          const url = repairExamStartUrl(new URL(raw, window.location.href)).toString();
          return /^https?:\\/\\//i.test(url) ? url : '';
        } catch {
          return '';
        }
      };
      const isBlankExamToken = (value) => {
        const normalized = String(value || '').trim();
        return !normalized || normalized === '?' || normalized.toLowerCase() === 'undefined' || normalized.toLowerCase() === 'null';
      };
      const readUrlParam = (urlText, names) => {
        try {
          const parsed = new URL(String(urlText || ''), window.location.href);
          for (const name of names) {
            const value = parsed.searchParams.get(name);
            if (!isBlankExamToken(value)) return value || '';
          }
        } catch (_) {}
        return readParam(urlText, names);
      };
      const readExamContextParam = (names) => {
        const fromUrl = readUrlParam(window.location.href, names);
        if (!isBlankExamToken(fromUrl)) return fromUrl;
        for (const name of names) {
          const element = document.querySelector('input[name="' + name + '"], input[id="' + name + '"], textarea[name="' + name + '"], [data-' + name + ']');
          const value = (element && (element.value || element.getAttribute('data-' + name))) || '';
          if (!isBlankExamToken(value)) return value;
        }
        return '';
      };
      const repairExamStartUrl = (url) => {
        if (!/\\/exam-ans\\/exam\\/test\\/reVersionTestStartNew/i.test(url.pathname)) return url;
        if (isBlankExamToken(url.searchParams.get('enc'))) {
          const enc = readExamContextParam(['enc', 'examEnc', 'spExamEnc']);
          if (!isBlankExamToken(enc)) url.searchParams.set('enc', enc);
        }
        if (isBlankExamToken(url.searchParams.get('openc'))) {
          const openc = readExamContextParam(['openc', 'spExamOpenC']);
          if (!isBlankExamToken(openc)) url.searchParams.set('openc', openc);
        }
        return url;
      };
      const addUrl = (list, rawValue) => {
        const url = normalizeUrl(rawValue);
        if (url && !list.includes(url)) list.push(url);
      };
      const urlsFromText = (text) => {
        const list = [];
        const value = String(text || '');
        for (const match of value.matchAll(/https?:\\/\\/[^\\s"'<>\\\\)]+/gi)) addUrl(list, match[0]);
        for (const match of value.matchAll(/(?:^|["'\`])((?:\\/|\\.\\.?\\/)?(?:mooc2-ans|mooc-ans|study-knowledge|mycourse|visit|course|zt|work)\\/[^"'\`<>\\s\\\\)]*)/gi)) addUrl(list, match[1]);
        for (const match of value.matchAll(/(\\/(?:mooc2-ans|mooc-ans|study-knowledge|visit|mycourse|work)\\/[^\\s"'<>\\\\)]*)/gi)) addUrl(list, match[1]);
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
      const splitInlineArgs = (rawArgs) => {
        const args = [];
        let current = '';
        let quote = '';
        const value = String(rawArgs || '');
        for (let index = 0; index < value.length; index += 1) {
          const char = value[index];
          if (quote) {
            if (char === quote && value[index - 1] !== '\\\\') quote = '';
            else current += char;
            continue;
          }
          if (char === "'" || char === '"') {
            quote = char;
            continue;
          }
          if (char === ',') {
            args.push(current.trim());
            current = '';
            continue;
          }
          current += char;
        }
        if (current.trim()) args.push(current.trim());
        return args.map((item) => String(item || '').replace(/^[\\'"]|[\\'"]$/g, '').trim());
      };
      const examNotesFromGoTest = (inlineHandler) => {
        const match = String(inlineHandler || '').match(/goTest\\s*\\(([\\s\\S]*?)\\)/i);
        if (!match || !match[1]) return '';
        const args = splitInlineArgs(match[1]);
        const courseId = args[0] || readParam(window.location.href, ['courseId', 'courseid']);
        const examId = args[1] || readParam(window.location.href, ['examId']);
        const answerId = args[2] || '';
        const paperId = args[4] || '';
        const examEnc = args[6] || readUrlParam(window.location.href, ['enc', 'stuenc']);
        const openc = readUrlParam(window.location.href, ['openc']);
        const classId = readParam(window.location.href, ['classId', 'clazzid', 'clazzId', 'classid']);
        const cpi = readParam(window.location.href, ['cpi']);
        if (!courseId || !examId || !classId || !cpi) return '';
        const query = new URLSearchParams({ courseId, classId, examId, cpi });
        if (!isBlankExamToken(answerId) && answerId !== '0') query.set('answerId', answerId);
        if (!isBlankExamToken(paperId) && paperId !== '0') query.set('paperId', paperId);
        if (!isBlankExamToken(examEnc)) {
          query.set('enc', examEnc);
          query.set('spExamEnc', examEnc);
        }
        if (!isBlankExamToken(openc)) {
          query.set('openc', openc);
          query.set('spExamOpenC', openc);
        }
        return 'https://mooc1.chaoxing.com/exam-ans/exam/test/examcode/examnotes?' + query.toString();
      };
      const isLikelyNavigation = (url) => {
        if (!/^https?:\\/\\//i.test(url)) return false;
        if (blockedInternalTabUrl.test(String(url || ''))) return false;
        try {
          const parsed = new URL(url, window.location.href);
          if (/\\/exam-ans\\/mooc2\\/exam\\/exam-list\\/?$/i.test(parsed.pathname)) return false;
        } catch (_) {}
        if (/\\/\\/stat\\d*-ans\\.chaoxing\\.com\\/study-knowledge\\/ans/i.test(url)) return false;
        if (/\\.(?:png|jpe?g|gif|webp|svg|ico)(?:[?#]|$)/i.test(url)) return false;
        if (/\\/visit\\/interaction(?:[?#]|$)/i.test(url)) return false;
        return /(exam\\/test\\/examcode\\/examnotes|exam\\/test\\/reVersionTestStartNew|exam\\/test\\/look|exam-ans\\/nycourse\\/transfer|mycourse\\/stu(?:[?#]|$)|mooc2\\/work\\/dowork|stucoursemiddle|courseid=|courseId=|clazzid=|clazzId=|classId=|workId=|answerId=|examAnswerId=|examId=)/i.test(url);
      };
      const candidatesFor = (target) => {
        const chain = chainFor(target);
        const list = [];
        const examCandidate = examAnswerCandidate(target);
        if (examCandidate && examCandidate.url) addUrl(list, examCandidate.url);
        for (const element of chain) {
          const anchor = element.closest && element.closest('a[href], area[href]');
          if (anchor && anchor.href) addUrl(list, anchor.href);
          const descendantAnchors = Array.from((element.querySelectorAll && element.querySelectorAll('a[href], area[href]')) || []);
          for (const item of descendantAnchors.slice(0, 8)) {
            if (item.href) addUrl(list, item.href);
          }
          const record = attrs(element);
          for (const value of Object.values(record)) {
            addUrl(list, value);
            urlsFromText(value).forEach((url) => addUrl(list, url));
          }
          const inlineHandler = (element.getAttribute && element.getAttribute('onclick')) || String(element.onclick || '');
          addUrl(list, examNotesFromGoTest(inlineHandler));
          urlsFromText(inlineHandler).forEach((url) => addUrl(list, url));
        }
        addUrl(list, buildCourseUrl(courseParams(chain)));
        return list.filter(isLikelyNavigation);
      };
      const examAnswerCandidate = (target) => {
        if (!target) return null;
        const containers = [];
        const addContainer = (element) => {
          if (element && !containers.includes(element)) containers.push(element);
        };
        for (const element of chainFor(target)) {
          addContainer(element);
          addContainer(element.closest && element.closest('[onclick*="viewExamAnswer"], [onclick*="goTest"], [role="option"], li, tr, .clearfix, .list, .list-item, .item, .exam, .exam-item'));
        }
        const anchorSelector = [
          'a[href*="exam-ans"]',
          'a[href*="mooc-ans"]',
          'a[href*="mooc2-ans"]',
          'a.listSubmit[href]',
          'a.insightBtn[href]'
        ].join(',');
        for (const container of containers) {
          const anchors = Array.from((container.querySelectorAll && container.querySelectorAll(anchorSelector)) || []);
          const selfAnchor = container.matches && container.matches(anchorSelector) ? container : null;
          for (const anchor of [selfAnchor].concat(anchors)) {
            const url = normalizeUrl((anchor && (anchor.href || (anchor.getAttribute && anchor.getAttribute('href')))) || '');
            if (url && isLikelyNavigation(url)) {
              return {
                url,
                title: clean((container.textContent || (anchor && anchor.textContent) || document.title || url), 80)
              };
            }
          }
        }
        return null;
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
        if (isNativeExamEntry(target)) return;
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

    // 捕获所有 [StudyPilot] 调试日志
    if (message.includes('[StudyPilot]')) {
      console.log(`[Main Window Debug] ${message}`);
      return;
    }

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

ipcMain.handle('diagnostics:get-recent-error-logs', (_event, limit?: number) => {
  try {
    return readRecentErrorLogs(typeof limit === 'number' ? limit : 80);
  } catch (error: any) {
    writeUnknownError('diagnostics:get-recent-error-logs', error);
    return { success: false, error: error?.message || '读取错误报告失败。', entries: [] };
  }
});

ipcMain.handle('app:check-update', async () => {
  try {
    const currentVersion = app.getVersion();
    const release = await fetchJson(RELEASE_API_URL);
    const latestVersion = String(release?.tag_name || release?.name || '').replace(/^v/i, '') || currentVersion;
    const assets = Array.isArray(release?.assets) ? release.assets : [];
    const winAsset = assets.find((asset: any) => /\.exe$/i.test(String(asset?.name || ''))) || assets[0];
    return {
      success: true,
      currentVersion,
      latestVersion,
      hasUpdate: compareVersion(latestVersion, currentVersion) > 0,
      releaseUrl: release?.html_url || RELEASES_PAGE_URL,
      downloadUrl: winAsset?.browser_download_url || release?.html_url || RELEASES_PAGE_URL,
      assetName: winAsset?.name || '',
      body: String(release?.body || '').slice(0, 3000),
      publishedAt: release?.published_at || release?.created_at || ''
    };
  } catch (error: any) {
    writeUnknownError('app:check-update', error);
    return {
      success: true,
      currentVersion: app.getVersion(),
      latestVersion: app.getVersion(),
      hasUpdate: false,
      releaseUrl: RELEASES_PAGE_URL,
      downloadUrl: RELEASES_PAGE_URL,
      assetName: '',
      body: '',
      publishedAt: '',
      warning: error?.message || '检查更新接口暂时不可用，已提供 Releases 下载页。'
    };
  }
});

ipcMain.handle('app:open-url', async (_event, targetUrl?: string) => {
  const url = String(targetUrl || RELEASES_PAGE_URL);
  if (!/^https?:\/\//i.test(url)) return { success: false, error: '只允许打开 http/https 链接。' };
  await shell.openExternal(url);
  return { success: true };
});

ipcMain.handle('app:notify', async (_event, payload?: { title?: string; body?: string }) => {
  const title = String(payload?.title || '学习通答题辅助工具').slice(0, 80);
  const body = String(payload?.body || '任务已完成。').slice(0, 240);
  try {
    if (!Notification.isSupported()) return { success: false, error: '当前系统不支持桌面通知。' };
    new Notification({ title, body, silent: false }).show();
    return { success: true };
  } catch (error: any) {
    writeUnknownError('app:notify', error, { title, body }, 'warn');
    return { success: false, error: error?.message || '发送桌面通知失败。' };
  }
});

ipcMain.handle('session:get-webview-state', () => {
  try {
    const webviewSession = session.fromPartition(WEBVIEW_PARTITION);
    return {
      success: true,
      partition: WEBVIEW_PARTITION,
      persistent: WEBVIEW_PARTITION.startsWith('persist:'),
      storagePath: webviewSession.getStoragePath()
    };
  } catch (error: any) {
    writeUnknownError('session:get-webview-state', error);
    return { success: false, error: error?.message || '读取网页登录持久化状态失败。' };
  }
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

// Helper to perform simple GET requests from native process.
function fetchText(url: string, redirectCount = 0): Promise<{ statusCode: number; statusMessage: string; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const request = client.get(url, { headers: createRequestHeaders(url) }, (res) => {
      const statusCode = res.statusCode || 0;
      const location = res.headers.location;
      if (statusCode >= 300 && statusCode < 400 && location) {
        res.resume();
        if (redirectCount >= 5) {
          reject(new Error('接口重定向次数过多。'));
          return;
        }
        const nextUrl = new URL(location, url).toString();
        fetchText(nextUrl, redirectCount + 1).then(resolve).catch(reject);
        return;
      }

      const chunks: Buffer[] = [];
      res.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          statusCode,
          statusMessage: res.statusMessage || '',
          headers: res.headers,
          text
        });
      });
    });
    request.setTimeout(15000, () => {
      request.destroy(new Error('接口请求超时。'));
    });
    request.on('error', (err) => {
      reject(err);
    });
  });
}

async function fetchJson(url: string): Promise<any> {
  const response = await fetchText(url);
  const preview = response.text.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`接口返回 ${response.statusCode}${response.statusMessage ? ` ${response.statusMessage}` : ''}：${preview || '空响应'}`);
  }
  return safeParseJson(response.text, url);
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

        // 捕获所有 [StudyPilot] 调试日志
        if (message.includes('[StudyPilot]')) {
          console.log(`[WebView Debug] ${message}`);
          writeErrorLog({
            source: 'webview:studypilot-debug',
            level: 'info',
            message,
            url: sourceId,
            line
          });
          return;
        }

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

      contents.on('context-menu', (_event, params) => {
        try {
          buildWebviewContextMenu(contents, params).popup();
        } catch (error) {
          writeUnknownError('webview:context-menu', error, { pageUrl: contents.getURL() }, 'warn');
        }
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
        if (shouldDropStatKnowledgeUrl(targetUrl)) {
          writeErrorLog({
            source: 'webview:drop-stat-knowledge-tab',
            level: 'info',
            message: `Dropped Chaoxing stat knowledge URL: ${targetUrl}`,
            url: targetUrl,
            details: { title }
          });
          return;
        }
        if (isIncompleteExamListUrl(targetUrl)) {
          writeErrorLog({
            source: 'webview:drop-incomplete-exam-list-tab',
            level: 'info',
            message: `Dropped intermediate Chaoxing exam-list URL: ${targetUrl}`,
            url: targetUrl,
            details: { title }
          });
          return;
        }
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
              message: `Keeping form/save endpoint in hidden child window until it finishes: ${targetUrl}`,
              url: targetUrl
            });
            try {
              childWindow.hide();
            } catch (error) {
              writeUnknownError('webview:hidden-child-hide', error, undefined, 'warn');
            }
            childWindow.webContents.once('did-finish-load', async () => {
              try {
                const currentUrl = childWindow.webContents.getURL();
                const titleText = childWindow.webContents.getTitle();
                const bodyText = await childWindow.webContents.executeJavaScript(
                  `(() => (document.body && document.body.innerText || document.documentElement && document.documentElement.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 1200))()`,
                  true
                );
                writeErrorLog({
                  source: 'webview:hidden-form-window-loaded',
                  level: /失败|错误|异常|fail|error/i.test(String(bodyText)) ? 'warn' : 'info',
                  message: String(bodyText || titleText || 'Hidden form/save window loaded').slice(0, 500),
                  url: currentUrl || targetUrl,
                  details: {
                    title: titleText,
                    text: bodyText
                  }
                });
                closeChildWhenSettled('did-finish-load');
              } catch (error) {
                writeUnknownError('webview:hidden-form-window-read-failed', error, { targetUrl }, 'warn');
              }
            });
            childWindow.webContents.once('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
              writeErrorLog({
                source: 'webview:hidden-form-window-load-failed',
                level: errorCode === -3 ? 'info' : 'warn',
                message: `${errorCode} ${errorDescription}`,
                url: validatedURL || targetUrl
              });
              if (errorCode !== -3) closeChildWhenSettled(`did-fail-load:${errorCode}`);
            });
            setTimeout(() => closeChildWhenSettled('timeout'), 45000);
            return;
          }
          if (shouldDropStatKnowledgeUrl(targetUrl)) {
            writeErrorLog({
              source: 'webview:hidden-stat-knowledge-window',
              level: 'info',
              message: `Closing Chaoxing stat knowledge child window: ${targetUrl}`,
              url: targetUrl
            });
            if (!childWindow.isDestroyed()) childWindow.close();
            return;
          }
          if (isIncompleteExamListUrl(targetUrl)) {
            writeErrorLog({
              source: 'webview:hidden-incomplete-exam-list-window',
              level: 'info',
              message: `Keeping intermediate Chaoxing exam-list in hidden child window: ${targetUrl}`,
              url: targetUrl
            });
            try {
              childWindow.hide();
            } catch (error) {
              writeUnknownError('webview:hidden-exam-list-hide', error, undefined, 'warn');
            }
            childWindow.webContents.once('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
              writeErrorLog({
                source: 'webview:hidden-incomplete-exam-list-load-failed',
                level: errorCode === -3 ? 'info' : 'warn',
                message: `${errorCode} ${errorDescription}`,
                url: validatedURL || targetUrl
              });
            });
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
        if (shouldDropStatKnowledgeUrl(targetUrl)) {
          return { action: 'deny' };
        }
        if (isIncompleteExamListUrl(targetUrl)) {
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
