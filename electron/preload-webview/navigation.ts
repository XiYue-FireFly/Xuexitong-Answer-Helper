import { ipcRenderer } from 'electron';
import { reportWebviewError, serializeBridgeError } from './bridge';
import { cleanText } from './dom-utils';

const NAVIGATION_HINT = /(mooc2-ans|mooc-ans|exam-ans|viewExamAnswer|goTest|jumpRetest|retest|mycourse|dowork|stucoursemiddle|courseid|courseId|clazzid|clazzId|classId|workId|answerId|examAnswerId|examId|cpi|chaoxing)/i;
const COURSE_PARAM_HINT = /(course|clazz|class|work|answer|cpi|enc|url|href|target|mooc|chaoxing|exam)/i;
const BLOCKED_INTERNAL_TAB_URL = /(addStudentWorkNewWeb|\/mooc-ans\/work\/(?:addStudentWorkNewWeb|save|submit)|\/work\/(?:addStudentWorkNewWeb|save|submit)|(?:submit|save)StudentWork|submitWork|saveWork)/i;
const ANSWER_INLINE_HANDLER_HINT = /(addMultipleChoice|addChoice|answerContentChange|loadAnswerSheet|setClozeTextAnswer|setBlankAnswer|fillBlank|blankAnswer)/i;
const SAVE_OR_SUBMIT_HANDLER_HINT = /(saveWork|submitValidate|noSubmit|btnBlueSubmit|submitCheckTimes|ready2Submit|submitWork|saveQuestion)/i;
const ANSWER_INTERACTION_SELECTOR = [
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
const DEBUG_ATTRIBUTE_ALLOWLIST = new Set([
  'href',
  'target',
  'onclick',
  'role',
  'aria-label',
  'title',
  'name',
  'value',
  'data',
  'qid',
  'qtype',
  'courseid',
  'courseId',
  'clazzid',
  'clazzId',
  'classId',
  'cpi',
  'enc'
]);

function compactDebugText(value: unknown, maxLength = 240) {
  const text = cleanText(String(value || ''));
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function debugAttributesFor(element: Element) {
  const attributes: Record<string, string> = {};
  for (const attr of Array.from(element.attributes || [])) {
    const name = attr.name;
    if (name.toLowerCase() === 'action') continue;
    const value = compactDebugText(attr.value, 360);
    if (
      DEBUG_ATTRIBUTE_ALLOWLIST.has(name) ||
      name.startsWith('data-') ||
      COURSE_PARAM_HINT.test(name) ||
      NAVIGATION_HINT.test(value)
    ) {
      attributes[name] = value;
    }
  }
  return attributes;
}

function isBlockedInternalTabUrl(url: string) {
  return BLOCKED_INTERNAL_TAB_URL.test(url);
}

function isIncompleteExamListUrl(url: string) {
  try {
    const parsed = new URL(url, window.location.href);
    if (!/\/exam-ans\/mooc2\/exam\/exam-list\/?$/i.test(parsed.pathname)) return false;
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
    const parsed = new URL(url, window.location.href);
    return /\/exam-ans\/mooc2\/exam\/exam-list\/?$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isStudyPilotApplyingAnswer() {
  return Number((window as any).__studyPilotApplyingAnswerUntil || 0) > Date.now();
}

function isAnswerInteractionTarget(target: Element | null) {
  for (const element of elementChainFor(target)) {
    if (element.matches?.(ANSWER_INTERACTION_SELECTOR)) return true;
    const inlineHandler = element.getAttribute?.('onclick') || String((element as any).onclick || '');
    if (ANSWER_INLINE_HANDLER_HINT.test(inlineHandler)) return true;
  }
  return false;
}

function isSaveOrSubmitTarget(target: Element | null) {
  for (const element of elementChainFor(target)) {
    const inlineHandler = element.getAttribute?.('onclick') || String((element as any).onclick || '');
    if (SAVE_OR_SUBMIT_HANDLER_HINT.test(inlineHandler)) return true;
    const elementText = compactDebugText(element.textContent || '', 40);
    if (/(\u6682\u65f6\u4fdd\u5b58|\u4fdd\u5b58|\u63d0\u4ea4|save|submit)/i.test(elementText)) {
      if (element.matches?.('a, button, [role="button"], input[type="button"], input[type="submit"]')) return true;
    }
  }
  return false;
}

function saveOrSubmitActionKey(target: Element | null) {
  const clickable = clickableAncestorFor(target);
  const element = (clickable || target) as HTMLElement | null;
  if (!element) return 'unknown';
  const id = element.id || '';
  const className = compactDebugText(element.className, 80);
  const inlineHandler = element.getAttribute?.('onclick') || '';
  const text = compactDebugText(element.textContent || '', 40);
  return [element.tagName?.toLowerCase() || 'element', id, className, inlineHandler, text].join('|');
}

function shouldBlockDuplicateSaveOrSubmit(target: Element | null) {
  const pageAny = window as any;
  const now = Date.now();
  const key = saveOrSubmitActionKey(target);
  const previous = pageAny.__studyPilotLastSaveSubmitClick || {};
  pageAny.__studyPilotLastSaveSubmitClick = { key, at: now };
  return previous.key === key && now - Number(previous.at || 0) < 800;
}

function isNativeExamEntryTarget(target: Element | null) {
  for (const element of elementChainFor(target)) {
    const id = (element as HTMLElement).id || '';
    const className = String((element as HTMLElement).className || '');
    const inlineHandler = element.getAttribute?.('onclick') || String((element as any).onclick || '');
    const text = compactDebugText(element.textContent || '', 40);
    if (/^(startBtn|tabIntoexam2)$/i.test(id)) return true;
    if (/(preEnterExam|enterExamCallBack|checkLoadError)/i.test(inlineHandler)) return true;
    if (/(jumpRetest|retest)/i.test(inlineHandler)) return true;
    if (/(重考|重新考试|再考一次|retake|retest)/i.test(text)) return true;
    if (/(entrybtn|confirm|btnBlue|next_btn_div)/i.test(className) && /进入考试/.test(text)) return true;
  }
  return false;
}

function debugElementSummary(element: Element | null) {
  if (!element) return null;
  const htmlElement = element as HTMLElement;
  const rect = htmlElement.getBoundingClientRect?.();
  return {
    tag: element.tagName.toLowerCase(),
    id: htmlElement.id || undefined,
    className: compactDebugText(htmlElement.className, 180) || undefined,
    text: compactDebugText(htmlElement.innerText || htmlElement.textContent || '', 180) || undefined,
    attributes: debugAttributesFor(element),
    rect: rect ? {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    } : undefined
  };
}

function clickableAncestorFor(element: Element | null) {
  return element?.closest?.([
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
  ].join(',')) || null;
}

function elementChainFor(element: Element | null) {
  const chain: Element[] = [];
  let current: Element | null = element;
  while (current && chain.length < 8) {
    chain.push(current);
    current = current.parentElement;
  }
  return chain;
}

function normalizeCandidateUrl(rawValue: unknown) {
  let raw = String(rawValue || '')
    .replace(/&amp;/g, '&')
    .replace(/\\u0026/g, '&')
    .trim();
  raw = raw.replace(/^[`'"]+|[`'",;)\]]+$/g, '');
  if (!raw || raw === 'about:blank' || /^javascript:/i.test(raw)) return '';
  try {
    const url = repairExamStartUrl(new URL(raw, window.location.href)).toString();
    return /^https?:\/\//i.test(url) ? url : '';
  } catch {
    return '';
  }
}

function isBlankExamToken(value: string | null | undefined) {
  const normalized = String(value || '').trim();
  return !normalized || normalized === '?' || normalized.toLowerCase() === 'undefined' || normalized.toLowerCase() === 'null';
}

function readUrlParam(urlText: string, names: string[]) {
  try {
    const parsed = new URL(urlText, window.location.href);
    for (const name of names) {
      const value = parsed.searchParams.get(name);
      if (!isBlankExamToken(value)) return value || '';
    }
  } catch {
    // Fall through to regex extraction.
  }
  return readParamFromText(urlText, names);
}

function readExamContextParam(names: string[]) {
  const fromUrl = readUrlParam(window.location.href, names);
  if (!isBlankExamToken(fromUrl)) return fromUrl;
  for (const selectorName of names) {
    const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `input[name="${selectorName}"], input[id="${selectorName}"], textarea[name="${selectorName}"], [data-${selectorName}]`
    );
    const value = element?.value || element?.getAttribute(`data-${selectorName}`) || '';
    if (!isBlankExamToken(value)) return value;
  }
  return '';
}

function repairExamStartUrl(url: URL) {
  if (!/\/exam-ans\/exam\/test\/reVersionTestStartNew/i.test(url.pathname)) return url;
  if (isBlankExamToken(url.searchParams.get('enc'))) {
    const enc = readExamContextParam(['enc', 'examEnc', 'spExamEnc']);
    if (!isBlankExamToken(enc)) url.searchParams.set('enc', enc);
  }
  if (isBlankExamToken(url.searchParams.get('openc'))) {
    const openc = readExamContextParam(['openc', 'spExamOpenC']);
    if (!isBlankExamToken(openc)) url.searchParams.set('openc', openc);
  }
  return url;
}

function urlsFromText(text: string) {
  const values: string[] = [];
  const add = (value: string | undefined) => {
    const url = normalizeCandidateUrl(value);
    if (url && !values.includes(url)) values.push(url);
  };

  for (const match of String(text || '').matchAll(/https?:\/\/[^\s"'<>\\)]+/gi)) {
    add(match[0]);
  }
  for (const match of String(text || '').matchAll(/(?:^|["'`])((?:\/|\.\.?\/)?(?:mooc2-ans|mooc-ans|study-knowledge|mycourse|visit|course|zt|work)\/[^"'`<>\s\\)]*)/gi)) {
    add(match[1]);
  }
  for (const match of String(text || '').matchAll(/(\/(?:mooc2-ans|mooc-ans|study-knowledge|visit|mycourse|work)\/[^\s"'<>\\)]*)/gi)) {
    add(match[1]);
  }
  return values;
}

function readParamFromText(text: string, names: string[]) {
  for (const name of names) {
    const pattern = new RegExp(`${name}\\s*[:=]\\s*["']?([^&"'\\s,;)}]+)`, 'i');
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return '';
}

function collectCourseParams(chain: Element[]) {
  const chunks: string[] = [];
  for (const element of chain) {
    const attributes = debugAttributesFor(element);
    for (const [key, value] of Object.entries(attributes)) chunks.push(`${key}=${value}`);
  }
  const text = chunks.join('&');
  return {
    courseid: readParamFromText(text, ['courseid', 'courseId']),
    clazzid: readParamFromText(text, ['clazzid', 'clazzId', 'classid', 'classId']),
    cpi: readParamFromText(text, ['cpi']),
    enc: readParamFromText(text, ['enc'])
  };
}

function buildChaoxingCourseUrl(params: ReturnType<typeof collectCourseParams>) {
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
  return `https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?${query.toString()}`;
}

function splitInlineArgs(rawArgs: string) {
  const args: string[] = [];
  let current = '';
  let quote = '';
  for (let index = 0; index < rawArgs.length; index += 1) {
    const char = rawArgs[index];
    if (quote) {
      if (char === quote && rawArgs[index - 1] !== '\\') quote = '';
      else current += char;
      continue;
    }
    if (char === '\'' || char === '"') {
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
  return args.map((item) => item.replace(/^['"]|['"]$/g, '').trim());
}

function buildExamNotesUrlFromGoTest(inlineHandler: string) {
  const match = String(inlineHandler || '').match(/goTest\s*\(([\s\S]*?)\)/i);
  if (!match?.[1]) return '';
  const args = splitInlineArgs(match[1]);
  const courseId = args[0] || readParamFromText(window.location.href, ['courseId', 'courseid']);
  const examId = args[1] || readParamFromText(window.location.href, ['examId']);
  const answerId = args[2] || '';
  const paperId = args[4] || '';
  const examEnc = args[6] || readUrlParam(window.location.href, ['enc', 'stuenc']);
  const openc = readUrlParam(window.location.href, ['openc']);
  const classId = readParamFromText(window.location.href, ['classId', 'clazzid', 'clazzId', 'classid']);
  const cpi = readParamFromText(window.location.href, ['cpi']);
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
  return `https://mooc1.chaoxing.com/exam-ans/exam/test/examcode/examnotes?${query.toString()}`;
}

function isLikelyCourseNavigationUrl(url: string) {
  if (!/^https?:\/\//i.test(url)) return false;
  if (isBlockedInternalTabUrl(url)) return false;
  if (isIncompleteExamListUrl(url)) return false;
  if (/\/\/stat\d*-ans\.chaoxing\.com\/study-knowledge\/ans/i.test(url)) return false;
  if (/\.(?:png|jpe?g|gif|webp|svg|ico)(?:[?#]|$)/i.test(url)) return false;
  if (/\/visit\/interaction(?:[?#]|$)/i.test(url)) return false;
  return /(exam\/test\/examcode\/examnotes|exam\/test\/reVersionTestStartNew|exam\/test\/look|exam-ans\/nycourse\/transfer|mycourse\/stu(?:[?#]|$)|mooc2\/work\/dowork|stucoursemiddle|courseid=|courseId=|clazzid=|clazzId=|classId=|workId=|answerId=|examAnswerId=|examId=)/i.test(url);
}

function collectClickNavigationCandidates(target: Element | null) {
  const chain = elementChainFor(target);
  const values: string[] = [];
  const add = (url: string) => {
    if (url && !values.includes(url)) values.push(url);
  };

  const examCandidate = findExamAnswerNavigationCandidate(target);
  if (examCandidate?.url) add(examCandidate.url);

  for (const element of chain) {
    const anchor = element.closest?.('a[href], area[href]') as HTMLAnchorElement | null;
    if (anchor?.href) add(anchor.href);
    const descendantAnchors = Array.from(element.querySelectorAll?.('a[href], area[href]') || []) as HTMLAnchorElement[];
    for (const item of descendantAnchors.slice(0, 8)) {
      if (item.href) add(item.href);
    }
    const attributes = debugAttributesFor(element);
    for (const value of Object.values(attributes)) {
      const normalized = normalizeCandidateUrl(value);
      if (normalized) add(normalized);
      urlsFromText(value).forEach(add);
    }
    const inlineHandler = element.getAttribute?.('onclick') || String((element as any).onclick || '');
    const goTestUrl = buildExamNotesUrlFromGoTest(inlineHandler);
    if (goTestUrl) add(goTestUrl);
    urlsFromText(inlineHandler).forEach(add);
  }

  const paramUrl = buildChaoxingCourseUrl(collectCourseParams(chain));
  if (paramUrl) add(paramUrl);
  return values.filter(isLikelyCourseNavigationUrl);
}

function findExamAnswerNavigationCandidate(target: Element | null) {
  if (!target) return null;
  const containers: Element[] = [];
  const addContainer = (element: Element | null | undefined) => {
    if (element && !containers.includes(element)) containers.push(element);
  };

  for (const element of elementChainFor(target)) {
    addContainer(element);
    addContainer(element.closest?.('[onclick*="viewExamAnswer"], [onclick*="goTest"], [role="option"], li, tr, .clearfix, .list, .list-item, .item, .exam, .exam-item'));
  }

  const anchorSelector = [
    'a[href*="exam-ans"]',
    'a[href*="mooc-ans"]',
    'a[href*="mooc2-ans"]',
    'a.listSubmit[href]',
    'a.insightBtn[href]'
  ].join(',');

  for (const container of containers) {
    const anchors = Array.from(container.querySelectorAll?.(anchorSelector) || []) as HTMLAnchorElement[];
    const selfAnchor = container.matches?.(anchorSelector) ? container as HTMLAnchorElement : null;
    for (const anchor of [selfAnchor, ...anchors]) {
      const url = normalizeCandidateUrl(anchor?.href || anchor?.getAttribute?.('href') || '');
      if (url && isLikelyCourseNavigationUrl(url)) {
        return {
          url,
          title: compactDebugText(container.textContent || anchor?.textContent || document.title || url, 80)
        };
      }
    }
  }

  return null;
}

function reportClickDebug(payload: any) {
  try {
    ipcRenderer.sendToHost('studypilot:click-debug', {
      source: 'webview:click-debug',
      level: 'info',
      url: window.location.href,
      title: document.title,
      ...payload
    });
  } catch {
    // Ignore diagnostics failures inside the page.
  }
}

function reportPageDiagnostic(payload: any) {
  if (!payload || typeof payload !== 'object') return;
  const source = typeof payload.source === 'string' && payload.source
    ? payload.source
    : 'webview:page-diagnostic';
  reportWebviewError(source, {
    level: payload.level || 'info',
    message: payload.message || source,
    url: payload.url || window.location.href,
    details: payload.details
  });
}

export function installBrowserNavigationPatch(syncAnswersBeforeSave: () => void) {
  const requestOpenTab = (targetUrl: string | URL | undefined | null, title?: string) => {
    const raw = String(targetUrl || '').trim();
    if (!raw || raw === 'about:blank' || /^javascript:/i.test(raw)) return '';
    try {
      const url = new URL(raw, window.location.href).toString();
      if (!/^https?:\/\//i.test(url)) return '';
      if (isBlockedInternalTabUrl(url)) return '';
      if (isIncompleteExamListUrl(url)) return '';
      ipcRenderer.sendToHost('studypilot:open-tab', { url, title: title || document.title || url });
      return url;
    } catch {
      return '';
    }
  };

  const makePopupProxy = () => {
    const locationProxy: any = {
      assign: (targetUrl: string | URL) => Boolean(requestOpenTab(targetUrl)),
      replace: (targetUrl: string | URL) => Boolean(requestOpenTab(targetUrl)),
      reload: () => window.location.reload()
    };
    Object.defineProperty(locationProxy, 'href', {
      get: () => 'about:blank',
      set: (targetUrl) => requestOpenTab(targetUrl)
    });

    const popupProxy: any = {
      closed: false,
      document: { write: () => undefined, close: () => undefined },
      focus: () => undefined,
      blur: () => undefined,
      close() { this.closed = true; }
    };
    Object.defineProperty(popupProxy, 'location', {
      get: () => locationProxy,
      set: (targetUrl) => requestOpenTab(targetUrl)
    });
    return popupProxy;
  };

  const patchSource = `
    (() => {
      if (window.__studyPilotNavigationPatch) return;
      window.__studyPilotNavigationPatch = true;
      const normalizeUrl = (targetUrl) => {
        const raw = String(targetUrl || '').trim();
        if (!raw || raw === 'about:blank' || /^javascript:/i.test(raw)) return '';
        try {
          return repairExamStartUrl(new URL(raw, window.location.href)).toString();
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
        return '';
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
      const isBlockedInternalTabUrl = (url) => /(addStudentWorkNewWeb|\\/mooc-ans\\/work\\/(?:addStudentWorkNewWeb|save|submit)|\\/work\\/(?:addStudentWorkNewWeb|save|submit)|(?:submit|save)StudentWork|submitWork|saveWork)/i.test(String(url || ''));
      const isIncompleteExamListUrl = (url) => {
        try {
          const parsed = new URL(String(url || ''), window.location.href);
          if (!/\\/exam-ans\\/mooc2\\/exam\\/exam-list\\/?$/i.test(parsed.pathname)) return false;
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
      };
      const isExamListUrl = (url) => {
        try {
          const parsed = new URL(String(url || ''), window.location.href);
          return /\\/exam-ans\\/mooc2\\/exam\\/exam-list\\/?$/i.test(parsed.pathname);
        } catch {
          return false;
        }
      };
      const isHandledInternalNavigationUrl = (url) => {
        if (!/^https?:\\/\\//i.test(String(url || ''))) return false;
        if (isBlockedInternalTabUrl(url)) return false;
        if (isIncompleteExamListUrl(url)) return false;
        if (/\\/\\/stat\\d*-ans\\.chaoxing\\.com\\/study-knowledge\\/ans/i.test(url)) return false;
        if (/\\.(?:png|jpe?g|gif|webp|svg|ico)(?:[?#]|$)/i.test(url)) return false;
        if (/\\/visit\\/interaction(?:[?#]|$)/i.test(url)) return false;
        return /(chaoxing\\.com|mooc2-ans|mooc-ans|exam-ans|exam\\/test\\/examcode\\/examnotes|exam\\/test\\/reVersionTestStartNew|exam\\/test\\/look|exam-ans\\/nycourse\\/transfer|mycourse\\/stu(?:[?#]|$)|mooc2\\/work\\/dowork|stucoursemiddle|courseid=|courseId=|clazzid=|clazzId=|classId=|workId=|answerId=|examAnswerId=|examId=)/i.test(url);
      };
      const requestOpenTab = (targetUrl, title, options = {}) => {
        const nextUrl = normalizeUrl(targetUrl);
        if (!nextUrl) return false;
        if (!/^https?:\\/\\//i.test(nextUrl)) return false;
        if (isBlockedInternalTabUrl(nextUrl)) return false;
        if (isIncompleteExamListUrl(nextUrl)) return false;
        if (!options.force && !isHandledInternalNavigationUrl(nextUrl)) return false;
        window.dispatchEvent(new CustomEvent('studypilot:open-tab-request', {
          detail: { url: nextUrl, title: title || document.title || nextUrl }
        }));
        return true;
      };
      const makePopupProxy = () => {
        const locationProxy = {
          assign: (targetUrl) => requestOpenTab(targetUrl),
          replace: (targetUrl) => requestOpenTab(targetUrl),
          reload: () => window.location.reload()
        };
        Object.defineProperty(locationProxy, 'href', {
          get: () => 'about:blank',
          set: (targetUrl) => requestOpenTab(targetUrl)
        });
        const popupProxy = {
          closed: false,
          document: { write: () => undefined, close: () => undefined },
          focus: () => undefined,
          blur: () => undefined,
          close() { this.closed = true; }
        };
        Object.defineProperty(popupProxy, 'location', {
          get: () => locationProxy,
          set: (targetUrl) => requestOpenTab(targetUrl)
        });
        return popupProxy;
      };
      const cleanText = (value, maxLength = 360) => {
        const text = String(value || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
        return text.length > maxLength ? text.slice(0, maxLength) + '...' : text;
      };
      const shouldLogSubmitUrl = (url) => /(addStudentWorkNewWeb|saveWork|submit|work|answer|mooc-ans|exam-ans)/i.test(String(url || ''));
      const reportDiagnostic = (payload) => {
        try {
          window.dispatchEvent(new CustomEvent('studypilot:page-diagnostic', {
            detail: {
              level: 'info',
              url: window.location.href,
              title: document.title,
              ...payload
            }
          }));
        } catch (_) {}
      };
      const summarizeForm = (form) => {
        const fields = [];
        try {
          const elements = Array.from(form.elements || []);
          for (const element of elements) {
            const name = element.name || element.id || '';
            if (!name) continue;
            if (!/^(answer\\d+|answerId|workId|courseId|courseid|classId|clazzid|cpi|enc|standardEnc|token|totalQuestionNum|pyFlag|api|jobid)/i.test(name)) continue;
            const value = 'value' in element ? element.value : '';
            fields.push({
              name,
              value: cleanText(value, /^answer\\d+$/i.test(name) ? 120 : 240)
            });
            if (fields.length >= 80) break;
          }
        } catch (_) {}
        return {
          action: normalizeUrl(form.getAttribute('action') || form.action || window.location.href) || String(form.getAttribute('action') || form.action || ''),
          method: String(form.getAttribute('method') || form.method || 'GET').toUpperCase(),
          target: form.getAttribute('target') || form.target || '',
          fieldCount: fields.length,
          fields
        };
      };
      try {
        const originalFetch = window.fetch && window.fetch.bind(window);
        if (originalFetch) {
          window.fetch = async (...args) => {
            const requestUrl = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
            try {
              const response = await originalFetch(...args);
              if (shouldLogSubmitUrl(requestUrl)) {
                let responseText = '';
                try {
                  responseText = await response.clone().text();
                } catch (_) {}
                reportDiagnostic({
                  source: 'webview:page-fetch-result',
                  level: response.ok ? 'info' : 'warn',
                  message: '页面 fetch 返回 ' + response.status + ' ' + (response.statusText || ''),
                  url: normalizeUrl(requestUrl) || window.location.href,
                  details: {
                    requestUrl: String(requestUrl || ''),
                    status: response.status,
                    statusText: response.statusText,
                    responseText: cleanText(responseText, 1200)
                  }
                });
              }
              return response;
            } catch (error) {
              if (shouldLogSubmitUrl(requestUrl)) {
                reportDiagnostic({
                  source: 'webview:page-fetch-failed',
                  level: 'error',
                  message: error && error.message ? error.message : String(error),
                  url: normalizeUrl(requestUrl) || window.location.href,
                  details: { requestUrl: String(requestUrl || '') }
                });
              }
              throw error;
            }
          };
        }
      } catch (_) {}
      try {
        const originalXhrOpen = XMLHttpRequest.prototype.open;
        const originalXhrSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url, ...args) {
          this.__studyPilotRequest = { method, url: String(url || '') };
          return originalXhrOpen.apply(this, [method, url, ...args]);
        };
        XMLHttpRequest.prototype.send = function(body) {
          const request = this.__studyPilotRequest || {};
          const requestUrl = String(request.url || '');
          if (shouldLogSubmitUrl(requestUrl)) {
            this.addEventListener('loadend', () => {
              reportDiagnostic({
                source: 'webview:page-xhr-result',
                level: this.status >= 200 && this.status < 400 ? 'info' : 'warn',
                message: '页面 XHR 返回 ' + (request.method || '') + ' ' + this.status + ' ' + (this.statusText || ''),
                url: normalizeUrl(requestUrl) || window.location.href,
                details: {
                  method: request.method,
                  requestUrl,
                  status: this.status,
                  statusText: this.statusText,
                  requestBody: cleanText(body, 1000),
                  responseText: cleanText(this.responseText, 1200)
                }
              });
            });
          }
          return originalXhrSend.call(this, body);
        };
      } catch (_) {}
      try {
        const originalSubmit = HTMLFormElement.prototype.submit;
        HTMLFormElement.prototype.submit = function() {
          const summary = summarizeForm(this);
          if (shouldLogSubmitUrl(summary.action) || summary.fields.length > 0) {
            reportDiagnostic({
              source: 'webview:page-form-submit',
              level: 'info',
              message: '页面调用 form.submit',
              url: summary.action || window.location.href,
              details: summary
            });
          }
          return originalSubmit.apply(this, arguments);
        };
        document.addEventListener('submit', (event) => {
          const form = event.target;
          if (!(form instanceof HTMLFormElement)) return;
          const summary = summarizeForm(form);
          if (shouldLogSubmitUrl(summary.action) || summary.fields.length > 0) {
            reportDiagnostic({
              source: 'webview:page-form-submit-event',
              level: 'info',
              message: '页面触发表单 submit 事件',
              url: summary.action || window.location.href,
              details: {
                ...summary,
                defaultPrevented: event.defaultPrevented
              }
            });
          }
        }, true);
      } catch (_) {}
      try {
        const originalAlert = window.alert.bind(window);
        window.alert = (message) => {
          reportDiagnostic({
            source: 'webview:page-alert',
            level: /失败|错误|异常|fail|error/i.test(String(message || '')) ? 'warn' : 'info',
            message: cleanText(message, 800)
          });
          return originalAlert(message);
        };
      } catch (_) {}
      try {
        const originalConfirm = window.confirm.bind(window);
        window.confirm = (message) => {
          reportDiagnostic({
            source: 'webview:page-confirm',
            level: 'info',
            message: cleanText(message, 800)
          });
          return originalConfirm(message);
        };
      } catch (_) {}
      try {
        const seenTexts = new Set();
        const scanPageMessage = () => {
          const text = cleanText(document.body && document.body.innerText, 1200);
          const match = text.match(/[^\\n。；;]*(保存失败|提交失败|保存成功|提交成功|作业提交失败|失败|错误|异常|success|fail|error)[^\\n。；;]*/i);
          if (!match) return;
          const message = cleanText(match[0], 500);
          if (seenTexts.has(message)) return;
          seenTexts.add(message);
          reportDiagnostic({
            source: 'webview:page-visible-message',
            level: /失败|错误|异常|fail|error/i.test(message) ? 'warn' : 'info',
            message,
            details: { href: window.location.href }
          });
        };
        const observer = new MutationObserver(() => window.setTimeout(scanPageMessage, 60));
        if (document.body) observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        window.setTimeout(scanPageMessage, 400);
      } catch (_) {}
      const originalOpen = window.open.bind(window);
      window.open = (targetUrl, target, features) => {
        const nextUrl = normalizeUrl(targetUrl);
        if (nextUrl && isBlockedInternalTabUrl(nextUrl)) {
          return originalOpen(targetUrl, target, features);
        }
        if (requestOpenTab(targetUrl, undefined, { force: true })) return makePopupProxy();
        return originalOpen(targetUrl, target, features);
      };
      document.addEventListener('click', (event) => {
        const element = event.target && event.target.closest ? event.target.closest('a[href], area[href]') : null;
        if (!element) return;
        const href = element.getAttribute('href') || '';
        const target = (element.getAttribute('target') || '').toLowerCase();
        if (!href || /^javascript:/i.test(href)) return;
        if (target === '_blank' || target === 'blank') {
          if (requestOpenTab(element.href, element.textContent && element.textContent.trim(), { force: true })) {
            event.preventDefault();
          }
        }
      }, true);
    })();
  `;
  const inject = () => {
    try {
      const script = document.createElement('script');
      script.textContent = patchSource;
      (document.documentElement || document.head || document.body)?.appendChild(script);
      script.remove();
    } catch {
      // Ignore injection failures; Electron-level popup handling remains active.
    }
  };
  if (document.documentElement || document.head || document.body) inject();
  else document.addEventListener('DOMContentLoaded', inject, { once: true });

  window.addEventListener('studypilot:open-tab-request' as any, ((event: CustomEvent) => {
    requestOpenTab(event.detail?.url, event.detail?.title);
  }) as EventListener);

  window.addEventListener('studypilot:page-diagnostic' as any, ((event: CustomEvent) => {
    reportPageDiagnostic(event.detail);
  }) as EventListener);

  try {
    const originalAlert = window.alert.bind(window);
    window.alert = ((message?: any) => {
      reportWebviewError('webview:alert', {
        level: 'info',
        message: compactDebugText(message, 500)
      });
      return originalAlert(message);
    }) as typeof window.alert;
  } catch {
    // Some pages lock window.alert.
  }

  try {
    const originalFetch = window.fetch?.bind(window);
    if (originalFetch) {
      window.fetch = (async (...args: Parameters<typeof fetch>) => {
        const requestUrl = typeof args[0] === 'string' ? args[0] : (args[0] as Request)?.url || '';
        try {
          const response = await originalFetch(...args);
          if (/addStudentWorkNewWeb|saveWork|submit|work/i.test(String(requestUrl))) {
            reportWebviewError('webview:fetch-result', {
              level: response.ok ? 'info' : 'warn',
              message: `fetch ${response.status} ${response.statusText}`,
              url: normalizeCandidateUrl(requestUrl) || window.location.href,
              details: { requestUrl, status: response.status, statusText: response.statusText }
            });
          }
          return response;
        } catch (error) {
          reportWebviewError('webview:fetch-failed', {
            message: serializeBridgeError(error).message,
            stack: serializeBridgeError(error).stack,
            url: normalizeCandidateUrl(requestUrl) || window.location.href,
            details: { requestUrl }
          });
          throw error;
        }
      }) as typeof window.fetch;
    }
  } catch {
    // Ignore instrumentation failures.
  }

  try {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function patchedOpen(method: string, url: string | URL, ...args: any[]) {
      (this as any).__studyPilotRequest = {
        method,
        url: String(url || '')
      };
      return (originalOpen as any).apply(this, [method, url, ...args]);
    };
    XMLHttpRequest.prototype.send = function patchedSend(body?: Document | XMLHttpRequestBodyInit | null) {
      const request = (this as any).__studyPilotRequest || {};
      const requestUrl = String(request.url || '');
      const shouldLog = /addStudentWorkNewWeb|saveWork|submit|work/i.test(requestUrl);
      if (shouldLog) {
        this.addEventListener('loadend', () => {
          reportWebviewError('webview:xhr-result', {
            level: this.status >= 200 && this.status < 400 ? 'info' : 'warn',
            message: `xhr ${request.method || ''} ${this.status} ${this.statusText || ''}`,
            url: normalizeCandidateUrl(requestUrl) || window.location.href,
            details: {
              method: request.method,
              requestUrl,
              status: this.status,
              statusText: this.statusText,
              responseText: compactDebugText(this.responseText, 800)
            }
          });
        });
      }
      return originalSend.call(this, body as any);
    };
  } catch {
    // Ignore instrumentation failures.
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    if ((data as any).__studyPilotFrameClickDebug) {
      const payload = (data as any).payload || {};
      reportClickDebug({
        ...payload,
        source: payload.source || 'webview:frame-click-debug',
        level: payload.level || 'info',
        parentUrl: window.location.href,
        frameOrigin: event.origin
      });
    }

    if ((data as any).__studyPilotFrameOpenTab) {
      requestOpenTab((data as any).url, (data as any).title);
    }
  });

  const originalOpen = window.open.bind(window);

  window.open = ((targetUrl?: string | URL, target?: string, features?: string) => {
    if (targetUrl && requestOpenTab(targetUrl)) return makePopupProxy() as Window;
    return originalOpen(targetUrl as any, target, features);
  }) as typeof window.open;

  document.addEventListener('click', (event) => {
    const anchor = (event.target as HTMLElement | null)?.closest?.('a[target="_blank"], a[target="blank"]') as HTMLAnchorElement | null;
    if (!anchor?.href) return;
    const href = anchor.getAttribute('href') || '';
    if (!href || href.startsWith('javascript:')) return;
    if (requestOpenTab(anchor.href, cleanText(anchor.textContent || ''))) {
      event.preventDefault();
    }
  }, true);

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (isSaveOrSubmitTarget(target)) {
      if (shouldBlockDuplicateSaveOrSubmit(target)) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        reportWebviewError('webview:save-submit-duplicate-blocked', {
          level: 'info',
          message: 'Blocked duplicate save/submit click within 800ms.',
          details: {
            target: debugElementSummary(target),
            clickable: debugElementSummary(clickableAncestorFor(target))
          }
        });
        return;
      }
      try {
        syncAnswersBeforeSave();
      } catch (error) {
        reportWebviewError('webview:sync-before-save-failed', {
          message: serializeBridgeError(error).message,
          stack: serializeBridgeError(error).stack
        });
      }
    }
    if (isStudyPilotApplyingAnswer() || isAnswerInteractionTarget(target)) return;
    if (isNativeExamEntryTarget(target)) {
      reportClickDebug({
        message: 'Native exam entry click allowed; page script will handle confirmation/navigation.',
        target: debugElementSummary(target),
        clickable: debugElementSummary(clickableAncestorFor(target)),
        ancestors: elementChainFor(target).map(debugElementSummary),
        candidates: [],
        selectedUrl: ''
      });
      return;
    }

    const clickable = clickableAncestorFor(target);
    const chain = elementChainFor(target);
    const candidates = collectClickNavigationCandidates(target);
    const selectedUrl = candidates[0] || '';
    const payload = {
      message: selectedUrl ? `Click captured with navigation candidate: ${selectedUrl}` : 'Click captured without navigation candidate',
      target: debugElementSummary(target),
      clickable: debugElementSummary(clickable),
      ancestors: chain.map(debugElementSummary),
      candidates,
      courseParams: collectCourseParams(chain),
      selectedUrl,
      client: {
        x: Math.round((event as MouseEvent).clientX),
        y: Math.round((event as MouseEvent).clientY)
      }
    };

    if (selectedUrl || /chaoxing/i.test(window.location.hostname) || chain.some((element) => NAVIGATION_HINT.test(element.outerHTML || ''))) {
      reportClickDebug(payload);
    }

    if (selectedUrl && requestOpenTab(selectedUrl, compactDebugText(clickable?.textContent || document.title || selectedUrl, 80))) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);
}

