// 超星章节 API 直连层：通过 page-bridge 在页面上下文内调用 unsafeWindow.ServerHost + fetch，
// 复刻 2.txt(超星小助手) 的 mainTask 链路：章节树→遍历→getChapterDetail(mArg)→按 attachment.type 分发。
// preload 隔离世界访问不到 ServerHost/uid/md5，全部经 callPageHook 代理。

import { callPageHook } from './page-bridge';
import { reportWebviewError } from './bridge';

export interface CxChapterNode {
  id: string;
  name: string;
  label?: string;
  indexOrder?: number;
  parentnodeid?: string;
  layer?: number;
  status?: string;
  jobcount?: number;
  begintime?: string;
  endtime?: string;
}

export interface CxAttachment {
  type?: string;
  property?: Record<string, any>;
  objectId?: string;
  jobid?: string;
  jtoken?: string;
  otherInfo?: string;
  enc?: string;
}

export interface CxTaskDefaultConfig {
  ktoken?: string;
  cpi?: string;
  clazzId?: string;
  courseid?: string;
  reportUrl?: string;
  initdataUrl?: string;
  [key: string]: any;
}

export interface CxChapterRuntimeParams {
  courseid: string;
  clazzid: string;
  cpi: string;
  userid: string;
}

function safeJsonParse(text: unknown): any {
  try {
    return JSON.parse(String(text || ''));
  } catch {
    return null;
  }
}

async function bridgeText(action: any, timeoutMs = 12000): Promise<string | null> {
  const res = await callPageHook(action, timeoutMs);
  if (!res || !res.ok) return null;
  return typeof res.data === 'string' ? res.data : String(res.data ?? '');
}

async function bridgeJson<T = any>(action: any, timeoutMs = 12000): Promise<T | null> {
  const text = await bridgeText(action, timeoutMs);
  if (text == null) return null;
  const parsed = safeJsonParse(text);
  return parsed as T;
}

/** 拉取课程章节树（含 knowledge 列表与 jobcount） */
export async function getCourseChapter(courseId: string, clazzId: string) {
  return bridgeJson<any>({ kind: 'cxGetCourseChapter', courseId, clazzId });
}

/** 批量查询节点未完成数 */
export async function getChapterList(params: CxChapterRuntimeParams, nodes: string) {
  return bridgeJson<any>({
    kind: 'cxGetChapterList',
    courseid: params.courseid, clazzid: params.clazzid,
    nodes, userid: params.userid, cpi: params.cpi
  });
}

/** 单章节卡片信息（card 列表） */
export async function getChapterInfo(id: string, courseid: string) {
  return bridgeJson<any>({ kind: 'cxGetChapterInfo', id, courseid });
}

/** 章节详情 HTML（含 mArg = {...}; 任务点 JSON） */
export async function getChapterDetail(courseid: string, clazzid: string, knowledgeid: string, num: string, cpi: string) {
  return bridgeText({ kind: 'cxGetChapterDetail', courseid, clazzid, knowledgeid, num, cpi });
}

/** 上传学习记录（encode 二段式） */
export async function uploadStudyLog(courseid: string, clazzid: string, knowledgeid: string, cpi: string) {
  return bridgeText({ kind: 'cxUploadStudyLog', courseid, clazzid, knowledgeid, cpi });
}

/** 文档阅读上报 */
export async function docStudy(jobid: string, knowledgeid: string, courseid: string, clazzid: string, jtoken: string) {
  return bridgeJson<any>({ kind: 'cxDocStudy', jobid, knowledgeid, courseid, clazzid, jtoken });
}

/** 视频进度上报（/multimedia/log） */
export async function videoStudy(reportUrl: string, dtoken: string, data: Record<string, unknown>) {
  return bridgeJson<any>({ kind: 'cxVideoStudy', reportUrl, dtoken, data });
}

/** 视频/音频配置（dtoken/duration/objectid） */
export async function getVideoConfig(objectId: string) {
  return bridgeJson<any>({ kind: 'cxGetVideoConfig', objectId });
}

/** 闯关解锁章节 */
export async function unlockChapter(courseid: string, clazzid: string, knowledgeid: string, userid: string, cpi: string) {
  return bridgeText({ kind: 'cxUnlockChapter', courseid, clazzid, knowledgeid, userid, cpi });
}

