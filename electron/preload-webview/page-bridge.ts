// 页面上下文桥：preload 运行在隔离世界（contextIsolation=yes），
// 页面自身的全局函数（setBlankAnswer/UE.getEditor/jwplayer/videojs/PCount/swiperNext/finishJob 等）
// 对 preload 不可见，直接 `window.xxx` 调用恒为 undefined（死代码）。
// 本模块把调用转发给注入页面上下文的脚本执行，通过 CustomEvent 双向通信。
//
// 请求体为字符串 JSON，结果统一回传 { requestId, ok, data?, error? }。
// 页面上下文中 unsafeWindow.ServerHost / uid / getCookie 等才是真实对象，
// 跨域子 iframe 里的目标函数通过 BFS eachWindow 定位。

type PageBridgeAction =
  | { kind: 'syncCompletion'; qid: string; value: string }
  | { kind: 'syncJudgement'; qid: string; value: string }
  | { kind: 'syncChoice'; qid: string; values: string[] }
  | { kind: 'applyRateHack'; playbackRate: number }
  | { kind: 'tryNextChapter' }
  | { kind: 'tryUnlockChapter'; courseId: string; chapterId: string; clazzId: string }
  | { kind: 'pptNext' }
  | { kind: 'finishJob' }
  | { kind: 'readGoto'; target: string }
  // ===== 超星章节 API 直连（在页面上下文内调用 unsafeWindow.ServerHost + fetch） =====
  | { kind: 'cxGetCourseChapter'; courseId: string; clazzId: string }
  | { kind: 'cxGetChapterList'; courseid: string; clazzid: string; nodes: string; userid: string; cpi: string }
  | { kind: 'cxGetChapterInfo'; id: string; courseid: string }
  | { kind: 'cxGetChapterDetail'; courseid: string; clazzid: string; knowledgeid: string; num: string; cpi: string }
  | { kind: 'cxUploadStudyLog'; courseid: string; clazzid: string; knowledgeid: string; cpi: string }
  | { kind: 'cxDocStudy'; jobid: string; knowledgeid: string; courseid: string; clazzid: string; jtoken: string }
  | { kind: 'cxVideoStudy'; reportUrl: string; dtoken: string; data: Record<string, unknown> }
  | { kind: 'cxGetVideoConfig'; objectId: string }
  | { kind: 'cxUnlockChapter'; courseid: string; clazzid: string; knowledgeid: string; userid: string; cpi: string }
  | { kind: 'cxGetEnc'; clazzid: string; uid: string; jobid: string; objectId: string; playingTime: number; duration: number }
  | { kind: 'cxReadTtfList'; urls: string[] };

interface PageBridgeResult {
  requestId: string;
  ok: boolean;
  action?: string;
  detail?: string;
  data?: unknown;
  error?: string;
}

let installed = false;
let requestSeq = 0;
const pending = new Map<string, (result: PageBridgeResult) => void>();

