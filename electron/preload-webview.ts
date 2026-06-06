import { ipcRenderer } from 'electron';

type AutomationAction = 'click' | 'fill' | 'select' | 'wait';
type QuestionType = 'single' | 'multiple' | 'judgement' | 'completion' | 'essay' | 'unknown';

interface AutomationStep {
  id: string;
  action: AutomationAction;
  selector?: string;
  value?: string;
  label: string;
  required: boolean;
}

interface AutomationPlan {
  id: string;
  goal: string;
  steps: AutomationStep[];
  approved: boolean;
}

interface QuestionOptionTarget {
  label: string;
  text: string;
  selector?: string;
  inputSelector?: string;
  clickSelector?: string;
  value?: string;
}

interface QuestionPayload {
  hash: string;
  question: string;
  options: string[];
  optionTargets?: QuestionOptionTarget[];
  type?: QuestionType;
  selector?: string;
  index?: number;
}

interface AnswerApplyPayload {
  questionHash: string;
  answer: string;
  choiceLabels?: string[];
  matchedOptions?: string[];
  question?: QuestionPayload;
}

function serializeBridgeError(error: any) {
  if (!error) return { message: 'Unknown WebView error' };
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
      name: error.name
    };
  }
  if (typeof error === 'object') {
    return {
      message: String(error.message || error.reason || error.error || JSON.stringify(error)),
      stack: error.stack ? String(error.stack) : undefined,
      name: error.name ? String(error.name) : undefined
    };
  }
  return { message: String(error) };
}

function reportWebviewError(source: string, payload: any) {
  try {
    ipcRenderer.sendToHost('studypilot:error-log', {
      source,
      level: 'error',
      ...payload,
      url: window.location.href,
      title: document.title
    });
  } catch {
    // Avoid throwing while reporting an error.
  }
}

window.addEventListener('error', (event) => {
  const error = serializeBridgeError(event.error || event.message);
  reportWebviewError('webview:window-error', {
    message: error.message,
    stack: error.stack,
    line: event.lineno,
    column: event.colno,
    details: {
      filename: event.filename,
      name: error.name
    }
  });
});

window.addEventListener('unhandledrejection', (event) => {
  const error = serializeBridgeError(event.reason);
  reportWebviewError('webview:unhandledrejection', {
    message: error.message,
    stack: error.stack,
    details: {
      name: error.name
    }
  });
});

