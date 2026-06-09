import { ipcRenderer } from 'electron';
import type { ChapterLearningCommand, ChapterLearningOptions, TaskPoint } from './types';
import { reportWebviewError } from './bridge';
import { cleanText, isVisible, uniqueBy } from './dom-utils';

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

function chapterLearningOptions(): Required<ChapterLearningOptions> {
  const pageAny = window as any;
  return {
    autoNext: pageAny.__studyPilotChapterOptions?.autoNext ?? true,
    autoPlay: pageAny.__studyPilotChapterOptions?.autoPlay ?? true,
    muted: pageAny.__studyPilotChapterOptions?.muted ?? false,
    playbackRate: pageAny.__studyPilotChapterOptions?.playbackRate ?? 1,
    autoReadDocument: pageAny.__studyPilotChapterOptions?.autoReadDocument ?? true,
    autoAnswerQuestions: pageAny.__studyPilotChapterOptions?.autoAnswerQuestions ?? false
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
  const previous = (window as any).__studyPilotChapterPrimaryVideo as HTMLVideoElement | undefined;
  const previousEntry = previous ? entries.find((entry) => entry.video === previous) : undefined;
  if (previousEntry && isUsablePrimaryMedia(previousEntry.video)) return previousEntry;

  const visibleEntries = entries.filter((entry) => isUsablePrimaryMedia(entry.video));
  return sortMediaEntries(visibleEntries.filter((entry) => !isMediaEnded(entry.video)))[0] ||
    sortMediaEntries(visibleEntries)[0] ||
    sortMediaEntries(entries.filter((entry) => !isMediaEnded(entry.video)))[0] ||
    sortMediaEntries(entries)[0];
}

function selectPrimaryAudio(entries = collectChapterAudios()) {
  const previous = (window as any).__studyPilotChapterPrimaryAudio as HTMLAudioElement | undefined;
  const previousEntry = previous ? entries.find((entry) => entry.audio === previous) : undefined;
  if (previousEntry && isUsablePrimaryMedia(previousEntry.audio)) return previousEntry;

  const visibleEntries = entries.filter((entry) => isUsablePrimaryMedia(entry.audio));
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
      url.searchParams.get('knowledgeid');
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

function isLikelyChapterAnchor(anchor: HTMLAnchorElement) {
  const text = chapterLinkText(anchor);
  const haystack = `${text} ${anchor.href} ${anchor.className || ''} ${anchor.getAttribute('onclick') || ''}`;
  if (!anchor.href || isBlockedInternalTabUrl(anchor.href)) return false;
  if (/\.(?:png|jpe?g|gif|webp|svg|ico|css|js)(?:[?#]|$)/i.test(anchor.href)) return false;
  return /(章节|任务点|视频|学习|第\s*\d+|chapter|knowledge|course|clazz|mooc|ans|jobid|courseid|clazzid)/i.test(haystack);
}

function collectChapterLinks() {
  chapterLinkElements.clear();
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
          '.chapter',
          '.chapterItem',
          '.catalog_item',
          '.knowledge'
        ].join(','))) as HTMLElement[];
      } catch {
        return [];
      }
    });
  const currentUrl = comparableChapterUrl(window.location.href);
  const currentIdentity = chapterIdentity(window.location.href);
  const links = uniqueBy(
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
        chapterLinkElements.set(url, element);
        chapterLinkElements.set(comparableChapterUrl(url), element);
        chapterLinkElements.set(chapterIdentity(url), element);
        return {
          title: text || url,
          url,
          active
        };
      })
      .filter((item): item is { title: string; url: string; active: boolean } => Boolean(item)),
    (item) => item.url
  ).slice(0, 80);

  let activeChapterIndex = links.findIndex((item) => item.active);
  if (activeChapterIndex < 0) {
    activeChapterIndex = links.findIndex((item) => comparableChapterUrl(item.url) === currentUrl || chapterIdentity(item.url) === currentIdentity);
  }
  const nextChapter = activeChapterIndex >= 0 ? links[activeChapterIndex + 1] : links[0];
  return { links, activeChapterIndex, nextChapter };
}