/** 计算 video enc（md5 加密串），超星靠此校验进度上报 */
export async function getVideoEnc(clazzid: string, uid: string, jobid: string, objectId: string, playingTime: number, duration: number) {
  const res = await callPageHook({ kind: 'cxGetEnc', clazzid, uid, jobid, objectId, playingTime, duration }, 3000);
  if (!res || !res.ok || typeof res.data !== 'string') return '';
  return res.data;
}

/** 拉取字体反爬映射表 JSON */
export async function readTtfList(urls: string[]): Promise<Record<string, string> | null> {
  const res = await callPageHook({ kind: 'cxReadTtfList', urls }, 10000);
  if (!res || !res.ok) return null;
  return safeJsonParse(res.data);
}

/** 把扁平节点数组组织成树，复刻 2.txt utils.sortData */
export function sortChapterData(data: CxChapterNode[]): CxChapterNode[] {
  const arr: CxChapterNode[] = [];
  for (const item of data) {
    const parent = data.find((p) => p.id === item.parentnodeid);
    if (parent) {
      (parent as any).children = (parent as any).children || [];
      (parent as any).children.push(item);
    } else {
      arr.push(item);
    }
  }
  return arr;
}

/** 树→一维数组，复刻 2.txt utils.toOneArray */
export function flattenChapterData(arr: CxChapterNode[]): CxChapterNode[] {
  return arr.reduce<CxChapterNode[]>((acc, item) => {
    const children = (item as any).children as CxChapterNode[] | undefined;
    return acc.concat(item, children ? flattenChapterData(children) : []);
  }, []);
}

/** 从 chapterDetail HTML 中正则提取 mArg JSON，复刻 2.txt mainTask 的 regex */
export function extractMArg(chapterDetail: string): { defaults: CxTaskDefaultConfig; attachments: CxAttachment[] } | null {
  const match = /mArg\s*=\s*({[\s\S]*?});/.exec(chapterDetail || '');
  if (!match) return null;
  try {
    const mArg = JSON.parse(match[1]);
    return { defaults: mArg.defaults || {}, attachments: Array.isArray(mArg.attachments) ? mArg.attachments : [] };
  } catch {
    return null;
  }
}

export function chapterNotOpened(chapterDetail: string): boolean {
  return String(chapterDetail || '').indexOf('章节未开放') !== -1;
}

export interface CxMainTaskCallbacks {
  sleep: (ms: number) => Promise<void>;
  onLog: (msg: string, level?: 'info' | 'success' | 'error' | 'notice') => void;
  onStatus: (msg: string) => void;
  onVideoProgress?: (current: number, duration: number) => void;
  /** 宿主层抓题+AI+填入；返回 true 表示已处理（可继续翻章），false 表示需等待 */
  onChapterTest?: () => Promise<boolean>;
  isRunning: () => boolean;
}

/**
 * 复刻 2.txt mainTask 的核心循环：遍历章节树，逐章节 getChapterDetail → mArg → finishTask。
 * options：reviewMode 复习模式(已完成也重刷)、unlockMode 闯关解锁、autoVideo/autoRead/autoAnswer。
 */