const NAVIGATION_HINT = /(mooc2-ans|mooc-ans|mycourse|dowork|stucoursemiddle|courseid|courseId|clazzid|clazzId|classId|workId|answerId|cpi|chaoxing)/i;
const COURSE_PARAM_HINT = /(course|clazz|class|work|answer|cpi|enc|url|href|target|mooc|chaoxing)/i;
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
    const url = new URL(raw, window.location.href).toString();
    return /^https?:\/\//i.test(url) ? url : '';
  } catch {
    return '';
  }
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
  for (const match of String(text || '').matchAll(/(?:^|["'`])((?:\/|\.\.?\/)?(?:mooc2-ans|mooc-ans|mycourse|visit|course|zt|work)\/[^"'`<>\s\\)]*)/gi)) {
    add(match[1]);
  }
  for (const match of String(text || '').matchAll(/(\/(?:mooc2-ans|mooc-ans|visit|mycourse|work)\/[^\s"'<>\\)]*)/gi)) {
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

function isLikelyCourseNavigationUrl(url: string) {
  if (!/^https?:\/\//i.test(url)) return false;
  if (isBlockedInternalTabUrl(url)) return false;
  if (/\.(?:png|jpe?g|gif|webp|svg|ico)(?:[?#]|$)/i.test(url)) return false;
  if (/\/visit\/interaction(?:[?#]|$)/i.test(url)) return false;
  return /(mycourse\/stu|mooc2\/work\/dowork|stucoursemiddle|courseid=|courseId=|clazzid=|clazzId=|classId=|workId=|answerId=)/i.test(url);
}

function collectClickNavigationCandidates(target: Element | null) {
  const chain = elementChainFor(target);
  const values: string[] = [];
  const add = (url: string) => {
    if (url && !values.includes(url)) values.push(url);
  };

  for (const element of chain) {
    const anchor = element.closest?.('a[href], area[href]') as HTMLAnchorElement | null;
    if (anchor?.href) add(anchor.href);
    const attributes = debugAttributesFor(element);
    for (const value of Object.values(attributes)) {
      const normalized = normalizeCandidateUrl(value);
      if (normalized) add(normalized);
      urlsFromText(value).forEach(add);
    }
    const inlineHandler = element.getAttribute?.('onclick') || String((element as any).onclick || '');
    urlsFromText(inlineHandler).forEach(add);
  }

  const paramUrl = buildChaoxingCourseUrl(collectCourseParams(chain));
  if (paramUrl) add(paramUrl);
  return values.filter(isLikelyCourseNavigationUrl);
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

function installBrowserNavigationPatch() {
  const requestOpenTab = (targetUrl: string | URL | undefined | null, title?: string) => {
    const raw = String(targetUrl || '').trim();
    if (!raw || raw === 'about:blank' || /^javascript:/i.test(raw)) return '';
    try {
      const url = new URL(raw, window.location.href).toString();
      if (!/^https?:\/\//i.test(url)) return '';
      if (isBlockedInternalTabUrl(url)) return '';
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
          return new URL(raw, window.location.href).toString();
        } catch {
          return '';
        }
      };
      const isBlockedInternalTabUrl = (url) => /(addStudentWorkNewWeb|\\/mooc-ans\\/work\\/(?:addStudentWorkNewWeb|save|submit)|\\/work\\/(?:addStudentWorkNewWeb|save|submit)|(?:submit|save)StudentWork|submitWork|saveWork)/i.test(String(url || ''));
      const requestOpenTab = (targetUrl, title) => {
        const nextUrl = normalizeUrl(targetUrl);
        if (!nextUrl) return false;
        if (!/^https?:\\/\\//i.test(nextUrl)) return false;
        if (isBlockedInternalTabUrl(nextUrl)) return false;
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
      const originalOpen = window.open.bind(window);
      window.open = (targetUrl, target, features) => {
        const nextUrl = normalizeUrl(targetUrl);
        if (nextUrl && isBlockedInternalTabUrl(nextUrl)) {
          return originalOpen(targetUrl, target, features);
        }
        requestOpenTab(targetUrl);
        return makePopupProxy();
      };
      document.addEventListener('click', (event) => {
        const element = event.target && event.target.closest ? event.target.closest('a[href], area[href]') : null;
        if (!element) return;
        const href = element.getAttribute('href') || '';
        const target = (element.getAttribute('target') || '').toLowerCase();
        if (!href || /^javascript:/i.test(href)) return;
        if (target === '_blank' || target === 'blank') {
          if (requestOpenTab(element.href, element.textContent && element.textContent.trim())) {
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
    const anchor = (event.target as HTMLElement | null)?.closest?.('a[target="_blank"], a[target="blank"], a[onclick]') as HTMLAnchorElement | null;
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

installBrowserNavigationPatch();

const QUESTION_CONTAINER_SELECTORS = [
  '.questionLi',
  '[data-question]',
  '[data-sp-question]',
  '[qid][qtype]',
  '[questionid][qtype]',
  '.question',
  '.question-item',
  '.subject-item',
  '.exam-question',
  '.timu',
  '.TiMu',
  '.CeSheng',
  '.questionCard'
];

const TITLE_SELECTORS = [
  '[data-question-title]',
  '.question-title',
  '.timu-title',
  '.CeSheng_title',
  '.Zy_TItle',
  '.Zy_TItleTxt',
  '.TiMu',
  '.stem',
  '.subject-title',
  '.title',
  '.q-text',
  '.content'
];

const OPTION_SELECTORS = [
  '.answerCon',
  '.ans-item',
  '.option',
  '.optionItem',
  '.option-item',
  '.options-item',
  '.optionBox',
  '.option-box',
  '.choiceOption',
  '.choice-option',
  '.option-item',
  '.choice',
  '.choice-item',
  '.answerItem',
  '.answer-item',
  '.checkOption',
  '.check-option',
  '.radio',
  '.radio-box',
  '.xuanxiang',
  '.CeSheng_option',
  '[data-option]',
  '[data][qid]',
  '[role="radio"]',
  '[role="checkbox"]',
  'label',
  'li'
];

function cssEscape(value: string) {
  if ((window as any).CSS?.escape) return (window as any).CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}

function selectorFor(element: Element): string {
  const el = element as HTMLElement;
  const dataControl = el.getAttribute('data-sp-control');
  if (dataControl) return `[data-sp-control="${cssEscape(dataControl)}"]`;
  if (el.id) return `#${cssEscape(el.id)}`;
  if (el.getAttribute('qid') && el.getAttribute('data')) {
    return `${el.tagName.toLowerCase()}[qid="${cssEscape(el.getAttribute('qid') || '')}"][data="${cssEscape(el.getAttribute('data') || '')}"]`;
  }
  if (el.getAttribute('qid') && el.getAttribute('qtype')) {
    return `${el.tagName.toLowerCase()}[qid="${cssEscape(el.getAttribute('qid') || '')}"][qtype="${cssEscape(el.getAttribute('qtype') || '')}"]`;
  }
  if (el.getAttribute('questionid') && el.getAttribute('qtype')) {
    return `${el.tagName.toLowerCase()}[questionid="${cssEscape(el.getAttribute('questionid') || '')}"][qtype="${cssEscape(el.getAttribute('qtype') || '')}"]`;
  }
  if (el.getAttribute('name')) return `${el.tagName.toLowerCase()}[name="${cssEscape(el.getAttribute('name') || '')}"]`;
  if (el.getAttribute('aria-label')) return `${el.tagName.toLowerCase()}[aria-label="${cssEscape(el.getAttribute('aria-label') || '')}"]`;

  const parent = el.parentElement;
  if (!parent) return el.tagName.toLowerCase();
  const siblings = Array.from(parent.children).filter((child) => child.tagName === el.tagName);
  const index = siblings.indexOf(el) + 1;
  return `${selectorFor(parent)} > ${el.tagName.toLowerCase()}:nth-of-type(${index})`;
}

function removeNoise(root: ParentNode) {
  root.querySelectorAll('script, style, noscript, template, svg, canvas, iframe, code, pre').forEach((node) => node.remove());
}

function cleanText(text: string) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\s*\d{1,3}\s*[.、．)]\s*/, '')
    .trim();
}

function visibleText(element: Element) {
  const clone = element.cloneNode(true) as HTMLElement;
  removeNoise(clone);
  return cleanText(clone.textContent || '');
}

function normalizeText(text: string) {
  return cleanText(text)
    .replace(/^[A-ZＡ-Ｄ][.\s:：、．。)]*/i, '')
    .replace(/[，。,.、；;：:\s"'“”‘’【】\[\]（）()]/g, '')
    .toLowerCase();
}

function isVisible(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}

function hashText(text: string) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function uniqueBy<T>(values: T[], key: (item: T) => string) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const itemKey = key(value);
    if (!itemKey || seen.has(itemKey)) return false;
    seen.add(itemKey);
    return true;
  });
}

function optionLetter(index: number) {
  return String.fromCharCode(65 + index);
}

function optionIndexFromLabel(label: string) {
  return label.toUpperCase().charCodeAt(0) - 65;
}

function optionLabel(label: string, text: string) {
  const body = cleanText(text).replace(/^[A-ZＡ-Ｄ][.\s:：、．。)]*/i, '');
  return `${label.toUpperCase()}. ${body || label.toUpperCase()}`;
}

function labelFor(element: HTMLElement) {
  const explicitLabel = element.id ? document.querySelector(`label[for="${cssEscape(element.id)}"]`)?.textContent : '';
  const parentLabel = element.closest('label')?.textContent;
  return cleanText(
    element.getAttribute('aria-label') ||
    explicitLabel ||
    parentLabel ||
    element.textContent ||
    element.getAttribute('placeholder') ||
    element.getAttribute('name') ||
    element.tagName.toLowerCase()
  ).slice(0, 120);
}

function captureSnapshot() {
  const selector = 'button, input, textarea, select, [role="button"], a[href]';
  const controls = Array.from(document.querySelectorAll(selector))
    .map((element) => element as HTMLElement)
    .filter(isVisible)
    .slice(0, 80)
    .map((element) => ({
      selector: selectorFor(element),
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute('type') || undefined,
      text: labelFor(element),
      value: (element as HTMLInputElement).value || undefined,
      placeholder: element.getAttribute('placeholder') || undefined
    }));

  return {
    success: true,
    data: {
      url: window.location.href,
      title: document.title || window.location.href,
      controls,
      capturedAt: Date.now()
    }
  };
}

function inferTypeFromDom(root: HTMLElement, options: string[]): QuestionType {
  const qtype = root.getAttribute('qtype') || root.querySelector('[qtype]')?.getAttribute('qtype') || '';
  const radios = root.querySelectorAll('input[type="radio"]').length;
  const checkboxes = root.querySelectorAll('input[type="checkbox"]').length;
  const textareas = root.querySelectorAll('textarea').length;
  const textInputs = root.querySelectorAll('input[type="text"], input:not([type])').length;
  const text = visibleText(root);

  if (qtype === '1' || checkboxes > 0) return 'multiple';
  if (qtype === '3' || (radios === 2 && /正确|错误|对|错|true|false/i.test(text))) return 'judgement';
  if (qtype === '0' || radios > 0 || options.length >= 2) return 'single';
  if (textareas > 0) return 'essay';
  if (textInputs > 0) return 'completion';
  return 'unknown';
}

function inferTypeFromText(text: string, options: string[]): QuestionType {
  if (/多选题|多项选择/i.test(text)) return 'multiple';
  if (/判断题|正确|错误|对|错|true|false/i.test(text) && options.length <= 2) return 'judgement';
  if (/填空题/i.test(text)) return 'completion';
  if (/问答题|简答题|论述题/i.test(text)) return 'essay';
  if (/单选题|选择题/i.test(text) || options.length >= 2) return 'single';
  return 'unknown';
}

function isNoiseText(text: string) {
  const normalized = cleanText(text);
  if (normalized.length < 4) return true;
  if (normalized.length > 2500) return true;
  if (/(function\s+\w+|var\s+\w+\s*=|\$\(|\.css|@keyframes|document\.|window\.|ajax|submitWork|ready2Submit)/i.test(normalized)) return true;
  const codeHits = (normalized.match(/[{}();=<>]/g) || []).length;
  return codeHits > Math.max(12, normalized.length / 20);
}

function nearestClickableOption(element: HTMLElement) {
  return element.closest([
    'label',
    '[role="radio"]',
    '[role="checkbox"]',
    '[onclick]',
    '[data][qid]',
    '[data-option]',
    '.choice',
    '.choice-item',
    '.choiceOption',
    '.choice-option',
    '.option',
    '.optionItem',
    '.option-item',
    '.options-item',
    '.optionBox',
    '.option-box',
    '.answerCon',
    '.ans-item',
    '.answerItem',
    '.answer-item',
    '.checkOption',
    '.check-option',
    '.radio',
    '.radio-box',
    'li'
  ].join(',')) as HTMLElement | null;
}

function optionLabelFromText(rawText: string, dataValue: string, index: number) {
  const text = cleanText(rawText);
  const dataLabel = /^[A-D]$/i.test(dataValue) ? dataValue : '';
  const firstToken = text.match(/^\s*([A-D])\s*[.\s:：、。)]?/i)?.[1];
  if (dataLabel) return dataLabel.toUpperCase();
  if (firstToken) return firstToken.toUpperCase();
  return optionLetter(index);
}

function optionTargetFromElement(element: HTMLElement, index: number): QuestionOptionTarget {
  const input = element.matches('input[type="radio"], input[type="checkbox"]')
    ? element
    : element.querySelector('input[type="radio"], input[type="checkbox"]');
  const marker = element.matches('.num_option, .num_option_dx, [data], [value]')
    ? element
    : element.querySelector('.num_option, .num_option_dx, [data], [value]');
  const dataValue = element.getAttribute('data') ||
    marker?.getAttribute('data') ||
    element.getAttribute('value') ||
    marker?.getAttribute('value') ||
    (input as HTMLInputElement | null)?.value ||
    '';
  const rawText = visibleText(element) || element.getAttribute('aria-label') || dataValue;
  const labelMatch = rawText.match(/^\s*([A-ZＡ-Ｄ])\s*[.\s:：、．。)]/i);
  const dataLabel = /^[A-Z]$/i.test(dataValue) ? dataValue : '';
  const label = (dataLabel || labelMatch?.[1] || optionLetter(index)).toUpperCase();
  const clickTarget = nearestClickableOption(element) || element;
  return {
    label,
    text: optionLabel(label, rawText || label),
    selector: selectorFor(element),
    inputSelector: input ? selectorFor(input) : undefined,
    clickSelector: clickTarget !== element ? selectorFor(clickTarget) : undefined,
    value: dataValue || undefined
  };
}

function dedupeOptionTargets(targets: QuestionOptionTarget[]) {
  return uniqueBy(targets, (target) => `${target.label}:${normalizeText(target.text)}`)
    .filter((target) => {
      const text = normalizeText(target.text);
      return text.length > 0 && text.length <= 160 && !isNoiseText(target.text);
    });
}

function extractOptionTargets(root: HTMLElement) {
  const inputTargets = dedupeOptionTargets((Array.from(root.querySelectorAll('input[type="radio"], input[type="checkbox"]')) as HTMLInputElement[])
    .map((input, index) => {
      const label = input.closest('label') || (input.id ? document.querySelector(`label[for="${cssEscape(input.id)}"]`) : null);
      return optionTargetFromElement((label || input) as HTMLElement, index);
    }));
  if (inputTargets.length >= 2) return inputTargets.slice(0, 12);

  for (const selector of OPTION_SELECTORS) {
    const targets = dedupeOptionTargets(Array.from(root.querySelectorAll(selector))
      .map((element, index) => optionTargetFromElement(element as HTMLElement, index)));
    if (targets.length >= 2) return targets.slice(0, 12);
  }

  const letterTargets = dedupeOptionTargets((Array.from(root.querySelectorAll('*')) as HTMLElement[])
    .filter((element) => {
      const text = cleanText(element.textContent || '');
      return /^[A-D]$/.test(text) && isVisible(element);
    })
    .map((element, index) => optionTargetFromElement(nearestClickableOption(element) || element, index)));
  if (letterTargets.length >= 2) return letterTargets.slice(0, 12);

  return [];
}

function extractOptionsFromText(body: string) {
  const matches = Array.from(body.matchAll(/(?:^|\s)([A-DＡ-Ｄ])\s*[.、．)]?\s*(.*?)(?=\s+[A-DＡ-Ｄ]\s*[.、．)]?\s+|$)/g));
  if (matches.length < 2) return { question: cleanText(body), options: [] as string[] };

  const firstIndex = matches[0].index || 0;
  const question = cleanText(body.slice(0, firstIndex));
  const options = matches.map((match, index) => optionLabel(match[1] || optionLetter(index), match[2] || ''));
  return { question: question || cleanText(body), options: uniqueBy(options, normalizeText) };
}

function findQuestionText(root: HTMLElement, optionTargets: QuestionOptionTarget[]) {
  for (const selector of TITLE_SELECTORS) {
    const element = root.querySelector(selector);
    if (!element) continue;
    const text = visibleText(element);
    if (!isNoiseText(text) && text.length >= 4) return text;
  }

  const clone = root.cloneNode(true) as HTMLElement;
  removeNoise(clone);
  OPTION_SELECTORS.forEach((selector) => clone.querySelectorAll(selector).forEach((node) => node.remove()));
  let text = cleanText(clone.textContent || '');
  for (const option of optionTargets) text = text.replace(option.text, '');
  return cleanText(text);
}

function questionFromRoot(root: HTMLElement, index: number) {
  const optionTargets = extractOptionTargets(root);
  const options = optionTargets.map((target) => target.text);
  const question = findQuestionText(root, optionTargets);

  if (!question || isNoiseText(question)) return null;
  if (options.length > 0 && question.length > 1200) return null;
  if (options.length === 0 && !/[？?]|(单选|多选|判断|填空|问答|题)/.test(question)) return null;

  return {
    id: `q_${Date.now()}_${index}`,
    hash: hashText(`${question}\n${options.join('\n')}`),
    question,
    options,
    optionTargets,
    type: inferTypeFromDom(root, options),
    source: 'webview',
    pageUrl: window.location.href,
    pageTitle: document.title || window.location.href,
    capturedAt: Date.now(),
    index,
    selector: selectorFor(root)
  };
}

function splitContinuousText(rawText: string) {
  const text = cleanText(rawText);
  if (isNoiseText(text)) return [];
  const boundaryPattern = /(?:^|\s)(\d{1,3})[.、．)]\s*(?:[（(]?(单选题|多选题|判断题|填空题|问答题|简答题|论述题)[)）]?)?/g;
  const matches = Array.from(text.matchAll(boundaryPattern));
  if (matches.length <= 1) return [];

  return matches.map((match, index) => {
    const start = (match.index || 0) + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index || text.length : text.length;
    return {
      number: Number(match[1]),
      typeLabel: match[2] || '',
      body: cleanText(text.slice(start, end))
    };
  }).filter((item) => item.body.length > 8 && !isNoiseText(item.body));
}

function questionFromSegment(segment: { number: number; typeLabel: string; body: string }) {
  const parsed = extractOptionsFromText(segment.body);
  const question = parsed.question || segment.body;
  const options = parsed.options;
  if (!question || isNoiseText(question)) return null;
  return {
    id: `q_${Date.now()}_${segment.number}`,
    hash: hashText(`${segment.number}\n${question}\n${options.join('\n')}`),
    question,
    options,
    optionTargets: [],
    type: inferTypeFromText(`${segment.typeLabel} ${segment.body}`, options),
    source: 'webview',
    pageUrl: window.location.href,
    pageTitle: document.title || window.location.href,
    capturedAt: Date.now(),
    index: segment.number
  };
}

function extractQuestions() {
  const roots: HTMLElement[] = [];
  const seen = new Set<string>();

  for (const selector of QUESTION_CONTAINER_SELECTORS) {
    const elements = Array.from(document.querySelectorAll(selector)) as HTMLElement[];
    for (const element of elements) {
      if (!isVisible(element)) continue;
      const text = visibleText(element);
      if (isNoiseText(text) || seen.has(text)) continue;
      seen.add(text);
      roots.push(element);
    }
    if (roots.length > 1) break;
  }

  const domQuestions = roots
    .map((root, index) => questionFromRoot(root, index + 1))
    .filter(Boolean) as any[];

  if (domQuestions.length > 0) return domQuestions;

  const bodyClone = document.body.cloneNode(true) as HTMLElement;
  removeNoise(bodyClone);
  const textQuestions = splitContinuousText(bodyClone.textContent || '')
    .map(questionFromSegment)
    .filter(Boolean) as any[];
  if (textQuestions.length > 0) return textQuestions;

  const fallback = questionFromRoot(document.body, 1);
  return fallback ? [fallback] : [];
}

function dispatchInput(element: HTMLElement) {
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function optionValueForSubmit(element: HTMLElement) {
  const marker = element.matches('.num_option, .num_option_dx, [data], [value]')
    ? element
    : element.querySelector('.num_option, .num_option_dx, [data], [value]');
  const input = element.matches('input[type="radio"], input[type="checkbox"]')
    ? element as HTMLInputElement
    : element.querySelector('input[type="radio"], input[type="checkbox"]') as HTMLInputElement | null;
  return cleanText(
    element.getAttribute('data') ||
    marker?.getAttribute('data') ||
    element.getAttribute('value') ||
    marker?.getAttribute('value') ||
    input?.value ||
    ''
  );
}

function selectedOptionValue(element: HTMLElement) {
  const input = element.matches('input[type="radio"], input[type="checkbox"]')
    ? element as HTMLInputElement
    : element.querySelector('input[type="radio"], input[type="checkbox"]') as HTMLInputElement | null;
  if (input && !input.checked) return '';
  if (!input) {
    const selected = element.getAttribute('aria-checked') === 'true' ||
      element.getAttribute('aria-pressed') === 'true' ||
      selectedClassHit(element) ||
      Array.from(element.querySelectorAll('*')).some((child) => selectedClassHit(child as HTMLElement));
    if (!selected) return '';
  }
  return optionValueForSubmit(element);
}

function syncAnswersBeforeSave() {
  const questionRoots = uniqueElements(Array.from(document.querySelectorAll([
    '.questionLi',
    '[qid][qtype]',
    '[questionid][qtype]',
    '.TiMu'
  ].join(','))) as HTMLElement[]);
  let updated = 0;
  const details: Array<Record<string, unknown>> = [];

  for (const root of questionRoots) {
    const qid = root.getAttribute('qid') ||
      root.getAttribute('questionid') ||
      root.querySelector('[qid]')?.getAttribute('qid') ||
      root.querySelector('[questionid]')?.getAttribute('questionid') ||
      '';
    if (!qid) continue;
    const hiddenAnswer = document.querySelector(`#answer${cssEscape(qid)}`) as HTMLInputElement | null;
    if (!hiddenAnswer) continue;
    const qtype = root.getAttribute('qtype') || root.querySelector('[qtype]')?.getAttribute('qtype') || '';
    const optionElements = uniqueElements(Array.from(root.querySelectorAll([
      '.answerBg',
      '.workTextWrap',
      `.choice${cssEscape(qid)}`,
      `[qid="${cssEscape(qid)}"][data]`,
      `[questionid="${cssEscape(qid)}"][data]`,
      'input[type="radio"]',
      'input[type="checkbox"]',
      '[role="radio"]',
      '[role="checkbox"]'
    ].join(','))) as HTMLElement[]);
    const values = optionElements
      .map(selectedOptionValue)
      .map((value) => {
        if (qtype === '3') return parseJudgementValueStable(value) || value;
        return /^[A-Z]$/i.test(value) ? value.toUpperCase() : value;
      })
      .filter(Boolean);
    if (values.length === 0) continue;
    const nextValue = qtype === '1' || qtype === '21'
      ? Array.from(new Set(values)).join('')
      : values[0];
    if (hiddenAnswer.value !== nextValue) {
      hiddenAnswer.value = nextValue;
      dispatchInput(hiddenAnswer);
      updated += 1;
    }
    details.push({ qid, qtype, value: hiddenAnswer.value, selected: values });
  }

  reportWebviewError('webview:sync-before-save', {
    level: 'info',
    message: `Synced ${updated} answers before save/submit`,
    details: {
      updated,
      total: details.length,
      answers: details.slice(0, 80)
    }
  });
}

function dispatchUserClick(element: HTMLElement) {
  const pageAny = window as any;
  pageAny.__studyPilotApplyingAnswerUntil = Math.max(
    Number(pageAny.__studyPilotApplyingAnswerUntil || 0),
    Date.now() + 800
  );
  try {
    const rect = element.getBoundingClientRect();
    const clientX = Math.max(0, rect.left + rect.width / 2);
    const clientY = Math.max(0, rect.top + rect.height / 2);
    const base = { bubbles: true, cancelable: true, view: window, clientX, clientY };
    const pointerBase = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    if (typeof PointerEvent !== 'undefined') {
      element.dispatchEvent(new PointerEvent('pointerover', pointerBase));
      element.dispatchEvent(new PointerEvent('pointerenter', pointerBase));
    }
    element.dispatchEvent(new MouseEvent('mouseover', base));
    element.dispatchEvent(new MouseEvent('mouseenter', base));
    if (typeof PointerEvent !== 'undefined') element.dispatchEvent(new PointerEvent('pointerdown', pointerBase));
    element.dispatchEvent(new MouseEvent('mousedown', base));
    if (typeof PointerEvent !== 'undefined') element.dispatchEvent(new PointerEvent('pointerup', pointerBase));
    element.dispatchEvent(new MouseEvent('mouseup', base));
    element.dispatchEvent(new MouseEvent('click', base));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  } finally {
    pageAny.__studyPilotApplyingAnswerUntil = Math.max(
      Number(pageAny.__studyPilotApplyingAnswerUntil || 0),
      Date.now() + 500
    );
  }
}

async function runStep(step: AutomationStep) {
  if (step.action === 'wait') {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return;
  }
  if (!step.selector) throw new Error(`Step "${step.label}" has no selector.`);

  const element = document.querySelector(step.selector) as HTMLElement | null;
  if (!element) throw new Error(`Element not found: ${step.selector}`);

  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  await new Promise((resolve) => setTimeout(resolve, 120));

  if (step.action === 'fill') {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.focus();
      element.value = step.value || '';
      dispatchInput(element);
      return;
    }
    if (element.isContentEditable) {
      element.focus();
      element.textContent = step.value || '';
      dispatchInput(element);
      return;
    }
    throw new Error(`Element is not fillable: ${step.selector}`);
  }

  if (step.action === 'select') {
    if (element instanceof HTMLSelectElement) {
      const requested = step.value || '';
      const option = Array.from(element.options).find((item) => item.value === requested || item.text.toLowerCase().includes(requested.toLowerCase()));
      if (option) element.value = option.value;
      dispatchInput(element);
      return;
    }
    throw new Error(`Element is not a select: ${step.selector}`);
  }

  if (step.action === 'click') element.click();
}

async function executePlan(plan: AutomationPlan) {
  if (!plan.approved) return { success: false, error: 'Plan is not approved.' };
  try {
    for (const step of plan.steps) await runStep(step);
    return { success: true, message: `Executed ${plan.steps.length} steps on the active page.` };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

function fallbackAnswerTargets(payload: AnswerApplyPayload): QuestionOptionTarget[] {
  const root = payload.question?.selector
    ? (document.querySelector(payload.question.selector) as HTMLElement | null) || document.body
    : document.body;
  const targets = extractOptionTargets(root);
  if (targets.length > 0) return targets;

  return (payload.question?.options || []).map((option, index) => ({
    label: option.match(/^\s*([A-Z])\s*[.\s:：、．。)]/i)?.[1]?.toUpperCase() || optionLetter(index),
    text: option
  }));
}

function questionRootForPayload(payload: AnswerApplyPayload) {
  if (payload.question?.selector) {
    const root = document.querySelector(payload.question.selector) as HTMLElement | null;
    if (root) return root;
  }
  return document.body;
}

function qidForPayload(payload: AnswerApplyPayload) {
  const root = questionRootForPayload(payload);
  return (
    root.getAttribute('qid') ||
    root.getAttribute('questionid') ||
    root.getAttribute('data') ||
    root.querySelector('[qid]')?.getAttribute('qid') ||
    root.querySelector('[questionid]')?.getAttribute('questionid') ||
    ''
  );
}

function optionTargetByLabel(payload: AnswerApplyPayload, label: string): QuestionOptionTarget | null {
  const root = questionRootForPayload(payload);
  const qid = qidForPayload(payload);
  const upper = label.toUpperCase();
  const selectors = [
    qid ? `[qid="${cssEscape(qid)}"][data="${cssEscape(upper)}"]` : '',
    qid ? `.choice${cssEscape(qid)}[data="${cssEscape(upper)}"]` : '',
    qid ? `[questionid="${cssEscape(qid)}"][data="${cssEscape(upper)}"]` : '',
    `[data="${cssEscape(upper)}"][qid]`,
    `[data="${cssEscape(upper)}"][questionid]`,
    `[aria-label^="${cssEscape(upper)}"]`,
    `[aria-label*="${cssEscape(upper)}."]`
  ].filter(Boolean);

  for (const selector of selectors) {
    const element = (root.querySelector(selector) || document.querySelector(selector)) as HTMLElement | null;
    if (element) return optionTargetFromElement(element, upper.charCodeAt(0) - 65);
  }

  const index = upper.charCodeAt(0) - 65;
  const options = extractOptionTargets(root);
  return options[index] || null;
}

function answerAliases(text: string) {
  const normalized = normalizeText(text);
  const aliases = new Set([normalized]);
  if (/正确|對|对|true|yes|是/.test(normalized)) {
    ['正确', '对', 'true', 'yes', '是'].forEach((value) => aliases.add(value));
  }
  if (/错误|錯|错|false|no|否/.test(normalized)) {
    ['错误', '错', 'false', 'no', '否'].forEach((value) => aliases.add(value));
  }
  return Array.from(aliases).filter(Boolean);
}

function judgementValueFromText(text: string): 'true' | 'false' | null {
  const value = String(text || '').toLowerCase().replace(/\s+/g, '');
  if (!value) return null;
  if (/(正确|对|是|√|✓|true|yes|right|correct|t\b|1)/i.test(value)) return 'true';
  if (/(错误|错|否|×|✕|false|no|wrong|incorrect|f\b|0)/i.test(value)) return 'false';
  return null;
}

function judgementTargets(payload: AnswerApplyPayload, targets: QuestionOptionTarget[]) {
  const answerValue = judgementValueFromText(`${payload.answer || ''} ${(payload.matchedOptions || []).join(' ')}`);
  if (!answerValue) return [];

  const semantic = targets.filter((target) => judgementValueFromText(target.text) === answerValue);
  if (semantic.length > 0) return semantic.slice(0, 1);

  const qid = qidForPayload(payload);
  if (qid) {
    const values = answerValue === 'true'
      ? ['true', '1', 'Y', 'YES', 'T', 'right', 'correct']
      : ['false', '0', 'N', 'NO', 'F', 'wrong', 'incorrect'];
    for (const value of values) {
      const selector = `[qid="${cssEscape(qid)}"][data="${cssEscape(value)}"], [qid="${cssEscape(qid)}"][value="${cssEscape(value)}"], [questionid="${cssEscape(qid)}"][data="${cssEscape(value)}"]`;
      const element = document.querySelector(selector) as HTMLElement | null;
      if (element) return [optionTargetFromElement(element, answerValue === 'true' ? 0 : 1)];
    }
  }

  if (targets.length === 2) return [targets[answerValue === 'true' ? 0 : 1]];
  return [];
}

function parseJudgementValue(text: string): 'true' | 'false' | null {
  const value = String(text || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[：:，,。.;；、|/]/g, '');
  if (!value) return null;

  const trueValues = new Set([
    'true',
    't',
    '1',
    'yes',
    'y',
    'right',
    'correct',
    'ri',
    '\u6b63\u786e',
    '\u5bf9',
    '\u662f',
    '√',
    '✓',
    '✔',
    '姝ｇ‘',
    '瀵?',
    '鈭?',
    '鉁?'
  ]);
  const falseValues = new Set([
    'false',
    'f',
    '0',
    'no',
    'n',
    'wrong',
    'incorrect',
    'wr',
    '\u9519\u8bef',
    '\u9519',
    '\u5426',
    '×',
    'x',
    '✗',
    '✘',
    '閿欒',
    '閿?',
    '脳',
    '鉁?'
  ]);

  if (trueValues.has(value)) return 'true';
  if (falseValues.has(value)) return 'false';
  if (/(\u6b63\u786e|\u5bf9|\u662f|姝ｇ‘|瀵|鈭|true|yes|right|correct)/i.test(value)) return 'true';
  if (/(\u9519\u8bef|\u9519|\u5426|閿|脳|false|wrong|incorrect)/i.test(value)) return 'false';
  return null;
}

function judgementValueFromOptionTarget(target: QuestionOptionTarget) {
  return parseJudgementValueStable(`${target.value || ''} ${target.text || ''} ${target.label || ''}`);
}

function judgementValueFromElement(element: HTMLElement | null) {
  if (!element) return null;
  const marker = element.matches('.num_option, .num_option_dx, [data], [value]')
    ? element
    : element.querySelector('.num_option, .num_option_dx, [data], [value]');
  const input = element.matches('input[type="radio"], input[type="checkbox"]')
    ? element as HTMLInputElement
    : element.querySelector('input[type="radio"], input[type="checkbox"]') as HTMLInputElement | null;
  return parseJudgementValueStable([
    element.getAttribute('data'),
    marker?.getAttribute('data'),
    element.getAttribute('value'),
    marker?.getAttribute('value'),
    input?.value,
    element.getAttribute('aria-label'),
    visibleText(element)
  ].filter(Boolean).join(' '));
}

function parseJudgementValueStable(text: string): 'true' | 'false' | null {
  const raw = String(text || '').trim();
  const value = raw.toLowerCase().replace(/\s+/g, '');
  if (!value) return null;
  if (/^(true|t|1|yes|y|right|correct|ri)$/.test(value)) return 'true';
  if (/^(false|f|0|no|n|wrong|incorrect|wr|x)$/.test(value)) return 'false';

  for (const char of raw) {
    const code = char.charCodeAt(0);
    if (code === 0x6b63 || code === 0x5bf9 || code === 0x662f || code === 0x221a || code === 0x2713 || code === 0x2714) {
      return 'true';
    }
    if (code === 0x9519 || code === 0x5426 || code === 0x00d7 || code === 0x2717 || code === 0x2718) {
      return 'false';
    }
  }

  if (/(true|yes|right|correct)/i.test(raw)) return 'true';
  if (/(false|wrong|incorrect)/i.test(raw)) return 'false';
  return null;
}

function answerOptionContainer(element: HTMLElement) {
  return (element.closest([
    '.answerBg',
    '.workTextWrap',
    '[qid][qtype]',
    '[questionid][qtype]',
    '[role="radio"]',
    '[role="checkbox"]',
    'label',
    'li'
  ].join(',')) as HTMLElement | null) || element;
}

function pickJudgementTargets(payload: AnswerApplyPayload, targets: QuestionOptionTarget[]) {
  const answerValue = parseJudgementValueStable(`${payload.answer || ''} ${(payload.matchedOptions || []).join(' ')}`);
  if (!answerValue) return [];

  const semantic = targets.filter((target) => judgementValueFromOptionTarget(target) === answerValue);
  if (semantic.length > 0) return semantic.slice(0, 1);

  const qid = qidForPayload(payload);
  if (qid) {
    const root = questionRootForPayload(payload);
    const values = answerValue === 'true'
      ? ['true', '1', 'Y', 'YES', 'T', 'right', 'correct', '\u6b63\u786e', '\u5bf9']
      : ['false', '0', 'N', 'NO', 'F', 'wrong', 'incorrect', '\u9519\u8bef', '\u9519'];
    for (const value of values) {
      const selector = [
        `[qid="${cssEscape(qid)}"][data="${cssEscape(value)}"]`,
        `[qid="${cssEscape(qid)}"][value="${cssEscape(value)}"]`,
        `[questionid="${cssEscape(qid)}"][data="${cssEscape(value)}"]`,
        `[qid="${cssEscape(qid)}"] .num_option[data="${cssEscape(value)}"]`,
        `[qid="${cssEscape(qid)}"] .num_option_dx[data="${cssEscape(value)}"]`,
        `.choice${cssEscape(qid)}[data="${cssEscape(value)}"]`,
        `.choice${cssEscape(qid)} .num_option[data="${cssEscape(value)}"]`,
        `.choice${cssEscape(qid)} .num_option_dx[data="${cssEscape(value)}"]`
      ].join(',');
      const element = (root.querySelector(selector) || document.querySelector(selector)) as HTMLElement | null;
      if (element) return [optionTargetFromElement(answerOptionContainer(element), answerValue === 'true' ? 0 : 1)];
    }
  }

  if (targets.length === 2) return [targets[answerValue === 'true' ? 0 : 1]];
  return [];
}

function qtypeForPayload(payload: AnswerApplyPayload) {
  const root = questionRootForPayload(payload);
  return root.getAttribute('qtype') || root.querySelector('[qtype]')?.getAttribute('qtype') || '';
}

function isJudgementPayload(payload: AnswerApplyPayload, targets: QuestionOptionTarget[] = []) {
  const qtype = qtypeForPayload(payload);
  if (payload.question?.type === 'judgement' || qtype === '3') return true;
  const meaningfulTargets = targets.filter((target) => target.value || target.text);
  return meaningfulTargets.length === 2 && meaningfulTargets.every((target) => Boolean(judgementValueFromOptionTarget(target)));
}

function clearMatchString(text: string) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/^[A-ZＡ-Ｄ]\s*[^A-Za-z0-9\u2E80-\u9FFF]+/i, '')
    .replace(/[^\u2E80-\u9FFFA-Za-z0-9]+/g, '');
}

function compareTwoStrings(first: string, second: string) {
  first = clearMatchString(first);
  second = clearMatchString(second);
  if (first === second) return 1;
  if (first.length < 2 || second.length < 2) return 0;
  const bigrams = new Map<string, number>();
  for (let index = 0; index < first.length - 1; index += 1) {
    const bigram = first.slice(index, index + 2);
    bigrams.set(bigram, (bigrams.get(bigram) || 0) + 1);
  }
  let intersection = 0;
  for (let index = 0; index < second.length - 1; index += 1) {
    const bigram = second.slice(index, index + 2);
    const count = bigrams.get(bigram) || 0;
    if (count > 0) {
      bigrams.set(bigram, count - 1);
      intersection += 1;
    }
  }
  return (2 * intersection) / (first.length + second.length - 2);
}

function textScore(answer: string, option: string) {
  const answerValues = answerAliases(answer);
  const optionValues = answerAliases(option);
  let best = 0;
  for (const answerValue of answerValues) {
    for (const optionValue of optionValues) {
      if (!answerValue || !optionValue) continue;
      if (answerValue === optionValue) best = Math.max(best, 100);
      if (answerValue.includes(optionValue) || optionValue.includes(answerValue)) {
        best = Math.max(best, Math.min(answerValue.length, optionValue.length) / Math.max(answerValue.length, optionValue.length));
      }
      best = Math.max(best, compareTwoStrings(answerValue, optionValue));
    }
  }
  return best;
}

function pickAnswerTargets(payload: AnswerApplyPayload) {
  const question = payload.question;
  const scannedTargets = fallbackAnswerTargets(payload);
  const savedTargets = question?.optionTargets || [];
  const targets = [...scannedTargets, ...savedTargets]
    .filter((target, index, all) => all.findIndex((item) => `${item.label}:${item.text}:${item.selector || item.inputSelector || ''}` === `${target.label}:${target.text}:${target.selector || target.inputSelector || ''}`) === index)
    .sort((left, right) => Number(Boolean(right.inputSelector)) - Number(Boolean(left.inputSelector)));
  const judgementSelected = isJudgementPayload(payload, targets) ? pickJudgementTargets(payload, targets) : [];
  if (judgementSelected.length > 0) return judgementSelected;
  const answerText = `${payload.answer} ${(payload.matchedOptions || []).join(' ')}`;
  const labelSet = new Set((payload.choiceLabels || [])
    .map((label) => label.trim().toUpperCase())
    .filter(Boolean));

  Array.from(answerText.matchAll(/(?:^|[^A-Z])([A-D])(?:[^A-Z]|$)/gi))
    .map((match) => match[1].toUpperCase())
    .forEach((label) => labelSet.add(label));

  let selected = targets.filter((target) => labelSet.has(target.label.toUpperCase()));
  if (selected.length === 0 && labelSet.size > 0) {
    selected = Array.from(labelSet)
      .map((label) => optionTargetByLabel(payload, label))
      .filter(Boolean) as QuestionOptionTarget[];
  }
  if (selected.length === 0 && labelSet.size > 0 && targets.length > 0) {
    selected = Array.from(labelSet)
      .map((label) => targets[label.charCodeAt(0) - 65])
      .filter(Boolean) as QuestionOptionTarget[];
  }
  if (selected.length === 0) {
    const answerCandidates = answerPartsFromPayload(payload);
    const scored = targets
      .map((target) => ({
        target,
        score: Math.max(...answerCandidates.map((answer) => textScore(String(answer), target.text)), 0)
      }))
      .sort((left, right) => right.score - left.score);
    const best = scored[0];
    if (best && best.score >= 0.42) selected = [best.target];
  }

  return selected;
}

function labelsFromPayload(payload: AnswerApplyPayload) {
  const answerText = `${payload.answer || ''} ${(payload.matchedOptions || []).join(' ')}`;
  const labels = new Set((payload.choiceLabels || []).map((label) => label.trim().toUpperCase()).filter(Boolean));
  Array.from(answerText.matchAll(/(?:^|[^A-Za-z])([A-D])(?:[^A-Za-z]|$)/gi))
    .map((match) => match[1].toUpperCase())
    .forEach((label) => labels.add(label));
  return Array.from(labels);
}

function answerPartsFromPayload(payload: AnswerApplyPayload) {
  return [
    payload.answer,
    ...(payload.matchedOptions || []),
    ...String(payload.answer || '').split(/[、,，;；\n/]+/g)
  ].map((item) => cleanText(item)).filter(Boolean);
}

function isFillQuestion(payload: AnswerApplyPayload) {
  const root = questionRootForPayload(payload);
  const hasFields = root.querySelectorAll('textarea, input[type="text"], input:not([type]), [contenteditable="true"]').length > 0;
  return payload.question?.type === 'completion' || (hasFields && extractOptionTargets(root).length === 0);
}

function fillElementValue(element: HTMLElement, value: string) {
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  element.focus();
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const nativeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
    nativeSetter?.call(element, value);
    element.value = value;
  } else if (element.isContentEditable) {
    element.textContent = value;
  }
  dispatchInput(element);
  element.dispatchEvent(new Event('blur', { bubbles: true }));
}

function applyCompletionAnswer(payload: AnswerApplyPayload) {
  const root = questionRootForPayload(payload);
  const fields = (Array.from(root.querySelectorAll('textarea, input[type="text"], input:not([type]), [contenteditable="true"]')) as HTMLElement[])
    .filter((element) => {
      if (!isVisible(element)) return false;
      if (element instanceof HTMLInputElement) {
        const type = (element.getAttribute('type') || 'text').toLowerCase();
        return !['hidden', 'button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image'].includes(type);
      }
      return true;
    });
  if (fields.length === 0) return { success: false, error: '未找到可填写的填空输入框。' };

  const parts = [
    payload.answer,
    ...(payload.matchedOptions || []),
    ...String(payload.answer || '').split(/(?:\n|;|；|,|，|、|\|)/g)
  ]
    .map((part) => cleanText(part).replace(/^第?\d+\s*[空题]?\s*[:：.、)]?\s*/, ''))
    .filter(Boolean);
  const values = parts.length > 1 ? parts : [cleanText(payload.answer || parts[0] || '')];
  fields.forEach((field, index) => fillElementValue(field, values[index] || values[0] || ''));

  const qid = qidForPayload(payload);
  if (qid) {
    const hiddenAnswer = document.querySelector(`#answer${cssEscape(qid)}`) as HTMLInputElement | null;
    if (hiddenAnswer) {
      hiddenAnswer.value = values.join('|');
      dispatchInput(hiddenAnswer);
    }
  }

  return {
    success: true,
    message: `已填入 ${Math.min(fields.length, values.length)} 个填空答案。`,
    values
  };
}

function applyAnswerDirectly(payload: AnswerApplyPayload, targets: QuestionOptionTarget[], clickSelected = true) {
  const answerText = `${payload.answer || ''} ${(payload.matchedOptions || []).join(' ')}`;
  const judgementValue = isJudgementPayload(payload, targets) ? parseJudgementValueStable(answerText) : null;
  const labels = judgementValue ? [] : (targets.length > 0 ? targets.map((target) => target.label.toUpperCase()) : labelsFromPayload(payload));
  const qid = qidForPayload(payload);
  if (!qid || (!judgementValue && labels.length === 0)) return false;

  const root = questionRootForPayload(payload);
  const isJudgement = Boolean(judgementValue) || root.getAttribute('qtype') === '3' || Boolean(root.querySelector('[qtype="3"]'));
  const isMultiple = !isJudgement && (root.getAttribute('qtype') === '1' || Boolean(root.querySelector('[qtype="1"], [qtype="21"]')));
  const answer = isJudgement && judgementValue ? judgementValue : (isMultiple ? labels.slice().sort() : labels).join('');
  const hiddenAnswer = document.querySelector(`#answer${cssEscape(qid)}`) as HTMLInputElement | null;
  if (hiddenAnswer) {
    hiddenAnswer.value = answer;
    dispatchInput(hiddenAnswer);
  }
  if (isJudgement) {
    reportWebviewError('webview:apply-answer-judgement', {
      level: 'info',
      message: `Applied judgement answer: ${answer}`,
      details: {
        qid,
        answer,
        hasHiddenAnswer: Boolean(hiddenAnswer),
        targets: targets.map((target) => ({
          label: target.label,
          value: target.value,
          text: target.text,
          selector: target.selector,
          inputSelector: target.inputSelector,
          clickSelector: target.clickSelector
        }))
      }
    });
  }

  const optionElements = uniqueElements(Array.from(document.querySelectorAll([
    `.choice${cssEscape(qid)}`,
    `[qid="${cssEscape(qid)}"]`,
    `[questionid="${cssEscape(qid)}"]`
  ].join(','))) as HTMLElement[]);
  for (const option of optionElements) {
    const value = isJudgement ? judgementValueFromElement(option) : (option.getAttribute('data') || '').toUpperCase();
    const selected = isJudgement ? value === answer : labels.includes(String(value || '').toUpperCase());
    option.setAttribute('aria-checked', selected ? 'true' : 'false');
    option.setAttribute('aria-pressed', selected ? 'true' : 'false');
    const singleMarker = option.querySelector('.num_option') as HTMLElement | null;
    const multiMarker = option.querySelector('.num_option_dx') as HTMLElement | null;
    if (singleMarker) singleMarker.classList.toggle('check_answer', selected && !isMultiple);
    if (multiMarker) multiMarker.classList.toggle('check_answer_dx', selected);
    option.classList.toggle('check_answer', selected && !isMultiple);
    option.classList.toggle('check_answer_dx', selected && Boolean(isMultiple));
    if (selected && clickSelected) dispatchUserClick(option);
  }

  const pageAny = window as any;
  if (typeof pageAny.loadAnswerSheet === 'function') pageAny.loadAnswerSheet(qid, answer);
  if (typeof pageAny.answerContentChange === 'function') pageAny.answerContentChange();
  return Boolean(hiddenAnswer || optionElements.length > 0);
}

function selectedClassHit(element: HTMLElement) {
  const classText = Array.from(element.classList).join(' ');
  return /(active|selected|checked|current|on|check_answer|check_answer_dx|cur|choose|chosen)/i.test(classText);
}

function isElementSelected(element: HTMLElement, target: QuestionOptionTarget) {
  const input = element.matches('input[type="radio"], input[type="checkbox"]')
    ? element as HTMLInputElement
    : element.querySelector('input[type="radio"], input[type="checkbox"]') as HTMLInputElement | null;
  if (input?.checked) return true;
  if (element.getAttribute('aria-checked') === 'true' || element.getAttribute('aria-pressed') === 'true') return true;
  if (selectedClassHit(element)) return true;
  if (Array.from(element.querySelectorAll('*')).some((child) => selectedClassHit(child as HTMLElement))) return true;
  const clickable = nearestClickableOption(element);
  if (clickable && clickable !== element) {
    const clickableInput = clickable.querySelector('input[type="radio"], input[type="checkbox"]') as HTMLInputElement | null;
    if (clickableInput?.checked) return true;
    if (clickable.getAttribute('aria-checked') === 'true' || clickable.getAttribute('aria-pressed') === 'true') return true;
    if (selectedClassHit(clickable) || Array.from(clickable.querySelectorAll('*')).some((child) => selectedClassHit(child as HTMLElement))) return true;
  }
  return false;
}

function answerStateSignature(element: HTMLElement) {
  const root = element.closest('[qid], [questionid], .questionLi, .question, .question-item, li') as HTMLElement | null;
  const classState = Array.from((root || element).querySelectorAll('*'))
    .filter((child) => selectedClassHit(child as HTMLElement) || child.getAttribute('aria-checked') === 'true' || child.getAttribute('aria-pressed') === 'true')
    .map((child) => selectorFor(child))
    .slice(0, 10)
    .join('|');
  const checkedState = Array.from((root || element).querySelectorAll('input[type="radio"], input[type="checkbox"]'))
    .map((input) => `${selectorFor(input)}:${(input as HTMLInputElement).checked}`)
    .join('|');
  return `${classState}|${checkedState}`;
}

function uniqueElements(elements: Array<HTMLElement | null | undefined>) {
  return elements.filter((element, index, all): element is HTMLElement => {
    return Boolean(element) && all.findIndex((item) => item === element) === index;
  });
}

function resolveAnswerClickCandidates(target: QuestionOptionTarget) {
  const selectors = [target.inputSelector, target.clickSelector, target.selector].filter(Boolean) as string[];
  const baseElements = selectors.map((selector) => document.querySelector(selector) as HTMLElement | null);
  const candidates: Array<HTMLElement | null | undefined> = [];
  for (const element of baseElements) {
    if (!element) continue;
    candidates.push(answerOptionContainer(element));
    candidates.push(nearestClickableOption(element));
    candidates.push(element);
    candidates.push(element.closest('label') as HTMLElement | null);
    candidates.push(element.closest('[role="radio"], [role="checkbox"]') as HTMLElement | null);
    candidates.push(element.closest('li') as HTMLElement | null);
    candidates.push(element.querySelector('input[type="radio"], input[type="checkbox"]') as HTMLElement | null);
    candidates.push(element.querySelector('.num_option, .num_option_dx, .radio, .radio-box, [role="radio"], [role="checkbox"]') as HTMLElement | null);
    candidates.push(element.parentElement);
    candidates.push(element.parentElement?.parentElement);
  }
  return uniqueElements(candidates).filter(isVisible).slice(0, 12);
}

async function clickAnswerTarget(target: QuestionOptionTarget) {
  const candidates = resolveAnswerClickCandidates(target);
  if (candidates.length === 0) throw new Error(`Option not found: ${target.text}`);

  const pageAny = window as any;
  for (const element of candidates) {
    const before = answerStateSignature(element);
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    await new Promise((resolve) => setTimeout(resolve, 220));
    const qtype = element.getAttribute('qtype') || element.closest('[qtype]')?.getAttribute('qtype') || '';
    const actionElement = answerOptionContainer(element);
    element.focus();
    dispatchUserClick(element);
    if (element instanceof HTMLInputElement) {
      element.checked = true;
      dispatchInput(element);
    }
    if (typeof pageAny.addMultipleChoice === 'function' && (qtype === '1' || qtype === '21')) pageAny.addMultipleChoice(actionElement);
    if (typeof pageAny.addChoice === 'function' && (qtype === '0' || qtype === '3' || element.getAttribute('qid'))) pageAny.addChoice(actionElement);
    await new Promise((resolve) => setTimeout(resolve, 260));
    if (isElementSelected(element, target) || answerStateSignature(element) !== before) return;
  }
  throw new Error(`Option matched but was not selected: ${target.label}. ${target.text}`);
}

async function applyAnswer(payload: AnswerApplyPayload) {
  const targets = pickAnswerTargets(payload);
  if (targets.length === 0) {
    return { success: false, error: '未能在当前页面匹配到答案选项。请检查题目选项是否被正确抓取。' };
  }

  try {
    for (const target of targets) await clickAnswerTarget(target);
    return {
      success: true,
      message: `已命中 ${targets.map((target) => target.label).join('、')} 选项。`,
      labels: targets.map((target) => target.label),
      options: targets.map((target) => target.text)
    };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

async function applyAnswerV2(payload: AnswerApplyPayload) {
  if (isFillQuestion(payload)) return applyCompletionAnswer(payload);

  const targets = pickAnswerTargets(payload);
  if (targets.length === 0) {
    if (applyAnswerDirectly(payload, [])) {
      return { success: true, message: `已通过页面答案字段填入 ${labelsFromPayload(payload).join('、')} 选项。` };
    }
    const candidates = fallbackAnswerTargets(payload).slice(0, 8);
    return {
      success: false,
      error: `未能匹配答案选项。答案：${payload.answer || '空'}；选项：${candidates.map((item) => `${item.label}.${item.text}`).join(' | ') || '未抓到'}；qid：${qidForPayload(payload) || '无'}`
    };
  }

  try {
    for (const target of targets) await clickAnswerTarget(target);
    applyAnswerDirectly(payload, targets, false);
    return {
      success: true,
      message: `已命中 ${targets.map((target) => target.label).join('、')} 选项。`,
      labels: targets.map((target) => target.label),
      options: targets.map((target) => target.text)
    };
  } catch (error: any) {
    if (isJudgementPayload(payload, targets) && applyAnswerDirectly(payload, targets, false)) {
      return { success: true, message: `已通过页面答案字段填入 ${labelsFromPayload(payload).join('、')} 选项。` };
    }
    return { success: false, error: error.message };
  }
}

ipcRenderer.on('studypilot:snapshot', () => {
  try {
    ipcRenderer.sendToHost('studypilot:snapshot-result', captureSnapshot());
  } catch (error: any) {
    ipcRenderer.sendToHost('studypilot:snapshot-result', { success: false, error: error.message });
  }
});

ipcRenderer.on('studypilot:extract-question', () => {
  try {
    const questions = extractQuestions();
    if (questions.length === 0) {
      ipcRenderer.sendToHost('studypilot:question-result', { success: false, error: '未在当前页面识别到题目。' });
      return;
    }
    ipcRenderer.sendToHost('studypilot:question-result', { success: true, data: questions[0], questions });
  } catch (error: any) {
    ipcRenderer.sendToHost('studypilot:question-result', { success: false, error: error.message });
  }
});

ipcRenderer.on('studypilot:execute-plan', async (_, plan: AutomationPlan) => {
  const result = await executePlan(plan);
  ipcRenderer.sendToHost('studypilot:execute-result', result);
});

ipcRenderer.on('studypilot:apply-answer', async (_, payload: AnswerApplyPayload) => {
  const result = await applyAnswerV2(payload);
  ipcRenderer.sendToHost('studypilot:apply-answer-result', result);
});

console.log('[StudyPilot] Authorized web automation bridge loaded.');