function collectTaskPoints(): TaskPoint[] {
  const taskPoints: TaskPoint[] = [];

  for (const frame of safeFrameContexts()) {
    try {
      const doc = frame.document;

      const jobElements = Array.from(doc.querySelectorAll('.jobItem, .job, [id^="job"], .jobTodo, .jobFinish')) as HTMLElement[];
      for (const element of jobElements) {
        const classText = element.className || '';
        const completed = /finish|done|complete|已完成/i.test(classText);
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

          if (iframeDoc.querySelector('.reader, .document-reader, #reader')) {
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

function findDocumentReaders(): Array<{ iframe: HTMLIFrameElement; doc: Document; title: string }> {
  const readers: Array<{ iframe: HTMLIFrameElement; doc: Document; title: string }> = [];

  for (const frame of safeFrameContexts()) {
    try {
      const iframes = Array.from(frame.document.querySelectorAll('iframe')) as HTMLIFrameElement[];
      for (const iframe of iframes) {
        try {
          const doc = iframe.contentDocument;
          if (!doc) continue;

          const hasReader = doc.querySelector('.reader, .document-reader, #reader, .ppt-reader, .pdf-reader');
          const hasPages = doc.querySelector('.page, .pageItem, [class*="page"]');

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

async function autoReadDocument(reader: { iframe: HTMLIFrameElement; doc: Document; title: string }) {
  const doc = reader.doc;

  const nextButton = doc.querySelector('.next, .nextPage, [class*="next"], [onclick*="next"]') as HTMLElement | null;
  if (nextButton && isVisible(nextButton)) {
    nextButton.click();
    await new Promise(resolve => setTimeout(resolve, 800));
    return { success: true, action: 'next-page' };
  }

  const finishButton = doc.querySelector('.finish, .complete, [class*="finish"], [onclick*="finish"]') as HTMLElement | null;
  if (finishButton && isVisible(finishButton)) {
    finishButton.click();
    await new Promise(resolve => setTimeout(resolve, 500));
    return { success: true, action: 'finish' };
  }

  const scrollContainer = doc.querySelector('.reader, .document-reader, #reader') as HTMLElement | null;
  if (scrollContainer) {
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
    await new Promise(resolve => setTimeout(resolve, 500));
    return { success: true, action: 'scroll' };
  }

  return { success: false, action: 'none' };
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

async function playAllMediaElements() {
  const options = chapterLearningOptions();
  if (!options.autoPlay || Number(options.playbackRate) <= 0) return;

  const videoEntries = collectChapterVideos();
  const audioEntries = collectChapterAudios();
  const primaryVideo = selectPrimaryVideo(videoEntries);
  const primaryAudio = primaryVideo ? undefined : selectPrimaryAudio(audioEntries);
  rememberPrimaryMedia(primaryVideo, primaryAudio);
  pauseNonPrimaryMedia(primaryVideo, primaryAudio);

  if (primaryVideo) {
    applyChapterVideoOptions(primaryVideo.video);
    if (!isMediaEnded(primaryVideo.video) && primaryVideo.video.paused) {
      try {
        await primaryVideo.video.play();
      } catch {
        // Requires user interaction
      }
    }
    return;
  }

  if (primaryAudio) {
    applyChapterAudioOptions(primaryAudio.audio);
    if (!isMediaEnded(primaryAudio.audio) && primaryAudio.audio.paused) {
      try {
        await primaryAudio.audio.play();
      } catch {
        // Requires user interaction
      }
    }
  }
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

function openNextChapterIfAvailable(reason: string) {
  const options = chapterLearningOptions();
  if (!options.autoNext || !(window as any).__studyPilotChapterRunning) return false;
  const { nextChapter } = collectChapterLinks();
  if (!nextChapter?.url) {
    sendChapterLearningState('当前视频已自然播放结束，但未识别到下一章节。');
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

function attachChapterVideoWatchers() {
  const pageAny = window as any;
  if (!pageAny.__studyPilotChapterWatchedVideos) pageAny.__studyPilotChapterWatchedVideos = new WeakSet();
  const watched = pageAny.__studyPilotChapterWatchedVideos as WeakSet<HTMLVideoElement>;
  for (const video of Array.from(document.querySelectorAll('video')) as HTMLVideoElement[]) {
    if (watched.has(video)) continue;
    watched.add(video);
    video.addEventListener('ended', () => {
      if (!pageAny.__studyPilotChapterRunning) return;
      openNextChapterIfAvailable('video-ended');
    });
    video.addEventListener('play', () => sendChapterLearningState('视频正在播放。'));
    video.addEventListener('pause', () => {
      if (!video.ended) sendChapterLearningState('视频已暂停。');
    });
  }
}

async function playChapterVideos() {
  const options = chapterLearningOptions();
  const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
  if (videos.length === 0) {
    sendChapterLearningState('当前页面未识别到 video 元素。');
    return;
  }
  attachChapterVideoWatchers();
  for (const video of videos) {
    applyChapterVideoOptions(video);
    if (options.autoPlay && Number(options.playbackRate) > 0) {
      try {
        await video.play();
      } catch (error: any) {
        reportWebviewError('webview:chapter-video-play', {
          level: 'warn',
          message: `视频播放需要页面允许或用户手动点击：${error?.message || 'unknown'}`,
          details: { options }
        });
      }
    }
  }
  sendChapterLearningState(`已处理 ${videos.length} 个视频。`);
}

function attachChapterVideoWatchersDeep() {
  const pageAny = window as any;
  if (!pageAny.__studyPilotChapterWatchedVideos) pageAny.__studyPilotChapterWatchedVideos = new WeakSet();
  const watched = pageAny.__studyPilotChapterWatchedVideos as WeakSet<HTMLVideoElement>;
  for (const { video } of collectChapterVideos()) {
    if (watched.has(video)) continue;
    watched.add(video);
    video.addEventListener('ended', () => {
      if (!pageAny.__studyPilotChapterRunning) return;
      openNextChapterIfAvailableDeep('video-ended');
    });
    video.addEventListener('play', () => sendChapterLearningState('视频正在播放。'));
    video.addEventListener('pause', () => {
      if (!video.ended) sendChapterLearningState('视频已暂停。');
    });
  }
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
  ipcRenderer.sendToHost('studypilot:chapter-open-next', {
    url: nextChapter.url,
    title: nextChapter.title,
    reason,
    options
  });
  sendChapterLearningState(`当前视频已自然结束，正在打开下一章节：${nextChapter.title}`);
  return true;
}

async function playChapterVideosDeep() {
  const state = await playPrimaryChapterMedia();
  const endedCount = state.videoEntries.filter((entry) => isMediaEnded(entry.video)).length;
  if (state.videoEntries.length === 0) {
    sendChapterLearningState('\u5f53\u524d\u9875\u9762\u6682\u672a\u8bc6\u522b\u5230\u53ef\u63a7\u5236\u7684\u89c6\u9891\uff0c\u6b63\u5728\u7b49\u5f85\u9875\u9762\u5185\u5bb9\u52a0\u8f7d\u3002');
    return;
  }
  sendChapterLearningState(`\u5df2\u8bc6\u522b ${state.videoEntries.length} \u4e2a\u89c6\u9891\uff0c\u6b63\u5728\u63a7\u5236\u4e3b\u89c6\u9891 ${state.primaryVideo ? state.primaryVideo.index + 1 : 0}\uff0c\u672c\u8f6e\u64ad\u653e ${state.played} \u4e2a\uff0c\u5df2\u7ed3\u675f ${endedCount} \u4e2a\u3002`);
}

function stopChapterLearningLoop() {
  const pageAny = window as any;
  if (pageAny.__studyPilotChapterTimer) {
    window.clearInterval(pageAny.__studyPilotChapterTimer);
    pageAny.__studyPilotChapterTimer = null;
  }
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

function startChapterLearningLoop(extractQuestions: ExtractQuestions) {
  const pageAny = window as any;
  stopChapterLearningLoop();
  pageAny.__studyPilotChapterTimer = window.setInterval(async () => {
    if (!pageAny.__studyPilotChapterRunning) {
      stopChapterLearningLoop();
      return;
    }
    try {
      const options = chapterLearningOptions();

      attachPrimaryChapterVideoWatchers();
      const videoEntries = collectChapterVideos();
      const audioEntries = collectChapterAudios();

      for (const { video } of videoEntries) applyChapterVideoOptions(video);
      for (const { audio } of audioEntries) applyChapterAudioOptions(audio);
      const primaryState = await playPrimaryChapterMedia();

      if (options.autoReadDocument) {
        const readers = findDocumentReaders();
        for (const reader of readers) {
          try {
            const result = await autoReadDocument(reader);
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

      if (currentMediaEnded || allTasksCompleted) {
        const shouldProceed = await checkIfShouldProceedToNext(extractQuestions);
        if (shouldProceed) {
          openNextChapterIfAvailableDeep(allTasksCompleted ? 'all-tasks-completed' : 'current-media-ended');
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
    }
  }, 2500);
}

async function checkIfShouldProceedToNext(extractQuestions: ExtractQuestions): Promise<boolean> {
  await new Promise(resolve => setTimeout(resolve, 1000));

  const hasQuestions = extractQuestions().length > 0;
  if (hasQuestions) {
    const options = chapterLearningOptions();
    if (!options.autoAnswerQuestions) {
      sendChapterLearningState('检测到题目，等待手动答题或启用自动答题。');
      return false;
    }
  }

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
