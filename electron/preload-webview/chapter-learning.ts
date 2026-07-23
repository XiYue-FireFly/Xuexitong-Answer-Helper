import { ipcRenderer } from 'electron';
import type { ChapterLearningCommand, ChapterLearningOptions, TaskPoint } from './types';
import { reportWebviewError } from './bridge';
import { cleanText, isVisible, uniqueBy } from './dom-utils';
import { callPageHook } from './page-bridge';

type ExtractQuestions = () => unknown[];

function isBlockedInternalTabUrl(url: string) {
  return /(addStudentWorkNewWeb|\/mooc-ans\/work\/(?:addStudentWorkNewWeb|save|submit)|\/work\/(?:addStudentWorkNewWeb|save|submit)|(?:submit|save)StudentWork|submitWork|saveWork)/i.test(String(url || ''));
}

interface ChapterFrameContext {
  window: Window;
  document: Document;
  label: string;
  url: string;
  depth: number;
}

interface ChapterVideoEntry {
  video: HTMLVideoElement;
  frame: ChapterFrameContext;
  index: number;
}

interface ChapterAudioEntry {
  audio: HTMLAudioElement;
  frame: ChapterFrameContext;
  index: number;
}

type ChapterMediaElement = HTMLVideoElement | HTMLAudioElement;
type ChapterMediaEntry = ChapterVideoEntry | ChapterAudioEntry;

const chapterLinkElements = new Map<string, HTMLElement>();

interface ChapterCandidate {
  title: string;
  url: string;
  active: boolean;
  completed?: boolean;
  element?: HTMLElement;
}

type ChapterPlatform = 'chaoxing' | 'zhihuishu' | 'icve' | 'icourse163' | 'yuketang' | 'generic';

const ACTIVE_CHAPTER_SELECTOR = '.current_play,.activeNode,.active,.current,.cur,.selected,.is-active,.is-current,.active-file';
const COMPLETED_CHAPTER_SELECTOR = '.time_icofinish,.isFinish,.finish-icon,.icon-yuanquangou,.jobFinish,.finished,.complete,.completed,label.success,[class*="finish"],[class*="Finish"],[class*="complete"],[class*="Complete"]';
const CHAPTER_ITEM_SELECTOR = '.resource-box .resources-item,.resources-item,.clearfix.video,.child-main,.chapter-content-second,.source-icon,.el-tree-node,.leaf-item,.catalog_item,.chapterItem,.chapter,.knowledge';

function chapterLearningOptions(): Required<ChapterLearningOptions> {
  const pageAny = window as any;
  return {
    autoNext: pageAny.__studyPilotChapterOptions?.autoNext ?? true,
    autoPlay: pageAny.__studyPilotChapterOptions?.autoPlay ?? true,
    muted: pageAny.__studyPilotChapterOptions?.muted ?? false,
    playbackRate: pageAny.__studyPilotChapterOptions?.playbackRate ?? 1,
    autoReadDocument: pageAny.__studyPilotChapterOptions?.autoReadDocument ?? true,
    autoAnswerQuestions: pageAny.__studyPilotChapterOptions?.autoAnswerQuestions ?? false,
    restudy: pageAny.__studyPilotChapterOptions?.restudy ?? false,
    unlockMode: pageAny.__studyPilotChapterOptions?.unlockMode ?? true,
    faceRecognition: pageAny.__studyPilotChapterOptions?.faceRecognition ?? true,
    rateHack: pageAny.__studyPilotChapterOptions?.rateHack ?? true
  };
}

function setChapterLearningOptions(options?: ChapterLearningOptions) {
  const pageAny = window as any;
  pageAny.__studyPilotChapterOptions = {
    ...chapterLearningOptions(),
    ...(options || {})
  };
}

function safeFrameContexts(rootWindow: Window = window, depth = 0, label = '当前页面'): ChapterFrameContext[] {
  const contexts: ChapterFrameContext[] = [];
  try {
    contexts.push({
      window: rootWindow,
      document: rootWindow.document,
      label,
      url: rootWindow.location.href,
      depth
    });
  } catch {
    return contexts;
  }

  if (depth >= 4) return contexts;
  let frames: HTMLIFrameElement[] = [];
  try {
    frames = Array.from(rootWindow.document.querySelectorAll('iframe, frame')) as HTMLIFrameElement[];
  } catch {
    return contexts;
  }

  frames.forEach((frame, index) => {
    try {
      const childWindow = frame.contentWindow;
      const childDocument = frame.contentDocument || childWindow?.document;
      if (!childWindow || !childDocument) return;
      const frameTitle = cleanText(frame.getAttribute('title') || frame.getAttribute('name') || frame.id || `iframe ${index + 1}`);
      contexts.push(...safeFrameContexts(childWindow, depth + 1, frameTitle || `iframe ${index + 1}`));
    } catch {
      // Cross-origin frames are skipped here; they can still receive postMessage commands.
    }
  });

  return contexts;
}

function collectChapterVideos() {
  const entries: ChapterVideoEntry[] = [];
  const seen = new WeakSet<HTMLVideoElement>();
  for (const frame of safeFrameContexts()) {
    let videos: HTMLVideoElement[] = [];
    try {
      videos = Array.from(frame.document.querySelectorAll('video')) as HTMLVideoElement[];
    } catch {
      continue;
    }
    for (const video of videos) {
      if (seen.has(video)) continue;
      if (!isVisible(video) && video.readyState <= 0 && !video.currentSrc && !video.src) continue;
      seen.add(video);
      entries.push({ video, frame, index: entries.length });
    }
  }
  return entries;
}

function collectChapterAudios() {
  const entries: ChapterAudioEntry[] = [];
  const seen = new WeakSet<HTMLAudioElement>();
  for (const frame of safeFrameContexts()) {
    let audios: HTMLAudioElement[] = [];
    try {
      audios = Array.from(frame.document.querySelectorAll('audio')) as HTMLAudioElement[];
    } catch {
      continue;
    }
    for (const audio of audios) {
      if (seen.has(audio)) continue;
      if (!isVisible(audio) && audio.readyState <= 0 && !audio.currentSrc && !audio.src) continue;
      seen.add(audio);
      entries.push({ audio, frame, index: entries.length });
    }
  }
  return entries;
}

function mediaDuration(media: ChapterMediaElement) {
  return Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0;
}

function mediaCurrentTime(media: ChapterMediaElement) {
  return Number.isFinite(media.currentTime) && media.currentTime > 0 ? media.currentTime : 0;
}

function isMediaEnded(media: ChapterMediaElement) {
  const duration = mediaDuration(media);
  return media.ended || (duration > 0 && mediaCurrentTime(media) >= duration - 0.8);
}

