import React from 'react';
import { BookOpen, Brain, FastForward, FileText, Pause, Play, RefreshCw, Square, Volume2, VolumeX } from 'lucide-react';
import { appStore, useAppStore } from '../store/appStore';

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '00:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

type ChapterAction = 'scan' | 'start' | 'pause' | 'play' | 'stop';

export function ChapterLearningPanel() {
  const { settings, chapterLearning } = useAppStore();
  const videos = chapterLearning?.videos || [];
  const audios = chapterLearning?.audios || [];
  const taskPoints = chapterLearning?.taskPoints || [];
  const currentVideo = videos[0];
  const currentAudio = audios[0];
  const completedTasks = taskPoints.filter((task) => task.completed).length;

  const buildOptions = (nextSettings = settings) => ({
    autoNext: nextSettings.chapterAutoNext,
    autoPlay: nextSettings.chapterAutoPlay,
    muted: nextSettings.chapterVideoMuted,
    playbackRate: nextSettings.chapterVideoSpeed,
    autoReadDocument: nextSettings.chapterAutoReadDocument,
    autoAnswerQuestions: nextSettings.chapterAutoAnswerQuestions,
    restudy: nextSettings.chapterRestudy,
    unlockMode: nextSettings.chapterUnlockMode,
    faceRecognition: nextSettings.chapterFaceRecognition,
    rateHack: nextSettings.chapterRateHack
  });

  const sendAction = (action: ChapterAction, nextSettings = settings) => {
    window.dispatchEvent(new CustomEvent('studypilot:chapter-learning-action', {
      detail: {
        action,
        options: buildOptions(nextSettings)
      }
    }));
  };

  const updateChapterSettings = (updates: Partial<typeof settings>) => {
    const nextSettings = { ...settings, ...updates };
    appStore.updateSettings(updates);
    window.dispatchEvent(new CustomEvent('studypilot:chapter-learning-action', {
      detail: {
        action: 'set-options',
        options: buildOptions(nextSettings)
      }
    }));
  };

  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16, height: '100%', overflowY: 'auto' }}>
      <div className="glass-panel" style={{ padding: 18, borderRadius: 8, borderLeft: '4px solid var(--success-color)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <BookOpen size={18} style={{ color: 'var(--success-color)' }} />
          <h4 style={{ color: 'var(--text-primary)', fontSize: '0.95rem' }}>章节学习辅助</h4>
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', lineHeight: 1.6 }}>
          自动播放视频和音频，读取文档/PPT，检测任务点状态。内容完成后可自动打开下一章节继续学习。
        </p>
      </div>

      <div className="glass-panel" style={{ padding: 16, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h5 style={{ color: 'var(--text-primary)', fontSize: '0.86rem' }}>控制</h5>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <button onClick={() => sendAction('scan')} style={{ background: 'rgba(99,102,241,0.16)', color: 'var(--text-primary)', padding: 10, borderRadius: 8, fontWeight: 800, display: 'flex', justifyContent: 'center', gap: 6, alignItems: 'center' }}>
            <RefreshCw size={15} /> 扫描章节
          </button>
          <button onClick={() => sendAction('start')} style={{ background: 'linear-gradient(135deg, var(--primary-color), var(--accent-color))', color: '#fff', padding: 10, borderRadius: 8, fontWeight: 900, display: 'flex', justifyContent: 'center', gap: 6, alignItems: 'center' }}>
            <Play size={15} /> 开始学习
          </button>
          <button onClick={() => sendAction('pause')} style={{ background: 'rgba(245,158,11,0.16)', color: 'var(--text-primary)', padding: 10, borderRadius: 8, fontWeight: 800, display: 'flex', justifyContent: 'center', gap: 6, alignItems: 'center' }}>
            <Pause size={15} /> 暂停媒体
          </button>
          <button onClick={() => sendAction('stop')} style={{ background: 'rgba(239,68,68,0.14)', color: 'var(--text-primary)', padding: 10, borderRadius: 8, fontWeight: 800, display: 'flex', justifyContent: 'center', gap: 6, alignItems: 'center' }}>
            <Square size={15} /> 停止辅助
          </button>
        </div>
      </div>

      <div className="glass-panel" style={{ padding: 16, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h5 style={{ color: 'var(--text-primary)', fontSize: '0.86rem' }}>播放设置</h5>
        <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
          <span>视频/音频结束后打开下一章节</span>
          <input type="checkbox" checked={settings.chapterAutoNext} onChange={(event) => updateChapterSettings({ chapterAutoNext: event.target.checked })} style={{ width: 18, height: 18 }} />
        </label>
        <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
          <span>进入章节后自动播放视频/音频</span>
          <input type="checkbox" checked={settings.chapterAutoPlay} onChange={(event) => updateChapterSettings({ chapterAutoPlay: event.target.checked })} style={{ width: 18, height: 18 }} />
        </label>
        <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {settings.chapterVideoMuted ? <VolumeX size={14} /> : <Volume2 size={14} />} 静音播放
          </span>
          <input type="checkbox" checked={settings.chapterVideoMuted} onChange={(event) => updateChapterSettings({ chapterVideoMuted: event.target.checked })} style={{ width: 18, height: 18 }} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 8, color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <FastForward size={14} /> 播放速度：{settings.chapterVideoSpeed <= 0 ? '0x（暂停）' : `${settings.chapterVideoSpeed.toFixed(1)}x`}
          </span>
          <input type="range" min="0" max="16" step="0.1" value={settings.chapterVideoSpeed} onChange={(event) => updateChapterSettings({ chapterVideoSpeed: Number(event.target.value) })} />
        </label>
      </div>

      <div className="glass-panel" style={{ padding: 16, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h5 style={{ color: 'var(--text-primary)', fontSize: '0.86rem' }}>自动化设置</h5>
        <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <FileText size={14} /> 自动阅读文档/PPT
          </span>
          <input type="checkbox" checked={settings.chapterAutoReadDocument} onChange={(event) => updateChapterSettings({ chapterAutoReadDocument: event.target.checked })} style={{ width: 18, height: 18 }} />
        </label>
        <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Brain size={14} /> 自动处理章节题目
          </span>
          <input type="checkbox" checked={settings.chapterAutoAnswerQuestions} onChange={(event) => updateChapterSettings({ chapterAutoAnswerQuestions: event.target.checked })} style={{ width: 18, height: 18 }} />
        </label>
      </div>

      <div className="glass-panel" style={{ padding: 16, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h5 style={{ color: 'var(--text-primary)', fontSize: '0.86rem' }}>学习模式</h5>
        <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
          <span>复习模式（已完成视频继续学习）</span>
          <input type="checkbox" checked={settings.chapterRestudy} onChange={(event) => updateChapterSettings({ chapterRestudy: event.target.checked })} style={{ width: 18, height: 18 }} />
        </label>
        <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
          <span>闯关模式自动解锁章节</span>
          <input type="checkbox" checked={settings.chapterUnlockMode} onChange={(event) => updateChapterSettings({ chapterUnlockMode: event.target.checked })} style={{ width: 18, height: 18 }} />
        </label>
        <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
          <span>人脸识别检测暂停</span>
          <input type="checkbox" checked={settings.chapterFaceRecognition} onChange={(event) => updateChapterSettings({ chapterFaceRecognition: event.target.checked })} style={{ width: 18, height: 18 }} />
        </label>
        <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
          <span>倍速防清进度（绕过拖拽检测）</span>
          <input type="checkbox" checked={settings.chapterRateHack} onChange={(event) => updateChapterSettings({ chapterRateHack: event.target.checked })} style={{ width: 18, height: 18 }} />
        </label>
      </div>

      <div className="glass-panel" style={{ padding: 16, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h5 style={{ color: 'var(--text-primary)', fontSize: '0.86rem' }}>当前章节状态</h5>
          <span className={`badge ${chapterLearning?.running ? 'badge-success' : 'badge-primary'}`}>
            {chapterLearning?.running ? '运行中' : '未运行'}
          </span>
        </div>
        <div style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', lineHeight: 1.6 }}>
          <div>页面：{chapterLearning?.title || '尚未扫描'}</div>
          <div>视频：{videos.length} 个</div>
          {audios.length > 0 && <div>音频：{audios.length} 个</div>}
          {Boolean(chapterLearning?.documentReaders) && <div>文档：{chapterLearning?.documentReaders} 个</div>}
          {taskPoints.length > 0 && <div>任务点：{completedTasks}/{taskPoints.length} 完成</div>}
          <div>章节链接：{chapterLearning?.chapters.length || 0} 个</div>
          <div>状态：{chapterLearning?.lastMessage || '点击“扫描章节”读取当前页面状态。'}</div>
        </div>
      </div>

      {currentVideo && (
        <div className="glass-panel" style={{ padding: 16, borderRadius: 8 }}>
          <h5 style={{ color: 'var(--text-primary)', fontSize: '0.86rem', marginBottom: 10 }}>视频进度</h5>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', lineHeight: 1.7 }}>
            <div>进度：{formatTime(currentVideo.currentTime)} / {formatTime(currentVideo.duration)}</div>
            <div>状态：{currentVideo.ended ? '已结束' : currentVideo.paused ? '暂停' : '播放中'}</div>
            <div>速度：{currentVideo.playbackRate.toFixed(1)}x</div>
          </div>
        </div>
      )}

      {currentAudio && (
        <div className="glass-panel" style={{ padding: 16, borderRadius: 8 }}>
          <h5 style={{ color: 'var(--text-primary)', fontSize: '0.86rem', marginBottom: 10 }}>音频进度</h5>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', lineHeight: 1.7 }}>
            <div>进度：{formatTime(currentAudio.currentTime)} / {formatTime(currentAudio.duration)}</div>
            <div>状态：{currentAudio.ended ? '已结束' : currentAudio.paused ? '暂停' : '播放中'}</div>
            <div>速度：{currentAudio.playbackRate.toFixed(1)}x</div>
          </div>
        </div>
      )}

      {taskPoints.length > 0 && (
        <div className="glass-panel" style={{ padding: 16, borderRadius: 8 }}>
          <h5 style={{ color: 'var(--text-primary)', fontSize: '0.86rem', marginBottom: 10 }}>任务点列表</h5>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {taskPoints.slice(0, 5).map((task, index) => (
              <div key={`${task.title}-${index}`} style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)', fontSize: '0.76rem' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: task.completed ? 'var(--success-color)' : 'var(--text-tertiary)', flexShrink: 0 }} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</span>
                <span style={{ fontSize: '0.7rem', color: task.completed ? 'var(--success-color)' : 'var(--text-tertiary)', flexShrink: 0 }}>
                  {task.completed ? '完成' : '未完成'}
                </span>
              </div>
            ))}
            {taskPoints.length > 5 && (
              <div style={{ color: 'var(--text-tertiary)', fontSize: '0.72rem', textAlign: 'center' }}>
                还有 {taskPoints.length - 5} 个任务点
              </div>
            )}
          </div>
        </div>
      )}

      {chapterLearning?.nextChapter && (
        <div className="glass-panel" style={{ padding: 16, borderRadius: 8 }}>
          <h5 style={{ color: 'var(--text-primary)', fontSize: '0.86rem', marginBottom: 8 }}>下一章节</h5>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', lineHeight: 1.5 }}>
            {chapterLearning.nextChapter.title}
          </div>
        </div>
      )}
    </div>
  );
}