export async function runChaoxingMainTask(
  params: CxChapterRuntimeParams,
  options: { reviewMode?: boolean; unlockMode?: boolean; autoVideo?: boolean; autoRead?: boolean; autoAnswer?: boolean; videoSpeed?: number; interval?: number },
  cb: CxMainTaskCallbacks
): Promise<boolean> {
  const interval = options.interval ?? 3000;
  const videoSpeed = options.videoSpeed ?? 1;

  cb.onStatus('正在获取课程章节树...');
  const data = await getCourseChapter(params.courseid, params.clazzid);
  if (!data || !data.data || !data.data[0]) {
    cb.onLog('获取课程章节失败，回退到 DOM 模式', 'error');
    return false;
  }
  const courseData = data.data[0].course?.data?.[0];
  if (!courseData) {
    cb.onLog('解析课程数据失败，回退到 DOM 模式', 'error');
    return false;
  }
  const chapterData = flattenChapterData(sortChapterData(courseData.knowledge?.data || []));
  const statusTask = chapterData.some((item) => item.status === 'task');
  if (statusTask) cb.onLog('检测到闯关模式课程', 'info');
  if (options.reviewMode) cb.onLog('复习模式：将重刷已完成章节', 'info');

  const chapterIds = chapterData.map((item) => item.id).join(',');
  const chapterInfo = await getChapterList(params, chapterIds);
  const unfinishcount = chapterInfo
    ? Object.values(chapterInfo).reduce((total: number, cur: any) => total + (Number(cur?.unfinishcount) || 0), 0)
    : 0;
  cb.onLog(`[${courseData.name || ''}] 获取到 ${chapterData.length} 个章节，待完成 ${unfinishcount} 个任务`, 'info');

  let lastItem: CxChapterNode | null = null;
  let unlockChapterNum = 0;

  const doTask = async (item: CxChapterNode): Promise<false | null | 'unlock'> => {
    if (!cb.isRunning()) return false;
    // 闯关模式：jobcount==0 先解锁
    if (statusTask && item.jobcount === 0 && options.unlockMode) {
      await unlockChapter(params.courseid, params.clazzid, item.id, params.userid, params.cpi);
      await cb.sleep(1000);
    }
    if (unfinishcount === 0 && !options.reviewMode) return false;

    cb.onLog(`开始完成章节 [${item.label || ''}${item.name || ''}]`, 'info');
    // 未完成数为 0 且非复习 → 跳过
    const nodeInfo = (chapterInfo as any)?.[item.id];
    if (nodeInfo && Number(nodeInfo.unfinishcount) === 0 && !options.reviewMode) {
      cb.onLog('已完成章节，跳过', 'success');
      return null;
    }

    await uploadStudyLog(params.courseid, params.clazzid, item.id, params.cpi);
    const chapterOne = await getChapterInfo(item.id, params.courseid);
    if (!chapterOne || !chapterOne.data || !chapterOne.data[0]?.card?.data) {
      cb.onLog(`章节 ${item.name} 无卡片数据，跳过`, 'error');
      return null;
    }

    for (const card of chapterOne.data[0].card.data) {
      if (!cb.isRunning()) return false;
      const detail = await getChapterDetail(params.courseid, params.clazzid, card.knowledgeid, String(card.cardorder), params.cpi);
      if (!detail) continue;
      if (chapterNotOpened(detail)) return 'unlock';

      const mArg = extractMArg(detail);
      if (!mArg) {
        cb.onLog(`章节 ${item.name} 未提取到任务点(mArg)，可能纯图文`, 'info');
        await cb.sleep(interval);
        continue;
      }

      for (const task of mArg.attachments) {
        if (!cb.isRunning()) return false;
        if (!task.type) continue;
        await finishAttachment(task, card, params, mArg.defaults, options, cb, videoSpeed);
        await cb.sleep(interval);
      }
      await cb.sleep(interval);
    }
    await cb.sleep(interval);
    return null;
  };

  for (const item of chapterData) {
    if (!cb.isRunning()) break;
    const back = await doTask(item);
    if (unlockChapterNum > 0) {
      cb.onLog('章节未开放（一般作业正确率不够），已暂停', 'error');
      return true;
    }
    if (back === 'unlock' && lastItem && options.unlockMode) {
      await unlockChapter(params.courseid, params.clazzid, lastItem.id, params.userid, params.cpi);
      unlockChapterNum += 1;
    }
    if (back === false) break;
    lastItem = item;
  }
  if (cb.isRunning()) {
    cb.onStatus('章节任务已全部完成');
    cb.onLog('章节全部完成', 'success');
  }
  return true;
}