function mediaArea(media: ChapterMediaElement) {
  const rect = media.getBoundingClientRect();
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function isMediaInViewport(media: ChapterMediaElement) {
  const rect = media.getBoundingClientRect();
  return rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth;
}

function mediaScore(entry: ChapterMediaEntry) {
  const media = 'video' in entry ? entry.video : entry.audio;
  const duration = mediaDuration(media);
  const area = mediaArea(media);
  let score = 0;
  if (!isMediaEnded(media)) score += 3000;
  if (!media.paused) score += 2500;
  if (isVisible(media)) score += 2000;
  if (isMediaInViewport(media)) score += 1200;
  if (mediaCurrentTime(media) > 0) score += 800;
  if (duration > 0) score += 600;
  if (media.readyState >= 2) score += 400;
  if (media.currentSrc || media.src) score += 300;
  score += Math.min(area / 100, 1000);
  score -= entry.frame.depth * 80;
  return score;
}

function isUsablePrimaryMedia(media: ChapterMediaElement) {
  return media.isConnected && (
    isVisible(media) ||
    isMediaInViewport(media) ||
    !media.paused ||
    (isMediaEnded(media) && mediaArea(media) > 0)
  );
}

function sortMediaEntries<T extends ChapterMediaEntry>(entries: T[]) {
  return entries.slice().sort((left, right) => mediaScore(right) - mediaScore(left));
}

function selectPrimaryVideo(entries = collectChapterVideos()) {
  const options = chapterLearningOptions();
  const previous = (window as any).__studyPilotChapterPrimaryVideo as HTMLVideoElement | undefined;
  const previousEntry = previous ? entries.find((entry) => entry.video === previous) : undefined;
  if (previousEntry && isUsablePrimaryMedia(previousEntry.video)) return previousEntry;

  const visibleEntries = entries.filter((entry) => isUsablePrimaryMedia(entry.video));
  if (options.restudy) {
    // 复习模式：不跳过已完成的视频
    return sortMediaEntries(visibleEntries)[0] ||
      sortMediaEntries(entries.filter((entry) => isUsablePrimaryMedia(entry.video)))[0] ||
      sortMediaEntries(entries)[0];
  }
  return sortMediaEntries(visibleEntries.filter((entry) => !isMediaEnded(entry.video)))[0] ||
    sortMediaEntries(visibleEntries)[0] ||
    sortMediaEntries(entries.filter((entry) => !isMediaEnded(entry.video)))[0] ||
    sortMediaEntries(entries)[0];
}

function selectPrimaryAudio(entries = collectChapterAudios()) {
  const options = chapterLearningOptions();
  const previous = (window as any).__studyPilotChapterPrimaryAudio as HTMLAudioElement | undefined;
  const previousEntry = previous ? entries.find((entry) => entry.audio === previous) : undefined;
  if (previousEntry && isUsablePrimaryMedia(previousEntry.audio)) return previousEntry;

  const visibleEntries = entries.filter((entry) => isUsablePrimaryMedia(entry.audio));
  if (options.restudy) {
    return sortMediaEntries(visibleEntries)[0] ||
      sortMediaEntries(entries.filter((entry) => isUsablePrimaryMedia(entry.audio)))[0] ||
      sortMediaEntries(entries)[0];
  }
  return sortMediaEntries(visibleEntries.filter((entry) => !isMediaEnded(entry.audio)))[0] ||
    sortMediaEntries(visibleEntries)[0] ||
    sortMediaEntries(entries.filter((entry) => !isMediaEnded(entry.audio)))[0] ||
    sortMediaEntries(entries)[0];
}

function rememberPrimaryMedia(videoEntry?: ChapterVideoEntry, audioEntry?: ChapterAudioEntry) {
  const pageAny = window as any;
  pageAny.__studyPilotChapterPrimaryVideo = videoEntry?.video || null;
  pageAny.__studyPilotChapterPrimaryAudio = audioEntry?.audio || null;
}

function pauseNonPrimaryMedia(videoEntry?: ChapterVideoEntry, audioEntry?: ChapterAudioEntry) {
  const primaryVideo = videoEntry?.video;
  const primaryAudio = audioEntry?.audio;
  for (const { video } of collectChapterVideos()) {
    if (video !== primaryVideo && !video.paused) video.pause();
  }
  for (const { audio } of collectChapterAudios()) {
    if (audio !== primaryAudio && !audio.paused) audio.pause();
  }
}

function audioInfo(audio: HTMLAudioElement, index: number, frameLabel?: string) {
  return {
    index,
    duration: Number.isFinite(audio.duration) ? audio.duration : 0,
    currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
    paused: audio.paused,
    muted: audio.muted,
    playbackRate: audio.playbackRate,
    ended: audio.ended,
    src: audio.currentSrc || audio.src || undefined,
    frame: frameLabel || undefined
  };
}

function broadcastChapterFrameCommand(action: 'play' | 'pause' | 'apply-options', options: Required<ChapterLearningOptions>) {
  const payload = { source: 'studypilot', type: 'chapter-frame-command', action, options };
  const post = (target: Window) => {
    try {
      target.postMessage(payload, '*');
    } catch {
      // Ignore frames that reject postMessage.
    }
  };
  post(window);
  const walk = (rootWindow: Window, depth = 0) => {
    if (depth >= 4) return;
    let frames: HTMLIFrameElement[] = [];
    try {
      frames = Array.from(rootWindow.document.querySelectorAll('iframe, frame')) as HTMLIFrameElement[];
    } catch {
      return;
    }
    for (const frame of frames) {
      const childWindow = frame.contentWindow;
      if (!childWindow) continue;
      post(childWindow);
      try {
        walk(childWindow, depth + 1);
      } catch {
        // Cross-origin child has received the direct message already.
      }
    }
  };
  walk(window);
}

function videoInfo(video: HTMLVideoElement, index: number, frameLabel?: string) {
  return {
    index,
    duration: Number.isFinite(video.duration) ? video.duration : 0,
    currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
    paused: video.paused,
    muted: video.muted,
    playbackRate: video.playbackRate,
    ended: video.ended,
    src: video.currentSrc || video.src || undefined,
    frame: frameLabel || undefined
  };
}

function chapterLinkText(anchor: HTMLAnchorElement) {
  return cleanText(
    anchor.innerText ||
    anchor.textContent ||
    anchor.getAttribute('title') ||
    anchor.href
  ).slice(0, 120);
}

function elementLinkText(element: HTMLElement) {
  return cleanText(
    element.innerText ||
    element.textContent ||
    element.getAttribute('title') ||
    element.getAttribute('aria-label') ||
    ''
  ).slice(0, 120);
}

function normalizeChapterCandidateUrl(rawValue: string, baseUrl = window.location.href) {
  const raw = String(rawValue || '').trim();
  if (!raw || /^javascript:/i.test(raw)) return '';
  try {
    const url = new URL(raw, baseUrl).toString();
    if (!/^https?:\/\//i.test(url) || isBlockedInternalTabUrl(url)) return '';
    return url;
  } catch {
    return '';
  }
}

function comparableChapterUrl(rawValue: string) {
  try {
    const url = new URL(rawValue, window.location.href);
    ['t', '_', 'timestamp', 'rand'].forEach((name) => url.searchParams.delete(name));
    return `${url.origin}${url.pathname}?${url.searchParams.toString()}`.replace(/\?$/, '').split('#')[0];
  } catch {
    return String(rawValue || '').split('#')[0];
  }
}

function chapterIdentity(rawValue: string) {
  try {
    const url = new URL(rawValue, window.location.href);
    const id = url.searchParams.get('chapterId') ||
      url.searchParams.get('chapterid') ||
      url.searchParams.get('knowledgeId') ||
      url.searchParams.get('knowledgeid') ||
      url.searchParams.get('leafId') ||
      url.searchParams.get('leafid') ||
      url.searchParams.get('unitId') ||
      url.searchParams.get('unitid') ||
      url.searchParams.get('coursewareId') ||
      url.searchParams.get('coursewareid') ||
      url.searchParams.get('cellId') ||
      url.searchParams.get('cellid');
    return id ? `chapter:${id}` : comparableChapterUrl(url.toString());
  } catch {
    return comparableChapterUrl(rawValue);
  }
}

function urlFromInlineHandler(value: string) {
  const inline = String(value || '');
  const direct = inline.match(/https?:\/\/[^\s"'<>\\)]+/i)?.[0] ||
    inline.match(/['"]((?:\/|\.\.?\/)?(?:mycourse|mooc1|mooc2|mooc2-ans|study-knowledge)\/[^'"]+)['"]/i)?.[1];
  if (direct) return normalizeChapterCandidateUrl(direct);

  const chapterId = inline.match(/(?:chapterId|chapterid|knowledgeId|knowledgeid)\s*[:=,]\s*['"]?(\d+)/i)?.[1];
  if (!chapterId) return '';
  try {
    const current = new URL(window.location.href);
    current.searchParams.set('chapterId', chapterId);
    current.searchParams.set('t', String(Date.now()));
    return current.toString();
  } catch {
    return '';
  }
}

function chapterUrlFromElement(element: HTMLElement) {
  if (element instanceof HTMLAnchorElement) {
    return normalizeChapterCandidateUrl(element.href || element.getAttribute('href') || '');
  }

  const attrs = [
    'href',
    'data-url',
    'data-href',
    'url',
    'link',
    'data-link',
    'data-chapter-url'
  ];
  for (const name of attrs) {
    const url = normalizeChapterCandidateUrl(element.getAttribute(name) || '');
    if (url) return url;
  }

  const inlineUrl = urlFromInlineHandler(element.getAttribute('onclick') || String((element as any).onclick || ''));
  if (inlineUrl) return inlineUrl;

  const chapterId = element.getAttribute('chapterId') ||
    element.getAttribute('chapterid') ||
    element.getAttribute('data-chapterid') ||
    element.getAttribute('data-chapter-id') ||
    element.getAttribute('knowledgeId') ||
    element.getAttribute('knowledgeid') ||
    element.getAttribute('data-knowledgeid');
  if (chapterId) {
    try {
      const current = new URL(window.location.href);
      current.searchParams.set('chapterId', chapterId);
      current.searchParams.set('t', String(Date.now()));
      return current.toString();
    } catch {
      return '';
    }
  }

  return '';
}

function isElementActiveChapter(element: HTMLElement) {
  const classText = String(element.className || '');
  if (/(^|\s)(current_play|activeNode|active|current|cur|selected|is-active|is-current|active-file)(\s|$)/i.test(classText)) return true;
  return Boolean(element.closest(ACTIVE_CHAPTER_SELECTOR));
}

function isElementCompletedChapter(element: HTMLElement) {
  if (element.querySelector(COMPLETED_CHAPTER_SELECTOR)) return true;
  const classText = String(element.className || '');
  if (/(^|\s)(isFinish|finished|complete|completed|jobFinish)(\s|$)/i.test(classText)) return true;
  const progressText = cleanText((element.querySelector('.progress-num, .progress, [class*="progress"]') as HTMLElement | null)?.textContent || element.textContent || '');
  const percent = progressText.match(/(\d{1,3})\s*%/)?.[1];
  if (percent && Number(percent) >= 100) return true;
  const ratio = progressText.match(/(\d+)\s*\/\s*(\d+)/);
  if (ratio && Number(ratio[2]) > 0 && Number(ratio[1]) >= Number(ratio[2])) return true;
  return false;
}

function titleFromChapterElement(element: HTMLElement) {
  const titleNode = element.querySelector('.file-name,.catalogue_title,.chapter-title,.title,.name,.text,.resource-name,.resource-title') as HTMLElement | null;
  return cleanText(
    titleNode?.innerText ||
    titleNode?.textContent ||
    element.getAttribute('title') ||
    element.getAttribute('aria-label') ||
    element.innerText ||
    element.textContent ||
    ''
  ).slice(0, 120);
}

function generatedChapterNodeUrl(frame: ChapterFrameContext, element: HTMLElement, index: number) {
  const seed = cleanText(`${titleFromChapterElement(element)} ${element.className || ''}`).slice(0, 80);
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  return `${(frame.url || window.location.href).split('#')[0]}#studypilot-chapter-${frame.depth}-${index}-${Math.abs(hash)}`;
}

function detectChapterPlatform(): ChapterPlatform {
  const host = location.hostname.toLowerCase();
  const href = location.href.toLowerCase();
  if (host.includes('zhihuishu.com')) return 'zhihuishu';
  if (host.includes('icve.com.cn') || host.includes('zjy2.icve.com.cn') || host.includes('zyk.icve.com.cn')) return 'icve';
  if (host.includes('icourse163.org') || host.includes('icourse163.com') || href.includes('icourse163')) return 'icourse163';
  if (host.includes('yuketang.cn')) return 'yuketang';
  if (host.includes('chaoxing.com') || host.includes('xuexi365.com') || host.includes('mooc1') || host.includes('mooc2')) return 'chaoxing';
  return 'generic';
}

function registerChapterElement(url: string, element: HTMLElement) {
  chapterLinkElements.set(url, element);
  chapterLinkElements.set(comparableChapterUrl(url), element);
  chapterLinkElements.set(chapterIdentity(url), element);
}

function collectElementsAsChapterItems(selector: string, marker: RegExp, fallbackPrefix: string): ChapterCandidate[] {
  const items: ChapterCandidate[] = [];
  const seen = new WeakSet<HTMLElement>();
  for (const frame of safeFrameContexts()) {
    let elements: HTMLElement[] = [];
    try {
      elements = Array.from(frame.document.querySelectorAll(selector)) as HTMLElement[];
    } catch {
      continue;
    }

    for (const element of elements) {
      if (seen.has(element) || !isVisible(element)) continue;
      seen.add(element);
      const text = titleFromChapterElement(element) || elementLinkText(element);
      const haystack = `${text} ${element.className || ''} ${element.id || ''} ${element.getAttribute('href') || ''} ${element.getAttribute('onclick') || ''}`;
      if (!marker.test(haystack)) continue;
      const childLink = element.querySelector('a[href],[onclick],[data-url],[data-href]') as HTMLElement | null;
      const directUrl = chapterUrlFromElement(element) || (childLink ? chapterUrlFromElement(childLink) : '');
      const url = directUrl || generatedChapterNodeUrl(frame, element, items.length);
      registerChapterElement(url, element);
      items.push({
        title: text || `${fallbackPrefix} ${items.length + 1}`,
        url,
        active: isElementActiveChapter(element),
        completed: isElementCompletedChapter(element),
        element
      });
    }
  }
  return uniqueBy(items, (item) => item.url).slice(0, 120);
}

function collectIcveChapterItems() {
  return collectElementsAsChapterItems(
    [
      '.h_cells a',
      '.s_point[itemtype]',
      '.s_point',
      '.s_pointerct',
      '.tabsel',
      '.tabsel.seled',
      '.cells a',
      '.directory a',
      '.courseware-item',
      '.courseware-list li',
      '.res-item',
      '[itemtype]',
      '[data-cell-id]',
      '[data-courseware-id]'
    ].join(','),
    /(s_point|s_pointerct|h_cells|courseware|directory|cell|itemtype|video|audio|doc|ppt|pdf|resource|learn|study|chapter|finish|complete)/i,
    'ICVE'
  );
}

function collectIcourse163ChapterItems() {
  return collectElementsAsChapterItems(
    [
      '.j-unitslist li',
      '.j-lesson',
      '.j-unit',
      '.unit-name',
      '.j-up',
      '.u-learnLesson',
      '.f-cb',
      '[data-unitid]',
      '[data-lessonid]'
    ].join(','),
    /(j-unitslist|lesson|unit|u-icon-video|u-icon-doc|u-icon-discuss|u-icon-test|current|learn|video|doc|quiz|test|finish|complete)/i,
    'iCourse'
  );
}

function collectYuketangChapterItems() {
  return collectElementsAsChapterItems(
    [
      '.chapter-list li',
      '.chapter-list [class*="leaf"]',
      '.study-content__container [class*="leaf"]',
      '.study-unit',
      '.leaf-detail',
      '.leaf-item',
      '[class*="chapter"]',
      '[class*="leaf"]',
      '[data-leaf-id]'
    ].join(','),
    /(chapter|leaf|study|video|homework|exam|quiz|forum|finish|complete|schedule|current|active)/i,
    'Yuketang'
  );
}

function collectZhihuishuChapterItems() {
  return collectElementsAsChapterItems(
    [
      '.clearfix.video',
      '.resources-item',
      '.resource-box',
      '.current_play',
      '.videoLi',
      '.catalogue_item',
      '.learning_catalogue_item',
      '.file-item',
      '.tree-node',
      '.source-icon',
      '.child-main'
    ].join(','),
    /(current_play|resources-item|video|resource|catalogue|file|tree|source|finish|complete|chapter|lesson)/i,
    'Zhihuishu'
  );
}

function collectPlatformChapterItems(platform = detectChapterPlatform()) {
  if (platform === 'icve') return collectIcveChapterItems();
  if (platform === 'icourse163') return collectIcourse163ChapterItems();
  if (platform === 'yuketang') return collectYuketangChapterItems();
  if (platform === 'zhihuishu') return collectZhihuishuChapterItems();
  return [];
}

function collectChaoxingChapterItems(): ChapterCandidate[] {
  const items: ChapterCandidate[] = [];
  const seen = new WeakSet<HTMLElement>();

  for (const frame of safeFrameContexts()) {
    let elements: HTMLElement[] = [];
    try {
      elements = Array.from(frame.document.querySelectorAll(CHAPTER_ITEM_SELECTOR)) as HTMLElement[];
    } catch {
      continue;
    }

    for (const element of elements) {
      if (seen.has(element) || !isVisible(element)) continue;
      seen.add(element);
      const marker = `${element.className || ''} ${element.id || ''} ${element.textContent || ''}`;
      if (!/(current_play|activeNode|resources-item|clearfix|chapter|knowledge|catalog|video|resource|source|child|leaf|task|course|progress|finish)/i.test(marker)) continue;

      const childLink = element.querySelector('a[href],[onclick],[data-url],[data-href]') as HTMLElement | null;
      const directUrl = chapterUrlFromElement(element) || (childLink ? chapterUrlFromElement(childLink) : '');
      const url = directUrl || generatedChapterNodeUrl(frame, element, items.length);
      const item = {
        title: titleFromChapterElement(element) || `Chapter ${items.length + 1}`,
        url,
        active: isElementActiveChapter(element),
        completed: isElementCompletedChapter(element),
        element
      };
      registerChapterElement(url, element);
      items.push(item);
    }
  }

  return uniqueBy(items, (item) => item.url).slice(0, 120);
}

function isLikelyChapterAnchor(anchor: HTMLAnchorElement) {
  const text = chapterLinkText(anchor);
  const haystack = `${text} ${anchor.href} ${anchor.className || ''} ${anchor.getAttribute('onclick') || ''}`;
  if (!anchor.href || isBlockedInternalTabUrl(anchor.href)) return false;
  if (/\.(?:png|jpe?g|gif|webp|svg|ico|css|js)(?:[?#]|$)/i.test(anchor.href)) return false;
  return /(章节|任务点|视频|学习|第\s*\d+|chapter|knowledge|course|clazz|mooc|ans|jobid|courseid|clazzid)/i.test(haystack);
}

function collectChapterLinks() {
  chapterLinkElements.clear();
  const chaoxingItems = collectChaoxingChapterItems();
  const platformItems = collectPlatformChapterItems();
  const candidates = safeFrameContexts()
    .flatMap((frame) => {
      try {
        return Array.from(frame.document.querySelectorAll([
          'a[href]',
          '[onclick]',
          '[chapterId]',
          '[chapterid]',
          '[knowledgeId]',
          '[knowledgeid]',
          '[data-chapterid]',
          '[data-chapter-id]',
          '[data-knowledgeid]',
          '[data-url]',
          '[data-href]',
          '[data-leaf-id]',
          '[data-unitid]',
          '[data-lessonid]',
          '[data-cell-id]',
          '[data-courseware-id]',
          '.chapter',
          '.chapterItem',
          '.catalog_item',
          '.knowledge',
          '.j-unitslist li',
          '.chapter-list li',
          '.s_point',
          '.s_pointerct',
          '.h_cells a'
        ].join(','))) as HTMLElement[];
      } catch {
        return [];
      }
    });
  const currentUrl = comparableChapterUrl(window.location.href);
  const currentIdentity = chapterIdentity(window.location.href);
  const linksFromAnchors = uniqueBy<ChapterCandidate>(
    candidates
      .filter((element) => isVisible(element) && (element instanceof HTMLAnchorElement ? isLikelyChapterAnchor(element) : true))
      .map((element) => {
        const url = chapterUrlFromElement(element);
        if (!url) return null;
        const text = element instanceof HTMLAnchorElement ? chapterLinkText(element) : elementLinkText(element);
        const haystack = `${text} ${url} ${element.className || ''} ${element.getAttribute('onclick') || ''}`;
        if (!/(章节|任务点|视频|学习|第\s*\d+|chapter|knowledge|course|clazz|mooc|ans|jobid|courseid|clazzid|chapterId|knowledgeId)/i.test(haystack)) return null;
        const active = comparableChapterUrl(url) === currentUrl ||
          chapterIdentity(url) === currentIdentity ||
          /(^|\s)(active|current|on|cur|selected)(\s|$)/i.test(String(element.className || '')) ||
          Boolean(element.closest('.active,.current,.on,.cur,.selected'));
        registerChapterElement(url, element);
        return {
          title: text || url,
          url,
          active
        };
      })
      .filter((item): item is ChapterCandidate => Boolean(item)),
    (item) => item.url
  ).slice(0, 80);

  const links = uniqueBy<ChapterCandidate>([
    ...chaoxingItems,
    ...platformItems,
    ...linksFromAnchors
  ], (item) => item.url).slice(0, 120);

  let activeChapterIndex = links.findIndex((item) => item.active);
  if (activeChapterIndex < 0) {
    activeChapterIndex = links.findIndex((item) => comparableChapterUrl(item.url) === currentUrl || chapterIdentity(item.url) === currentIdentity);
  }
  const nextChapter = activeChapterIndex >= 0
    ? (links.slice(activeChapterIndex + 1).find((item) => !item.completed) || links[activeChapterIndex + 1])
    : links.find((item) => !item.completed) || links[0];
  return {
    links: links.map((item) => ({ title: item.title, url: item.url, active: item.active })),
    activeChapterIndex,
    nextChapter: nextChapter ? { title: nextChapter.title, url: nextChapter.url, active: nextChapter.active } : undefined
  };
}

function collectTaskPoints(): TaskPoint[] {
  const taskPoints: TaskPoint[] = [];

  for (const frame of safeFrameContexts()) {
    try {
      const doc = frame.document;

      const jobElements = Array.from(doc.querySelectorAll([
        '.jobItem',
        '.job',
        '[id^="job"]',
        '.jobTodo',
        '.jobFinish',
        '.clearfix.video',
        '.resources-item',
        '.child-main',
        '.leaf-item',
        '.chapter-content-second',
        '.source-icon',
        '.s_point[itemtype]',
        '.s_pointerct',
        '.docBox',
        '.j-unitslist li',
        '.u-questionItem',
        '.chapter-list li',
        '[class*="leaf"]',
        '[itemtype]'
      ].join(','))) as HTMLElement[];
      for (const element of jobElements) {
        const classText = element.className || '';
        const completed = isElementCompletedChapter(element) || /finish|done|complete|已完成/i.test(classText);
        const title = cleanText(element.getAttribute('title') || element.textContent || '任务点');

        let type: TaskPoint['type'] = 'unknown';
        if (/video|视频|mp4/i.test(title + classText)) type = 'video';
        else if (/document|文档|doc|ppt|pdf/i.test(title + classText)) type = 'document';
        else if (/audio|音频|mp3/i.test(title + classText)) type = 'audio';
        else if (/work|作业|homework/i.test(title + classText)) type = 'work';
        else if (/exam|考试|test/i.test(title + classText)) type = 'exam';

        taskPoints.push({ type, title, completed, element });
      }

      const iframes = Array.from(doc.querySelectorAll('iframe')) as HTMLIFrameElement[];
      for (const iframe of iframes) {
        try {
          const iframeDoc = iframe.contentDocument;
          if (!iframeDoc) continue;

          if (iframeDoc.querySelector('.reader, .document-reader, #reader, .ppt-reader, .pdf-reader, .ux-pdf-reader, .ux-h5pdfreader_container')) {
            const title = cleanText(iframe.getAttribute('title') || '文档阅读');
            const completed = Boolean(iframeDoc.querySelector('.finish, .complete, [class*="finish"]'));
            taskPoints.push({ type: 'document', title, completed, iframe });
          }

          if (iframeDoc.querySelector('video')) {
            const video = iframeDoc.querySelector('video') as HTMLVideoElement;
            const completed = video.ended || (video.currentTime > 0 && video.currentTime >= video.duration - 1);
            const title = cleanText(iframe.getAttribute('title') || '视频播放');
            taskPoints.push({ type: 'video', title, completed, iframe });
          }
        } catch {
          // Cross-origin iframe
        }
      }
    } catch {
      // Frame access error
    }
  }

  return taskPoints;
}

function findDocumentReaders(): Array<{ iframe?: HTMLIFrameElement; doc: Document; title: string }> {
  const readers: Array<{ iframe?: HTMLIFrameElement; doc: Document; title: string }> = [];

  for (const frame of safeFrameContexts()) {
    try {
      const frameReader = frame.document.querySelector([
        '.reader',
        '.document-reader',
        '#reader',
        '.ppt-reader',
        '.pdf-reader',
        '.ux-pdf-reader',
        '.ux-h5pdfreader_container',
        '.readerPager',
        '.docBox'
      ].join(','));
      const framePages = frame.document.querySelector('.page, .pageItem, [class*="page"], .ux-h5pdfreader_container_footer_pages_total, .ux-h5pdfreader_container_footer_pages_in');
      if (frameReader || framePages) {
        readers.push({ doc: frame.document, title: cleanText(frame.document.title || frame.label || 'document reader') });
      }

      const iframes = Array.from(frame.document.querySelectorAll('iframe')) as HTMLIFrameElement[];
      for (const iframe of iframes) {
        try {
          const doc = iframe.contentDocument;
          if (!doc) continue;

          const hasReader = doc.querySelector('.reader, .document-reader, #reader, .ppt-reader, .pdf-reader, .ux-pdf-reader, .ux-h5pdfreader_container');
          const hasPages = doc.querySelector('.page, .pageItem, [class*="page"], .ux-h5pdfreader_container_footer_pages_total, .ux-h5pdfreader_container_footer_pages_in');

          if (hasReader || hasPages) {
            const title = cleanText(iframe.getAttribute('title') || iframe.id || '文档阅读器');
            readers.push({ iframe, doc, title });
          }
        } catch {
          // Cross-origin iframe
        }
      }
    } catch {
      // Frame access error
    }
  }

  return readers;
}

function isSelectedQuizOption(element: HTMLElement) {
  if (element.getAttribute('aria-checked') === 'true') return true;
  if (/(^|\s)(active|selected|checked|is-checked)(\s|$)/i.test(String(element.className || ''))) return true;
  const input = element.querySelector('input[type="radio"], input[type="checkbox"]') as HTMLInputElement | null;
  return Boolean(input?.checked);
}

function isDisabledElement(element: HTMLElement) {
  return element.hasAttribute('disabled') ||
    element.getAttribute('aria-disabled') === 'true' ||
    /(^|\s)(disabled|is-disabled)(\s|$)/i.test(String(element.className || ''));
}

async function handleChapterTestDialogs() {
  const options = chapterLearningOptions();
  let foundDialog = false;
  let handled = false;

  for (const frame of safeFrameContexts()) {
    let dialogs: HTMLElement[] = [];
    try {
      dialogs = Array.from(frame.document.querySelectorAll('#playTopic-dialog,.ai-test-question-wrapper,.ai-class-exercise-dialog,.topic-dialog,.el-dialog__wrapper,.u-questionItem,[class*=questionBody],[class*="quiz"],[class*="Question"]')) as HTMLElement[];
    } catch {
      continue;
    }

    for (const dialog of dialogs) {
      if (!isVisible(dialog)) continue;
      const dialogText = cleanText(dialog.textContent || '');
      const looksLikeQuestion = dialog.matches('#playTopic-dialog,.ai-test-question-wrapper,.ai-class-exercise-dialog,.topic-dialog') ||
        /(topic|question|quiz|test|radio|checkbox|题|问|答)/i.test(dialogText);
      if (!looksLikeQuestion) continue;

      foundDialog = true;
      if (!options.autoAnswerQuestions) {
        sendChapterLearningState('Detected an in-video quiz. Enable auto question handling or answer it manually.');
        return { found: true, handled: false };
      }

      const pagers = Array.from(dialog.querySelectorAll('.el-pager .number,.pager .number,[class*="pager"] button')) as HTMLElement[];
      const pages = pagers.length > 0 ? pagers : [dialog];
      for (const page of pages) {
        if (page !== dialog && isVisible(page) && !page.classList.contains('active')) {
          page.click();
          await new Promise(resolve => setTimeout(resolve, 300));
        }

        const optionElements = Array.from(dialog.querySelectorAll('ul .topic-item,.topic .radio ul > li,.topic .checkbox ul > li,.el-radio,.el-checkbox,label,.u-answerItem,.u-questionItem li,[class*="option"],[role="radio"],[role="checkbox"]')) as HTMLElement[];
        const visibleOptions = optionElements.filter((item) => isVisible(item) && !isDisabledElement(item));
        if (visibleOptions.length > 0 && !visibleOptions.some(isSelectedQuizOption)) {
          visibleOptions[0].click();
          handled = true;
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      const actionButtons = Array.from(dialog.querySelectorAll('.submit,.confirm,.btn,.close-btn,.el-button--primary,.j-continue,button')) as HTMLElement[];
      const button = actionButtons.find((item) => {
        if (!isVisible(item) || isDisabledElement(item)) return false;
        const text = cleanText(item.textContent || item.getAttribute('title') || '');
        return /^(submit|confirm|ok|close|next|continue|done|继续|确定|提交|关闭|完成|下一题)$/i.test(text) ||
          item.matches('.close-btn,.submit,.confirm,.el-button--primary');
      });
      if (button) {
        button.click();
        handled = true;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }

  if (handled) sendChapterLearningState('Handled chapter quiz dialog.');
  return { found: foundDialog, handled };
}

function isAllTaskPointsCompleted(): boolean {
  const taskPoints = collectTaskPoints();
  if (taskPoints.length === 0) return false;
  return taskPoints.every(point => point.completed);
}

function applyChapterVideoOptions(video: HTMLVideoElement) {
  const options = chapterLearningOptions();
  const rate = Math.max(0, Math.min(16, Number(options.playbackRate) || 0));
  video.muted = options.muted;
  if (rate <= 0) {
    video.pause();
    return;
  }
  video.playbackRate = rate;
}

function applyChapterAudioOptions(audio: HTMLAudioElement) {
  const options = chapterLearningOptions();
  const rate = Math.max(0, Math.min(16, Number(options.playbackRate) || 0));
  audio.muted = options.muted;
  if (rate <= 0) {
    audio.pause();
    return;
  }
  audio.playbackRate = rate;
}

function handlePlatformContinueButtons() {
  let clicked = false;
  for (const frame of safeFrameContexts()) {
    let buttons: HTMLElement[] = [];
    try {
      buttons = Array.from(frame.document.querySelectorAll([
        '.j-unitctBox .u-btn-default.j-continue',
        '.j-continue',
        '.u-btn-default.j-continue',
        '.el-button--primary',
        '.next-topic.next-t',
        '.paging_next',
        'button'
      ].join(','))) as HTMLElement[];
    } catch {
      continue;
    }

    const target = buttons.find((button) => {
      if (!isVisible(button) || isDisabledElement(button)) return false;
      const text = cleanText(button.textContent || button.getAttribute('title') || button.getAttribute('aria-label') || '');
      if (button.matches('.j-continue,.next-topic.next-t,.paging_next')) return true;
      return /^(continue|next|start|resume|ok|confirm|done)$/i.test(text);
    });
    if (!target) continue;
    target.click();
    clicked = true;
  }
  return clicked;
}

function resumeMediaIfNeeded(media: ChapterMediaElement) {
  const pageAny = window as any;
  const options = chapterLearningOptions();
  if (!pageAny.__studyPilotChapterRunning || !options.autoPlay || Number(options.playbackRate) <= 0 || isMediaEnded(media)) return;
  window.setTimeout(() => {
    if (!pageAny.__studyPilotChapterRunning || !media.paused || isMediaEnded(media)) return;
    try {
      void media.play();
    } catch {
      // The polling loop retries when a player requires user interaction.
    }
  }, 600);
}

function captureChapterLearningState(message = '已读取当前页面章节状态。') {
  const videoEntries = collectChapterVideos();
  const videos = videoEntries.map((entry) => videoInfo(entry.video, entry.index, entry.frame.label));
  const audioEntries = collectChapterAudios();
  const audios = audioEntries.map((entry) => audioInfo(entry.audio, entry.index, entry.frame.label));
  const chapterData = collectChapterLinks();
  const taskPoints = collectTaskPoints();
  const readers = findDocumentReaders();

  return {
    success: true,
    data: {
      url: window.location.href,
      title: document.title || window.location.href,
      videos,
      audios,
      chapters: chapterData.links,
      activeChapterIndex: chapterData.activeChapterIndex,
      nextChapter: chapterData.nextChapter,
      taskPoints: taskPoints.map(point => ({
        type: point.type,
        title: point.title,
        completed: point.completed
      })),
      documentReaders: readers.length,
      allTasksCompleted: isAllTaskPointsCompleted(),
      lastMessage: message,
      updatedAt: Date.now(),
      running: Boolean((window as any).__studyPilotChapterRunning)
    }
  };
}

function sendChapterLearningState(message?: string) {
  ipcRenderer.sendToHost('studypilot:chapter-learning-result', captureChapterLearningState(message));
}

function attachPrimaryChapterVideoWatchers() {
  const pageAny = window as any;
  if (!pageAny.__studyPilotChapterWatchedPrimaryVideos) pageAny.__studyPilotChapterWatchedPrimaryVideos = new WeakSet();
  const watched = pageAny.__studyPilotChapterWatchedPrimaryVideos as WeakSet<HTMLVideoElement>;
  for (const { video } of collectChapterVideos()) {
    if (watched.has(video)) continue;
    watched.add(video);
    video.addEventListener('ended', () => {
      if (!pageAny.__studyPilotChapterRunning) return;
      if (pageAny.__studyPilotChapterPrimaryVideo && pageAny.__studyPilotChapterPrimaryVideo !== video) return;
      openNextChapterIfAvailableDeep('primary-video-ended');
    });
    video.addEventListener('play', () => {
      if (pageAny.__studyPilotChapterPrimaryVideo === video) sendChapterLearningState('视频正在播放。');
    });
    video.addEventListener('pause', () => {
      resumeMediaIfNeeded(video);
      if (!video.ended && pageAny.__studyPilotChapterPrimaryVideo === video) sendChapterLearningState('视频已暂停。');
    });
  }
}

function openNextChapterIfAvailableDeep(reason: string) {
  const options = chapterLearningOptions();
  const pageAny = window as any;
  if (!options.autoNext || !pageAny.__studyPilotChapterRunning) return false;
  if (pageAny.__studyPilotChapterOpeningNext && Date.now() - pageAny.__studyPilotChapterOpeningNext < 12000) return true;
  const { nextChapter } = collectChapterLinks();
  if (!nextChapter?.url) {
    sendChapterLearningState('当前视频已自然播放结束，但未识别到下一章节。');
    return false;
  }
  pageAny.__studyPilotChapterOpeningNext = Date.now();
  const targetElement = chapterLinkElements.get(nextChapter.url) ||
    chapterLinkElements.get(comparableChapterUrl(nextChapter.url)) ||
    chapterLinkElements.get(chapterIdentity(nextChapter.url));
  if (targetElement && targetElement.ownerDocument?.contains(targetElement)) {
    try {
      targetElement.scrollIntoView({ block: 'center', inline: 'center' });
      targetElement.click();
      ipcRenderer.sendToHost('studypilot:chapter-open-next', {
        url: nextChapter.url,
        title: nextChapter.title,
        reason: `${reason}-click`,
        options,
        clickedInPage: true
      });
      sendChapterLearningState(`当前媒体已完成，正在点击下一章节：${nextChapter.title}`);
      return true;
    } catch {
      // Fall back to opening the resolved URL below.
    }
  }
  if (nextChapter.url.includes('#studypilot-chapter-')) {
    pageAny.__studyPilotChapterOpeningNext = 0;
    sendChapterLearningState(`Next chapter was detected as an in-page node but could not be clicked: ${nextChapter.title}`);
    return false;
  }
  ipcRenderer.sendToHost('studypilot:chapter-open-next', {
    url: nextChapter.url,
    title: nextChapter.title,
    reason,
    options
  });
  sendChapterLearningState(`当前视频已自然结束，正在打开下一章节：${nextChapter.title}`);
  return true;
}

function stopChapterLearningLoop() {
  const pageAny = window as any;
  if (pageAny.__studyPilotChapterTimer) {
    window.clearTimeout(pageAny.__studyPilotChapterTimer);
    pageAny.__studyPilotChapterTimer = null;
  }
  pageAny.__studyPilotChapterTickBusy = false;
}

async function playPrimaryChapterMedia() {
  const options = chapterLearningOptions();
  const videoEntries = collectChapterVideos();
  const audioEntries = collectChapterAudios();
  const primaryVideo = selectPrimaryVideo(videoEntries);
  const primaryAudio = primaryVideo ? undefined : selectPrimaryAudio(audioEntries);

  rememberPrimaryMedia(primaryVideo, primaryAudio);
  pauseNonPrimaryMedia(primaryVideo, primaryAudio);
  broadcastChapterFrameCommand('apply-options', options);

  if (!options.autoPlay || Number(options.playbackRate) <= 0) {
    return { videoEntries, audioEntries, primaryVideo, primaryAudio, played: 0 };
  }

  let played = 0;
  if (primaryVideo && !isMediaEnded(primaryVideo.video)) {
    applyChapterVideoOptions(primaryVideo.video);
    if (primaryVideo.video.paused) {
      try {
        await primaryVideo.video.play();
        played = primaryVideo.video.paused ? 0 : 1;
      } catch (error: any) {
        reportWebviewError('webview:chapter-video-play', {
          level: 'warn',
          message: `视频播放需要页面允许或用户手动点击：${error?.message || 'unknown'}`,
          details: { options }
        });
      }
    }
  } else if (primaryAudio && !isMediaEnded(primaryAudio.audio)) {
    applyChapterAudioOptions(primaryAudio.audio);
    if (primaryAudio.audio.paused) {
      try {
        await primaryAudio.audio.play();
        played = primaryAudio.audio.paused ? 0 : 1;
      } catch {
        // Some players require one user gesture first; the loop will retry.
      }
    }
  }

  return { videoEntries, audioEntries, primaryVideo, primaryAudio, played };
}

// ===== 倍速防清进度：通过页面桥代理到页面上下文执行 =====
async function applyRateHack() {
  const options = chapterLearningOptions();
  if (!options.rateHack) return;
  await callPageHook({ kind: 'applyRateHack', playbackRate: options.playbackRate }, 1500);
}

// ===== 人脸识别检测 =====
function hasFaceRecognition(): boolean {
  const topWin = (window as any).top || window;
  try {
    const faces = topWin.document.querySelectorAll('#fcqrimg');
    for (const face of faces) {
      if (face.getAttribute('src')) return true;
    }
    const masks = topWin.document.querySelectorAll('.chapterVideoFaceMaskDiv');
    for (const mask of masks) {
      if ((mask as HTMLElement).style.display !== 'none') return true;
    }
  } catch {
    // 跨域 top 访问失败，降级检查当前窗口
    const faces = document.querySelectorAll('#fcqrimg');
    for (const face of faces) {
      if (face.getAttribute('src')) return true;
    }
  }
  return false;
}

// 人脸识别等待必须单例化：setInterval 重叠的 tick 每个都会新建一个 3s 轮询 interval 且永不清理，
// 人脸弹窗期间定时器无限堆积；停止学习时也必须能取消等待
async function waitForFaceRecognition(): Promise<void> {
  const pageAny = window as any;
  if (!hasFaceRecognition()) return;
  if (pageAny.__studyPilotFaceWait) {
    await pageAny.__studyPilotFaceWait;
    return;
  }
  sendChapterLearningState('检测到人脸识别，已暂停自动化，请手动完成识别后继续。');
  pageAny.__studyPilotFaceWait = new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      // 停止学习时立即结束等待，避免定时器残留
      if (!pageAny.__studyPilotChapterRunning || !hasFaceRecognition()) {
        clearInterval(interval);
        pageAny.__studyPilotFaceWait = null;
        if (pageAny.__studyPilotChapterRunning) {
          sendChapterLearningState('人脸识别已完成，继续学习。');
        }
        resolve();
      }
    }, 3000);
  });
  await pageAny.__studyPilotFaceWait;
}

// ===== 视频弹窗测验自动处理 =====
async function handleVideoQuizDialog(): Promise<boolean> {
  const pageAny = window as any;
  // 超星弹窗测验 #playTopic-dialog
  const dialog = document.querySelector('#playTopic-dialog');
  if (dialog && isVisible(dialog as HTMLElement)) {
    try {
      const items = Array.from(dialog.querySelectorAll('.el-pager .number')) as HTMLElement[];
      if (items.length) {
        for (const item of items) {
          if (!item.classList.contains('active')) {
            item.click();
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          const options = Array.from(dialog.querySelectorAll('ul .topic-item')) as HTMLElement[];
          if (options.length) {
            // 直接点击列表元素自身：此前索引用列表 A 计算却点击另一 DOM 路径的列表 B，
            // 数量/顺序不一致时会点错或越界不点任何项
            const random = Math.floor(Math.random() * options.length);
            await new Promise(resolve => setTimeout(resolve, 1000));
            options[random].click();
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
        (dialog.querySelector('.close-btn, .btn') as HTMLElement)?.click();
      }
      await new Promise(resolve => setTimeout(resolve, 3000));
      return true;
    } catch {
      // 忽略
    }
  }
  // 超星 videoquiz
  const submitBtn = document.querySelector('#videoquiz-submit') as HTMLElement | null;
  if (submitBtn && isVisible(submitBtn)) {
    try {
      const labels = Array.from(document.querySelectorAll('.ans-videoquiz-opt label')) as HTMLElement[];
      if (labels.length) {
        labels[Math.floor(Math.random() * labels.length)].click();
        submitBtn.click();
        await new Promise(resolve => setTimeout(resolve, 3000));
        const container = document.querySelector('#video .ans-videoquiz') as HTMLElement | null;
        container?.remove();
      }
      return true;
    } catch {
      // 忽略
    }
  }
  return false;
}

// ===== 闯关模式解锁 =====
async function tryUnlockChapter(): Promise<boolean> {
  const pageAny = window as any;
  if (!pageAny.__studyPilotChapterRunning) return false;
  try {
    // 检查是否有未开放章节提示
    const bodyText = document.body?.innerText || '';
    if (!/章节未开放|未解锁|闯关/.test(bodyText)) return false;
    // 尝试调用超星解锁接口
    const curCourseId = document.querySelector('#curCourseId') as HTMLInputElement | null;
    const curChapterId = document.querySelector('#curChapterId') as HTMLInputElement | null;
    const curClazzId = document.querySelector('#curClazzId') as HTMLInputElement | null;
    const mooc1Domain = pageAny.ServerHost?.mooc1Domain;
    if (curCourseId && curChapterId && curClazzId && mooc1Domain) {
      const url = `${mooc1Domain}/job/submitstudy?node=${curChapterId.value}&userid=${pageAny.uid || ''}&clazzid=${curClazzId.value}&courseid=${curCourseId.value}&personid=&view=json`;
      await fetch(url, { credentials: 'include' }).catch(() => {});
      sendChapterLearningState('已尝试解锁当前章节。');
      return true;
    }
  } catch {
    // 忽略
  }
  return false;
}

// ===== 超星特定下一章跳转 =====
async function tryChaoxingNextChapter(): Promise<boolean> {
  try {
    // 方式1: 通过页面桥调用 PCount.next
    const result = await callPageHook({ kind: 'tryNextChapter' }, 1000);
    if (result?.ok) return true;
    // 方式2: 点击下一章节图标
    const topWin = (window as any).top || window;
    const nextIcon = topWin.document.querySelector('.nodeItem.r i') as HTMLElement | null;
    if (nextIcon) {
      nextIcon.click();
      return true;
    }
  } catch {
    // 跨域或非超星环境
  }
  return false;
}

// ===== 增强 PPT/文档自动阅读 =====
async function enhancedDocumentRead(reader: { iframe?: HTMLIFrameElement; doc: Document; title: string }): Promise<{ success: boolean; action: string }> {
  const doc = reader.doc;

  // 超星 PPT swiperNext：通过页面桥代理
  const pptResult = await callPageHook({ kind: 'pptNext' }, 1000);
  if (pptResult?.ok) {
    const slides = doc.querySelectorAll('.swiper-container .swiper-slide');
    const slideCount = slides.length > 0 ? slides.length : 1;
    for (let i = 1; i < slideCount; i++) {
      await callPageHook({ kind: 'pptNext' }, 1000);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return { success: true, action: 'ppt-next' };
  }

  // 超星 finishJob：通过页面桥代理
  const jobResult = await callPageHook({ kind: 'finishJob' }, 1000);
  if (jobResult?.ok) {
    return { success: true, action: 'finish-job' };
  }

  // 超星 readweb.goto：通过页面桥代理
  const readResult = await callPageHook({ kind: 'readGoto', target: 'epage' }, 1000);
  if (readResult?.ok) {
    return { success: true, action: 'read-goto' };
  }

  // 通用翻页按钮
  const nextButton = doc.querySelector('.next, .nextPage, [class*="next"], [onclick*="next"]') as HTMLElement | null;
  if (nextButton && isVisible(nextButton)) {
    nextButton.click();
    await new Promise(resolve => setTimeout(resolve, 800));
    return { success: true, action: 'next-page' };
  }

  // 通用完成按钮
  const finishButton = doc.querySelector('.finish, .complete, [class*="finish"], [onclick*="finish"]') as HTMLElement | null;
  if (finishButton && isVisible(finishButton)) {
    finishButton.click();
    await new Promise(resolve => setTimeout(resolve, 500));
    return { success: true, action: 'finish' };
  }

  // 通用滚动
  const scrollContainer = doc.querySelector('.reader, .document-reader, #reader') as HTMLElement | null;
  if (scrollContainer) {
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
    await new Promise(resolve => setTimeout(resolve, 500));
    return { success: true, action: 'scroll' };
  }

  return { success: false, action: 'none' };
}

function startChapterLearningLoop(extractQuestions: ExtractQuestions) {
  const pageAny = window as any;
  stopChapterLearningLoop();
  // 递归 setTimeout + 重入锁：setInterval 不等待 async 回调（单 tick 可达数十秒），
  // 多 tick 并发会重复点击/重复 play()/状态洪峰；每个 await 后复查 running 标志保证停止立即生效
  const tick = async () => {
    if (!pageAny.__studyPilotChapterRunning) {
      stopChapterLearningLoop();
      return;
    }
    if (pageAny.__studyPilotChapterTickBusy) {
      pageAny.__studyPilotChapterTimer = window.setTimeout(tick, 500);
      return;
    }
    pageAny.__studyPilotChapterTickBusy = true;
    // 每个 await 后复查 running：stop 只清定时器，在途 tick 若不复查会继续播放媒体
    const stillRunning = () => Boolean(pageAny.__studyPilotChapterRunning);
    try {
      const options = chapterLearningOptions();

      // 倍速防清进度（通过页面桥代理到页面上下文）
      if (options.rateHack) await applyRateHack();

      // 人脸识别检测
      if (options.faceRecognition && hasFaceRecognition()) {
        await waitForFaceRecognition();
      }
      if (!stillRunning()) return;

      // 视频弹窗测验处理
      const quizHandled = await handleVideoQuizDialog();
      if (quizHandled) {
        sendChapterLearningState('已自动处理视频弹窗测验。');
      }
      if (!stillRunning()) return;

      attachPrimaryChapterVideoWatchers();
      const dialogState = await handleChapterTestDialogs();
      if (dialogState.found && !dialogState.handled && !options.autoAnswerQuestions) return;
      if (handlePlatformContinueButtons()) {
        sendChapterLearningState('Clicked a platform continue/next button.');
      }

      const videoEntries = collectChapterVideos();
      const audioEntries = collectChapterAudios();

      for (const { video } of videoEntries) applyChapterVideoOptions(video);
      for (const { audio } of audioEntries) applyChapterAudioOptions(audio);
      const primaryState = await playPrimaryChapterMedia();
      if (!stillRunning()) return;

      if (options.autoReadDocument) {
        const readers = findDocumentReaders();
        for (const reader of readers) {
          if (!stillRunning()) return;
          try {
            const result = await enhancedDocumentRead(reader);
            if (result.success && result.action !== 'none') {
              sendChapterLearningState(`文档阅读中：${reader.title} - ${result.action}`);
            }
          } catch (error: any) {
            reportWebviewError('webview:auto-read-document', {
              level: 'warn',
              message: `文档自动阅读失败: ${error?.message || 'unknown'}`
            });
          }
        }
      }

      const primaryVideoEnded = Boolean(primaryState.primaryVideo && isMediaEnded(primaryState.primaryVideo.video));
      const primaryAudioEnded = Boolean(!primaryState.primaryVideo && primaryState.primaryAudio && isMediaEnded(primaryState.primaryAudio.audio));
      const currentMediaEnded = primaryVideoEnded || primaryAudioEnded;

      const allTasksCompleted = isAllTaskPointsCompleted();

      // 纯图文章节（无媒体/任务点/文档）无法以“媒体结束/任务完成”驱动翻章，
      // 连续多轮无内容时按超时翻章，避免自动化卡死在当前章
      if (!currentMediaEnded && !allTasksCompleted && videoEntries.length === 0 && audioEntries.length === 0) {
        const idleReaders = findDocumentReaders();
        const idleTasks = collectTaskPoints();
        if (idleReaders.length === 0 && idleTasks.length === 0) {
          pageAny.__studyPilotChapterIdleTicks = (pageAny.__studyPilotChapterIdleTicks || 0) + 1;
        } else {
          pageAny.__studyPilotChapterIdleTicks = 0;
        }
      } else {
        pageAny.__studyPilotChapterIdleTicks = 0;
      }
      const idleTimeout = (pageAny.__studyPilotChapterIdleTicks || 0) >= 4;

      if (currentMediaEnded || allTasksCompleted || idleTimeout) {
        const shouldProceed = await checkIfShouldProceedToNext(extractQuestions);
        if (shouldProceed && stillRunning()) {
          // 闯关模式解锁
          if (options.unlockMode) {
            await tryUnlockChapter();
          }
          if (!stillRunning()) return;
          // 优先尝试超星特定跳转，失败则回退到通用点击
          if (!(await tryChaoxingNextChapter())) {
            openNextChapterIfAvailableDeep(allTasksCompleted ? 'all-tasks-completed' : idleTimeout ? 'idle-timeout' : 'current-media-ended');
          }
          return;
        }
      }

      const statusParts: string[] = [];
      if (videoEntries.length > 0) statusParts.push(`${videoEntries.length} 个视频`);
      if (audioEntries.length > 0) statusParts.push(`${audioEntries.length} 个音频`);
      const readers = findDocumentReaders();
      if (readers.length > 0) statusParts.push(`${readers.length} 个文档`);
      const taskPoints = collectTaskPoints();
      const completedTasks = taskPoints.filter(point => point.completed).length;
      if (taskPoints.length > 0) statusParts.push(`任务点 ${completedTasks}/${taskPoints.length}`);

      sendChapterLearningState(
        statusParts.length > 0
          ? `章节学习运行中：${statusParts.join('，')}`
          : '章节学习运行中，正在等待页面内容加载。'
      );
    } catch (error: any) {
      reportWebviewError('webview:chapter-loop', {
        level: 'warn',
        message: error?.message || '章节学习轮询失败'
      });
    } finally {
      pageAny.__studyPilotChapterTickBusy = false;
      if (pageAny.__studyPilotChapterRunning) {
        pageAny.__studyPilotChapterTimer = window.setTimeout(tick, 2500);
      } else {
        pageAny.__studyPilotChapterTimer = null;
      }
    }
  };
  pageAny.__studyPilotChapterTimer = window.setTimeout(tick, 2500);
}

async function checkIfShouldProceedToNext(extractQuestions: ExtractQuestions): Promise<boolean> {
  await new Promise(resolve => setTimeout(resolve, 1000));

  const dialogState = await handleChapterTestDialogs();
  if (dialogState.found && !dialogState.handled) return false;

  const hasQuestions = extractQuestions().length > 0;
  if (hasQuestions) {
    const pageAny = window as any;
    const options = chapterLearningOptions();
    if (options.autoAnswerQuestions) {
      // 每 2.5s 的 tick 都会走到这里：无去重标志时宿主 resolver 会被反复覆盖，
      // 旧超时定时器把新 resolver 置空并报“等待题目抓取结果超时”
      const currentUrl = window.location.href;
      if (pageAny.__studyPilotAutoAnswerNotifiedUrl !== currentUrl) {
        pageAny.__studyPilotAutoAnswerNotifiedUrl = currentUrl;
        // 通知宿主触发章节测试自动答题流程（抓题+AI解析+填入）
        sendChapterLearningState('检测到章节测试题目，正在通知宿主执行自动答题。');
        ipcRenderer.sendToHost('studypilot:chapter-auto-answer', { url: currentUrl });
      }
      // 等待宿主处理，暂不跳转（宿主答题完成后会通过页面变化或下次轮询继续）
      return false;
    }
    sendChapterLearningState('检测到题目，等待手动答题或启用自动答题。');
    return false;
  }
  // 无题目时清除通知标志，页面切换后可重新触发
  (window as any).__studyPilotAutoAnswerNotifiedUrl = null;

  const readers = findDocumentReaders();
  for (const reader of readers) {
    try {
      const doc = reader.doc;
      const finishButton = doc.querySelector('.finish, .complete, [class*="finish"]') as HTMLElement | null;
      if (finishButton && isVisible(finishButton) && !finishButton.classList.contains('disabled')) {
        finishButton.click();
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch {
      // Ignore
    }
  }

  return true;
}

export async function handleChapterLearningCommand(command: ChapterLearningCommand, extractQuestions: ExtractQuestions) {
  setChapterLearningOptions(command.options);
  const pageAny = window as any;
  if (command.action === 'scan') {
    attachPrimaryChapterVideoWatchers();
    sendChapterLearningState('已扫描当前章节。');
    return;
  }
  if (command.action === 'start') {
    pageAny.__studyPilotChapterRunning = true;
    startChapterLearningLoop(extractQuestions);
    attachPrimaryChapterVideoWatchers();
    await playPrimaryChapterMedia();
    return;
  }
  if (command.action === 'play') {
    pageAny.__studyPilotChapterRunning = true;
    startChapterLearningLoop(extractQuestions);
    attachPrimaryChapterVideoWatchers();
    await playPrimaryChapterMedia();
    return;
  }
  if (command.action === 'pause') {
    pageAny.__studyPilotChapterRunning = false;
    stopChapterLearningLoop();
    for (const { video } of collectChapterVideos()) video.pause();
    for (const { audio } of collectChapterAudios()) audio.pause();
    broadcastChapterFrameCommand('pause', chapterLearningOptions());
    sendChapterLearningState('已暂停当前页面视频和音频。');
    return;
  }
  if (command.action === 'stop') {
    pageAny.__studyPilotChapterRunning = false;
    stopChapterLearningLoop();
    for (const { video } of collectChapterVideos()) video.pause();
    for (const { audio } of collectChapterAudios()) audio.pause();
    broadcastChapterFrameCommand('pause', chapterLearningOptions());
    sendChapterLearningState('已停止章节学习辅助。');
    return;
  }
  if (command.action === 'set-options') {
    for (const { video } of collectChapterVideos()) {
      applyChapterVideoOptions(video);
    }
    for (const { audio } of collectChapterAudios()) {
      applyChapterAudioOptions(audio);
    }
    broadcastChapterFrameCommand('apply-options', chapterLearningOptions());
    sendChapterLearningState('章节学习设置已应用。');
  }
}

export function installChapterFrameMessageHandler() {
  window.addEventListener('message', async (event) => {
    const data = event.data;
    if (!data || data.source !== 'studypilot' || data.type !== 'chapter-frame-command') return;
    setChapterLearningOptions(data.options);
    const options = chapterLearningOptions();
    const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
    const audios = Array.from(document.querySelectorAll('audio')) as HTMLAudioElement[];
    const primaryVideo = selectPrimaryVideo(videos.map((video, index) => ({
      video,
      frame: { window, document, label: 'frame', url: window.location.href, depth: 0 },
      index
    })));
    const primaryAudio = primaryVideo ? undefined : selectPrimaryAudio(audios.map((audio, index) => ({
      audio,
      frame: { window, document, label: 'frame', url: window.location.href, depth: 0 },
      index
    })));

    for (const video of videos) {
      applyChapterVideoOptions(video);
      if (data.action === 'pause') video.pause();
      if (data.action === 'play' && video === primaryVideo?.video && options.autoPlay && Number(options.playbackRate) > 0) {
        try {
          await video.play();
        } catch {
          // Parent polling keeps retrying; some players require one user gesture first.
        }
      }
    }

    for (const audio of audios) {
      applyChapterAudioOptions(audio);
      if (data.action === 'pause') audio.pause();
      if (data.action === 'play' && audio === primaryAudio?.audio && options.autoPlay && Number(options.playbackRate) > 0) {
        try {
          await audio.play();
        } catch {
          // Parent polling keeps retrying; some players require one user gesture first.
        }
      }
    }
  });
}