const PAGE_BRIDGE_SOURCE = `
(function () {
  if (window.__studyPilotPageBridgeInstalled) return;
  window.__studyPilotPageBridgeInstalled = true;
  function report(requestId, ok, action, detail) {
    window.dispatchEvent(new CustomEvent('studypilot:page-bridge-result', {
      detail: { requestId: requestId, ok: ok, action: action || '', detail: detail || '' }
    }));
  }
  // 目标函数（swiperNext/finishJob/readweb/videojs 等）常定义在文档阅读器 iframe 的
  // window 上而非主窗口；BFS 遍历主窗口 + 同源 iframe window，跨域访问抛错即跳过。
  function eachWindow(fn) {
    var queue = [window];
    var seen = [];
    var guard = 0;
    while (queue.length > 0 && guard < 200) {
      guard++;
      var w = queue.shift();
      if (!w || seen.indexOf(w) >= 0) continue;
      seen.push(w);
      try { fn(w); } catch (e) {}
      try {
        for (var i = 0; i < w.frames.length; i++) {
          try { queue.push(w.frames[i]); } catch (e) {}
        }
      } catch (e) {}
    }
  }
  function findWindowWith(test) {
    var found = null;
    eachWindow(function (w) { if (!found && test(w)) found = w; });
    return found;
  }
  window.addEventListener('studypilot:page-bridge-call', function (event) {
    var payload = event.detail || {};
    var requestId = payload.requestId || '';
    var action = payload.action || {};
    function reportData(ok, data, err) {
      window.dispatchEvent(new CustomEvent('studypilot:page-bridge-result', {
        detail: { requestId: requestId, ok: !!ok, data: data, error: err || '' }
      }));
    }
    try {
      switch (action.kind) {
        case 'syncCompletion': {
          var called = [];
          ['setBlankAnswer', 'setClozeTextAnswer', 'fillBlank'].forEach(function (name) {
            if (typeof window[name] === 'function') {
              try { window[name](action.qid, action.value); called.push(name); } catch (e) {}
            }
          });
          // UEditor 填空同步
          try {
            if (window.UE && typeof window.UE.getEditor === 'function') {
              var editor = window.UE.getEditor('editor' + action.qid) || window.UE.getEditor(action.qid);
              if (editor && typeof editor.setContent === 'function') {
                editor.setContent(action.value);
                called.push('UE');
              }
            }
          } catch (e) {}
          if (typeof window.answerContentChange === 'function') {
            try { window.answerContentChange(); called.push('answerContentChange'); } catch (e) {}
          }
          report(requestId, called.length > 0, 'syncCompletion', called.join(','));
          break;
        }
        case 'syncJudgement': {
          var jCalled = [];
          if (typeof window.loadAnswerSheet === 'function') {
            try { window.loadAnswerSheet(action.qid); jCalled.push('loadAnswerSheet'); } catch (e) {}
          }
          if (typeof window.answerContentChange === 'function') {
            try { window.answerContentChange(); jCalled.push('answerContentChange'); } catch (e) {}
          }
          report(requestId, jCalled.length > 0, 'syncJudgement', jCalled.join(','));
          break;
        }
        case 'syncChoice': {
          var cCalled = [];
          var values = action.values || [];
          if (typeof window.addMultipleChoice === 'function') {
            try { window.addMultipleChoice(action.qid, values.join('')); cCalled.push('addMultipleChoice'); } catch (e) {}
          } else if (typeof window.addChoice === 'function') {
            try {
              values.forEach(function (value) { window.addChoice(action.qid, value); });
              cCalled.push('addChoice');
            } catch (e) {}
          }
          if (typeof window.answerContentChange === 'function') {
            try { window.answerContentChange(); cCalled.push('answerContentChange'); } catch (e) {}
          }
          report(requestId, cCalled.length > 0, 'syncChoice', cCalled.join(','));
          break;
        }
        case 'applyRateHack': {
          var hacked = [];
          try {
            // videojs/Ext 常位于视频 iframe 内，在其实际所在窗口打补丁
            var rateWin = findWindowWith(function (w) {
              return typeof w.videojs !== 'undefined' && typeof w.Ext !== 'undefined';
            });
            if (rateWin && !rateWin.__studyPilotRateHackApplied) {
              var vjs = rateWin.videojs;
              var Ext = rateWin.Ext;
              rateWin.__studyPilotRateHackApplied = true;
              var originPlugin = vjs.getPlugin('seekBarControl');
              if (originPlugin) {
                var dragCount = 0;
                var Plugin = vjs.extend(vjs.getPlugin('plugin'), {
                  constructor: function(videoExt, data) {
                    var _sendLog = data.sendLog;
                    data.sendLog = function() {
                      if (arguments[1] === 'drag') { dragCount++; if (dragCount > 100) { dragCount = 0; var el = rateWin.document.querySelector('video'); if (el) el.pause(); } }
                      else { _sendLog.apply(data, arguments); }
                    };
                    originPlugin.apply(originPlugin.prototype, [videoExt, data]);
                  }
                });
                vjs.registerPlugin('seekBarControl', Plugin);
                Ext.define('ans.VideoJs', {
                  override: 'ans.VideoJs',
                  constructor: function(data) {
                    this.addEvents(['seekstart']);
                    this.mixins.observable.constructor.call(this, data);
                    vjs(data.videojs, this.params2VideoOpt(data.params), function(){});
                    Ext.fly(data.videojs).on('contextmenu', function(e){e.preventDefault();});
                    Ext.fly(data.videojs).on('keydown', function(e){
                      if (e.keyCode === 32 || e.keyCode === 37 || e.keyCode === 39 || e.keyCode === 107) e.preventDefault();
                    });
                  }
                });
                hacked.push('seekBarControl');
              }
            }
            // playbackRate 设置遍历所有框架的 videojs/jwplayer 实例
            if (action.playbackRate > 0) {
              eachWindow(function (w) {
                try {
                  if (w.videojs) {
                    Object.keys(w.videojs.players || {}).forEach(function(key) {
                      try { var p = w.videojs.players[key]; if (p && typeof p.playbackRate === 'function') p.playbackRate(action.playbackRate); } catch(e) {}
                    });
                  }
                  if (w.jwplayer) {
                    try { var jw = w.jwplayer(); if (jw && typeof jw.setPlaybackRate === 'function') jw.setPlaybackRate(action.playbackRate); } catch(e) {}
                  }
                } catch (e) {}
              });
            }
          } catch (e) {}
          report(requestId, hacked.length > 0, 'applyRateHack', hacked.join(','));
          break;
        }
        case 'tryNextChapter': {
          try {
            var curCourseId = document.querySelector('#curCourseId');
            var curChapterId = document.querySelector('#curChapterId');
            var curClazzId = document.querySelector('#curClazzId');
            var count = document.querySelectorAll('#prev_tab .prev_ul li');
            if (curCourseId && curChapterId && curClazzId && window.PCount && typeof window.PCount.next === 'function') {
              window.PCount.next(String(count.length), curChapterId.value, curCourseId.value, curClazzId.value, '');
              report(requestId, true, 'tryNextChapter', 'PCount.next');
            } else {
              report(requestId, false, 'tryNextChapter', 'no-PCount');
            }
          } catch (e) {
            report(requestId, false, 'tryNextChapter', String(e));
          }
          break;
        }
        case 'tryUnlockChapter': {
          var domain = window.ServerHost && window.ServerHost.mooc1Domain;
          if (domain) {
            var url = domain + '/job/submitstudy?node=' + encodeURIComponent(action.chapterId) +
              '&userid=' + encodeURIComponent(window.uid || '') +
              '&clazzid=' + encodeURIComponent(action.clazzId) +
              '&courseid=' + encodeURIComponent(action.courseId) + '&personid=&view=json';
            fetch(url, { credentials: 'include' }).then(function () {
              report(requestId, true, 'tryUnlockChapter', 'fetch');
            }).catch(function (error) {
              report(requestId, false, 'tryUnlockChapter', String(error));
            });
          } else {
            report(requestId, false, 'tryUnlockChapter', 'no-ServerHost');
          }
          break;
        }
        case 'pptNext': {
          var pptWin = findWindowWith(function (w) { return typeof w.swiperNext === 'function'; });
          if (pptWin) {
            try { pptWin.swiperNext(); report(requestId, true, 'pptNext', ''); } catch (e) {
              report(requestId, false, 'pptNext', String(e));
            }
          } else {
            report(requestId, false, 'pptNext', 'no-swiperNext');
          }
          break;
        }
        case 'finishJob': {
          var jobWin = findWindowWith(function (w) { return typeof w.finishJob === 'function'; });
          if (jobWin) {
            try { jobWin.finishJob(); report(requestId, true, 'finishJob', ''); } catch (e) {
              report(requestId, false, 'finishJob', String(e));
            }
          } else {
            report(requestId, false, 'finishJob', 'no-finishJob');
          }
          break;
        }
        case 'readGoto': {
          var readWin = findWindowWith(function (w) { return w.readweb && typeof w.readweb.goto === 'function'; });
          if (readWin) {
            try { readWin.readweb.goto(action.target || 'epage'); report(requestId, true, 'readGoto', ''); } catch (e) {
              report(requestId, false, 'readGoto', String(e));
            }
          } else {
            report(requestId, false, 'readGoto', 'no-readweb');
          }
          break;
        }
        // ===== 超星章节 API：在页面上下文内通过 unsafeWindow.ServerHost + fetch 调用 =====
        case 'cxGetCourseChapter': {
          try {
            var cxWin = findWindowWith(function (w) { return w.ServerHost && w.ServerHost.mooc1Domain; }) || window;
            var mooc1 = cxWin.ServerHost.mooc1Domain;
            var url = mooc1 + '/gas/clazz?id=' + encodeURIComponent(action.clazzId) +
              '&personid=' + encodeURIComponent(action.courseId) +
              '&fields=id,bbsid,classscore,isstart,allowdownload,chatid,name,state,isfiled,visiblescore,begindate,coursesetting.fields(id,courseid,hiddencoursecover,coursefacecheck),course.fields(id,name,infocontent,objectid,app,bulletformat,mappingcourseid,imageurl,teacherfactor,jobcount,knowledge.fields(id,name,indexOrder,parentnodeid,status,layer,label,jobcount,begintime,endtime,attachment.fields(id,type,objectid,extension).type(video)))&view=json';
            fetch(url, { credentials: 'include' })
              .then(function (r) { return r.text(); })
              .then(function (text) { reportData(true, text); })
              .catch(function (e) { reportData(false, null, String(e)); });
          } catch (e) { reportData(false, null, String(e)); }
          break;
        }
        case 'cxGetChapterList': {
          try {
            var clWin = findWindowWith(function (w) { return w.ServerHost && w.ServerHost.mooc1Domain; }) || window;
            var clMooc1 = clWin.ServerHost.mooc1Domain;
            var clBody = new URLSearchParams();
            clBody.set('view', 'json'); clBody.set('nodes', action.nodes); clBody.set('clazzid', action.clazzid);
            clBody.set('userid', action.userid); clBody.set('cpi', action.cpi); clBody.set('courseid', action.courseid);
            clBody.set('time', String(Date.now()));
            fetch(clMooc1 + '/job/myjobsnodesmap', {
              method: 'POST', credentials: 'include',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: clBody.toString()
            }).then(function (r) { return r.text(); })
              .then(function (text) { reportData(true, text); })
              .catch(function (e) { reportData(false, null, String(e)); });
          } catch (e) { reportData(false, null, String(e)); }
          break;
        }
        case 'cxGetChapterInfo': {
          try {
            var ciWin = findWindowWith(function (w) { return w.ServerHost && w.ServerHost.mooc1Domain; }) || window;
            var ciMooc1 = ciWin.ServerHost.mooc1Domain;
            var ciParams = new URLSearchParams();
            ciParams.set('id', action.id); ciParams.set('courseid', action.courseid);
            ciParams.set('fields', 'id,parentnodeid,indexorder,label,layer,name,begintime,createtime,lastmodifytime,status,jobUnfinishedCount,clickcount,openlock,card.fields(id,knowledgeid,title,knowledgeTitile,description,cardorder).contentcard(all)');
            ciParams.set('view', 'json');
            fetch(ciMooc1 + '/gas/knowledge?' + ciParams.toString(), { credentials: 'include' })
              .then(function (r) { return r.text(); })
              .then(function (text) { reportData(true, text); })
              .catch(function (e) { reportData(false, null, String(e)); });
          } catch (e) { reportData(false, null, String(e)); }
          break;
        }
        case 'cxGetChapterDetail': {
          try {
            var cdWin = findWindowWith(function (w) { return w.ServerHost && w.ServerHost.mooc1Domain; }) || window;
            var cdMooc1 = cdWin.ServerHost.mooc1Domain;
            var cdUrl = cdMooc1 + '/knowledge/cards?clazzid=' + encodeURIComponent(action.clazzid) +
              '&courseid=' + encodeURIComponent(action.courseid) +
              '&knowledgeid=' + encodeURIComponent(action.knowledgeid) +
              '&num=' + encodeURIComponent(action.num) +
              '&cpi=' + encodeURIComponent(action.cpi) +
              '&ut=s&v=20160407-1';
            fetch(cdUrl, { credentials: 'include' })
              .then(function (r) { return r.text(); })
              .then(function (text) { reportData(true, text); })
              .catch(function (e) { reportData(false, null, String(e)); });
          } catch (e) { reportData(false, null, String(e)); }
          break;
        }
        case 'cxUploadStudyLog': {
          try {
            var ulWin = window;
            var ulUrl = location.origin + '/mooc2-ans/mycourse/studentcourse?courseid=' + encodeURIComponent(action.courseid) +
              '&clazzid=' + encodeURIComponent(action.clazzid) + '&cpi=' + encodeURIComponent(action.cpi) + '&ut=s&t=' + Date.now();
            fetch(ulUrl, { credentials: 'include' })
              .then(function (r) { return r.text(); })
              .then(function (text) {
                var m = text.match(/encode=([\w]+)/);
                if (!m) { reportData(false, null, 'no-encode'); return; }
                var encode = m[1];
                var tjDomain = (ulWin.ServerHost && ulWin.ServerHost.moocTJDomain) || 'https://stat2-ans.chaoxing.com';
                var setUrl = tjDomain + '/log/setlog?personid=' + encodeURIComponent(action.cpi) +
                  '&courseId=' + encodeURIComponent(action.courseid) + '&classId=' + encodeURIComponent(action.clazzid) +
                  '&encode=' + encodeURIComponent(encode) + '&chapterId=' + encodeURIComponent(action.knowledgeid) + '&_=' + Date.now();
                fetch(setUrl, { credentials: 'include' })
                  .then(function (r2) { return r2.text(); })
                  .then(function (t2) { reportData(true, t2); })
                  .catch(function (e) { reportData(false, null, String(e)); });
              })
              .catch(function (e) { reportData(false, null, String(e)); });
          } catch (e) { reportData(false, null, String(e)); }
          break;
        }
        case 'cxDocStudy': {
          try {
            var dsWin = findWindowWith(function (w) { return w.ServerHost && w.ServerHost.mooc1Domain; }) || window;
            var dsMooc1 = dsWin.ServerHost.mooc1Domain;
            var dsUrl = dsMooc1 + '/ananas/job/document?jobid=' + encodeURIComponent(action.jobid) +
              '&knowledgeid=' + encodeURIComponent(action.knowledgeid) +
              '&courseid=' + encodeURIComponent(action.courseid) +
              '&clazzid=' + encodeURIComponent(action.clazzid) +
              '&jtoken=' + encodeURIComponent(action.jtoken) + '&_dc=' + Date.now();
            fetch(dsUrl, { credentials: 'include' })
              .then(function (r) { return r.text(); })
              .then(function (text) { reportData(true, text); })
              .catch(function (e) { reportData(false, null, String(e)); });
          } catch (e) { reportData(false, null, String(e)); }
          break;
        }
        case 'cxVideoStudy': {
          try {
            // reportUrl 来自页面 mArg.defaults，防御性校验：必须是已知超星域或 path 为视频上报端点，
            // 避免被篡改后带 cookie 请求恶意域(SSRF/凭证泄漏)
            var vsParsed = new URL(action.reportUrl, location.href);
            var vsHostOk = /\.chaoxing\.com$|\.xuexi365\.com$|\.mooc1\.|\.mooc2\.|gdhkmooc|hnsyu|hlju\.edu/i.test(vsParsed.hostname);
            var vsPathOk = /\/multimedia\/log/i.test(vsParsed.pathname);
            if (!vsHostOk && !vsPathOk) {
              reportData(false, null, 'reportUrl-not-chaoxing');
              break;
            }
            var vsUrl = vsParsed.origin + vsParsed.pathname + '/' + encodeURIComponent(action.dtoken) + '?' + new URLSearchParams(action.data).toString();
            fetch(vsUrl, { credentials: 'include' })
              .then(function (r) { return r.text(); })
              .then(function (text) { reportData(true, text); })
              .catch(function (e) { reportData(false, null, String(e)); });
          } catch (e) { reportData(false, null, String(e)); }
          break;
        }
        case 'cxGetVideoConfig': {
          try {
            var vcWin = findWindowWith(function (w) { return w.ServerHost && w.ServerHost.mooc1Domain; }) || window;
            var vcMooc1 = vcWin.ServerHost.mooc1Domain;
            var vcUrl = vcMooc1 + '/ananas/status/' + encodeURIComponent(action.objectId) + '?k=&flag=normal&_dc=' + Date.now();
            fetch(vcUrl, { credentials: 'include' })
              .then(function (r) { return r.text(); })
              .then(function (text) { reportData(true, text); })
              .catch(function (e) { reportData(false, null, String(e)); });
          } catch (e) { reportData(false, null, String(e)); }
          break;
        }
        case 'cxUnlockChapter': {
          try {
            var ucWin = findWindowWith(function (w) { return w.ServerHost && w.ServerHost.mooc1Domain; }) || window;
            var ucMooc1 = ucWin.ServerHost.mooc1Domain;
            var ucUid = ucWin.uid || (ucWin.getCookie && ucWin.getCookie('UID')) || (ucWin.getCookie && ucWin.getCookie('_uid')) || '';
            var ucUrl = ucMooc1 + '/job/submitstudy?node=' + encodeURIComponent(action.knowledgeid) +
              '&userid=' + encodeURIComponent(ucUid || action.userid) +
              '&clazzid=' + encodeURIComponent(action.clazzid) +
              '&courseid=' + encodeURIComponent(action.courseid) +
              '&personid=' + encodeURIComponent(action.cpi) + '&view=json';
            fetch(ucUrl, { credentials: 'include' })
              .then(function (r) { return r.text(); })
              .then(function (text) { reportData(true, text); })
              .catch(function (e) { reportData(false, null, String(e)); });
          } catch (e) { reportData(false, null, String(e)); }
          break;
        }
        case 'cxGetEnc': {
          // md5("["+clazzid+"]["+uid+"]["+jobid+"]["+objectId+"]["+(playingTime*1000)+"][d_yHJ!$pdA~5]["+(duration*1000)+"][0_"+duration+"]")
          // 页面上下文里 @require 了 blueimp-md5，unsafeWindow.md5 可用；
          // 非超星页面无 md5 时返回 no-md5，调用方据此跳过上报
          try {
            var encWin = findWindowWith(function (w) { return typeof w.md5 === 'function'; }) || window;
            var md5fn = encWin.md5;
            if (typeof md5fn !== 'function') { reportData(false, null, 'no-md5'); break; }
            var raw = '[' + action.clazzid + '][' + action.uid + '][' + action.jobid + '][' + action.objectId + '][' +
              (action.playingTime * 1000) + '][d_yHJ!$pdA~5][' + (action.duration * 1000) + '][0_' + action.duration + ']';
            reportData(true, md5fn(raw));
          } catch (e) { reportData(false, null, String(e)); }
          break;
        }
        case 'cxReadTtfList': {
          // 串行尝试字体映射表 URL，命中即返回 JSON
          // 字体表是公开静态资源，用 credentials:'omit' 避免把超星 cookie 发给第三方域
          (function readNext(i) {
            if (i >= action.urls.length) { reportData(false, null, 'all-ttf-failed'); return; }
            fetch(action.urls[i], { credentials: 'omit' })
              .then(function (r) { return r.text(); })
              .then(function (text) {
                try { JSON.parse(text); reportData(true, text); }
                catch (e) { readNext(i + 1); }
              })
              .catch(function () { readNext(i + 1); });
          })(0);
          break;
        }
        default:
          report(requestId, false, '', 'unknown-kind');
      }
    } catch (error) {
      report(requestId, false, action.kind || '', String(error));
    }
  });
})();
`;