/** 单个 attachment（任务点）完成逻辑，复刻 2.txt finishTask */
async function finishAttachment(
  task: CxAttachment,
  card: any,
  params: CxChapterRuntimeParams,
  taskDefaultConfig: CxTaskDefaultConfig,
  options: { autoVideo?: boolean; autoRead?: boolean; autoAnswer?: boolean; reviewMode?: boolean },
  cb: CxMainTaskCallbacks,
  videoSpeed: number
) {
  const name = task.property?.name || task.property?.title || '任务点';
  switch (task.type) {
    case 'video': {
      if (!options.autoVideo) {
        cb.onLog(`[${name}] 视频已跳过(设置未开启)`, 'error');
        return;
      }
      const videoData = await getVideoConfig(task.objectId || '');
      if (!videoData) {
        cb.onLog(`[${name}] 视频配置获取失败，跳过`, 'error');
        return;
      }
      cb.onLog(`[${name}] 视频开始上报进度`, 'info');
      await reportVideoProgress(task, videoData, params, taskDefaultConfig, videoSpeed, Boolean(options.reviewMode), cb);
      cb.onLog(`[${name}] 视频已完成`, 'success');
      break;
    }
    case 'document': {
      if (!options.autoRead) {
        cb.onLog(`[${name}] 文档已跳过(设置未开启)`, 'error');
        return;
      }
      const result = await docStudy(task.property?.jobid, card.knowledgeid, params.courseid, params.clazzid, task.jtoken || '');
      if (result && (result as any).status) cb.onLog(`[${name}] 文档已完成`, 'success');
      else cb.onLog(`[${name}] 文档异常(可忽略)`, 'error');
      break;
    }
    case 'workid': {
      if (!options.autoAnswer) {
        cb.onLog(`[${name}] 作业已跳过(设置未开启)`, 'error');
        return;
      }
      if (cb.onChapterTest) {
        cb.onLog(`[${name}] 检测到章节测试，通知宿主答题`, 'info');
        await cb.onChapterTest();
      }
      break;
    }
    default:
      cb.onLog(`暂不支持的任务类型: ${task.type}`, 'error');
  }
}

/**
 * 视频进度上报，复刻 2.txt finishVideo：每 60s 上报一次 /multimedia/log，
 * enc = getVideoEnc(...) md5，直到 playingTime >= duration 或 isPassed。
 */
async function reportVideoProgress(
  task: CxAttachment,
  videoData: any,
  params: CxChapterRuntimeParams,
  taskDefaultConfig: CxTaskDefaultConfig,
  videoSpeed: number,
  reviewMode: boolean,
  cb: CxMainTaskCallbacks
) {
  const duration = Number(videoData.duration) || 0;
  const objectId = videoData.objectid || task.objectId || '';
  const reportUrl = taskDefaultConfig.reportUrl || '';
  const dtoken = videoData.dtoken || '';
  // videoSpeed=0 会导致 time 永不增长（死循环）与 waitTime 除零；上层虽兜底为 1，此处再防御
  const safeSpeed = videoSpeed > 0 ? videoSpeed : 1;
  if (!duration || !reportUrl || !dtoken) {
    cb.onLog('视频缺少 duration/reportUrl/dtoken，无法上报', 'error');
    return;
  }

  const jobid = task.property?.jobid || task.property?._jobid || '';
  let time = 0;
  const intervalTime = 60000;
  const isRunning = cb.isRunning;

  while (isRunning()) {
    const isdrag = time < duration ? 3 : 4;
    const playingTime = time >= duration ? duration : time;
    const enc = await getVideoEnc(params.clazzid, params.userid, String(jobid), objectId, playingTime, duration);
    if (!enc) {
      // 无 md5（非超星页面或 md5 未就绪）→ 无法生成合法 enc，继续上报只会被拒，直接结束
      cb.onLog('无法生成视频 enc（页面缺少 md5），跳过该视频上报', 'error');
      return;
    }
    const data: Record<string, unknown> = {
      clazzId: params.clazzid,
      playingTime: String(playingTime),
      duration,
      clipTime: '0_' + duration,
      objectId,
      otherInfo: String(task.otherInfo || '').replace(/&cour.*$/, ''),
      courseId: params.courseid,
      jobid,
      userid: params.userid,
      isdrag: String(isdrag),
      view: 'pc',
      enc,
      rt: task.property?.rt || '0.9',
      dtype: String(task.property?.module || '').includes('audio') ? 'Audio' : 'Video',
      _t: Date.now()
    };
    cb.onStatus(`视频进度: ${playingTime}/${duration}s 每60秒上报`);
    cb.onVideoProgress?.(playingTime, duration);

    const result = await videoStudy(reportUrl, dtoken, data);
    if (time >= duration || (result && (result as any).isPassed === true && !reviewMode)) {
      break;
    }
    time += 60 * safeSpeed;
    if (time > duration) {
      const waitTime = (60 * safeSpeed - (time - duration)) / safeSpeed;
      cb.onLog(`等待 ${Math.round(waitTime)} 秒后完成`, 'info');
      await cb.sleep(waitTime * 1000);
    } else {
      await cb.sleep(intervalTime);
    }
  }
}
