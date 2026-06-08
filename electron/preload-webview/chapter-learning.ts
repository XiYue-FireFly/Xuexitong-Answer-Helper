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

function isLikelyChapterAnchor(anchor: HTMLAnchorElement) {
  const text = chapterLinkText(anchor);
  const haystack = `${text} ${anchor.href} ${anchor.className || ''} ${anchor.getAttribute('onclick') || ''}`;
  if (!anchor.href || isBlockedInternalTabUrl(anchor.href)) return false;
  if (/\.(?:png|jpe?g|gif|webp|svg|ico|css|js)(?:[?#]|$)/i.test(anchor.href)) return false;
  return /(章节|任务点|视频|学习|第\s*\d+|chapter|knowledge|course|clazz|mooc|ans|jobid|courseid|clazzid)/i.test(haystack);
}

function collectChapterLinks() {
  const anchors = safeFrameContexts()
    .flatMap((frame) => {
      try {
        return Array.from(frame.document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
      } catch {
        return [];
      }
    });
  const currentUrl = window.location.href.split('#')[0];
  const links = uniqueBy(
    anchors
      .filter((anchor) => isVisible(anchor) && isLikelyChapterAnchor(anchor))
      .map((anchor) => {
        const url = new URL(anchor.href, window.location.href).toString();
        const active = url.split('#')[0] === currentUrl ||
          /(^|\s)(active|current|on|cur|selected)(\s|$)/i.test(String(anchor.className || '')) ||
          Boolean(anchor.closest('.active,.current,.on,.cur,.selected'));
        return {
          title: chapterLinkText(anchor) || url,
          url,
          active
        };
      }),
    (item) => item.url
  ).slice(0, 80);

  let activeChapterIndex = links.findIndex((item) => item.active);
  if (activeChapterIndex < 0) {
    activeChapterIndex = links.findIndex((item) => item.url.split('#')[0] === currentUrl);
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
  for (const { video } of videoEntries) {
    applyChapterVideoOptions(video);
    if (!video.ended && video.paused) {
      try {
        await video.play();
      } catch {
        // Requires user interaction
      }
    }
  }

  const audioEntries = collectChapterAudios();
  for (const { audio } of audioEntries) {
    applyChapterAudioOptions(audio);
    if (!audio.ended && audio.paused) {
      try {
        await audio.play();
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

function openNextChapterIfAvailableDeep(reason: string) {
  const options = chapterLearningOptions();
  const pageAny = window as any;
  if (!options.autoNext || !pageAny.__studyPilotChapterRunning) return false;
  if (pageAny.__studyPilotChapterOpeningNext && Date.now() - pageAny.__studyPilotChapterOpeningNext < 8000) return true;
  const { nextChapter } = collectChapterLinks();
  if (!nextChapter?.url) {
    sendChapterLearningState('当前视频已自然播放结束，但未识别到下一章节。');
    return false;
  }
  pageAny.__studyPilotChapterOpeningNext = Date.now();
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
  const options = chapterLearningOptions();
  const entries = collectChapterVideos();
  broadcastChapterFrameCommand('play', options);
  if (entries.length === 0) {
    sendChapterLearningState('当前页面暂未识别到可控制的视频，已向子页面发送播放指令并继续轮询。');
    return;
  }
  attachChapterVideoWatchersDeep();
  let played = 0;
  for (const { video } of entries) {
    applyChapterVideoOptions(video);
    if (options.autoPlay && Number(options.playbackRate) > 0) {
      try {
        await video.play();
        played += 1;
      } catch (error: any) {
        reportWebviewError('webview:chapter-video-play', {
          level: 'warn',
          message: `视频播放需要页面允许或用户手动点击：${error?.message || 'unknown'}`,
          details: { options }
        });
      }
    }
  }
  const endedCount = entries.filter((entry) => entry.video.ended).length;
  sendChapterLearningState(`已识别 ${entries.length} 个视频，已尝试播放 ${played} 个，已结束 ${endedCount} 个。`);
}

function stopChapterLearningLoop() {
  const pageAny = window as any;
  if (pageAny.__studyPilotChapterTimer) {
    window.clearInterval(pageAny.__studyPilotChapterTimer);
    pageAny.__studyPilotChapterTimer = null;
  }
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

      attachChapterVideoWatchersDeep();
      const videoEntries = collectChapterVideos();
      const audioEntries = collectChapterAudios();

      for (const { video } of videoEntries) applyChapterVideoOptions(video);
      for (const { audio } of audioEntries) applyChapterAudioOptions(audio);
      broadcastChapterFrameCommand('apply-options', options);

      await playAllMediaElements();
      broadcastChapterFrameCommand('play', options);

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

      const allVideosEnded = videoEntries.length > 0 && videoEntries.every((entry) =>
        entry.video.ended ||
        (Number.isFinite(entry.video.duration) && entry.video.duration > 0 && entry.video.currentTime >= entry.video.duration - 0.5)
      );

      const allAudiosEnded = audioEntries.length > 0 && audioEntries.every((entry) =>
        entry.audio.ended ||
        (Number.isFinite(entry.audio.duration) && entry.audio.duration > 0 && entry.audio.currentTime >= entry.audio.duration - 0.5)
      );

      const allTasksCompleted = isAllTaskPointsCompleted();

      if ((allVideosEnded && allAudiosEnded) || allTasksCompleted) {
        const shouldProceed = await checkIfShouldProceedToNext(extractQuestions);
        if (shouldProceed) {
          openNextChapterIfAvailableDeep(allTasksCompleted ? 'all-tasks-completed' : 'all-media-ended');
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
    attachChapterVideoWatchersDeep();
    sendChapterLearningState('已扫描当前章节。');
    return;
  }
  if (command.action === 'start') {
    pageAny.__studyPilotChapterRunning = true;
    startChapterLearningLoop(extractQuestions);
    await playChapterVideosDeep();
    return;
  }
  if (command.action === 'play') {
    pageAny.__studyPilotChapterRunning = true;
    startChapterLearningLoop(extractQuestions);
    await playChapterVideosDeep();
    return;
  }
  if (command.action === 'pause') {
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

    for (const video of videos) {
      applyChapterVideoOptions(video);
      if (data.action === 'pause') video.pause();
      if (data.action === 'play' && options.autoPlay && Number(options.playbackRate) > 0) {
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
      if (data.action === 'play' && options.autoPlay && Number(options.playbackRate) > 0) {
        try {
          await audio.play();
        } catch {
          // Parent polling keeps retrying; some players require one user gesture first.
        }
      }
    }
  });
}