function injectPageBridge() {
  try {
    const script = document.createElement('script');
    script.textContent = PAGE_BRIDGE_SOURCE;
    (document.documentElement || document.head || document.body)?.appendChild(script);
    script.remove();
  } catch {
    // 注入失败时桥不可用，调用方按 ok=false 兜底
  }
}

export function installPageBridge() {
  if (installed) return;
  installed = true;
  window.addEventListener('studypilot:page-bridge-result' as any, ((event: CustomEvent) => {
    const detail = event.detail as PageBridgeResult | undefined;
    if (!detail?.requestId) return;
    const resolver = pending.get(detail.requestId);
    if (resolver) {
      pending.delete(detail.requestId);
      resolver(detail);
    }
  }) as EventListener);
  if (document.documentElement || document.head || document.body) injectPageBridge();
  else document.addEventListener('DOMContentLoaded', injectPageBridge, { once: true });
}

/** 调用页面上下文钩子；返回 null 表示桥不可用或页面无对应函数（调用方应走 DOM 兜底）。 */
export function callPageHook(action: PageBridgeAction, timeoutMs = 3000): Promise<PageBridgeResult | null> {
  installPageBridge();
  const requestId = `pb_${Date.now().toString(36)}_${(requestSeq += 1)}`;
  return new Promise((resolve) => {
    const timeoutId = window.setTimeout(() => {
      pending.delete(requestId);
      resolve(null);
    }, timeoutMs);
    pending.set(requestId, (result) => {
      window.clearTimeout(timeoutId);
      resolve(result);
    });
    window.dispatchEvent(new CustomEvent('studypilot:page-bridge-call', {
      detail: { requestId, action }
    }));
  });
}
