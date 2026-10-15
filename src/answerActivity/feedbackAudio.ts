type FeedbackSound = 'extracted' | 'completed';

const MUTE_KEY = 'studypilot-answer-feedback-muted-v1';
let muted = false;
try { muted = localStorage.getItem(MUTE_KEY) === 'true'; } catch { /* Optional preference. */ }

let context: AudioContext | null = null;
const listeners = new Set<() => void>();
const playing = new Set<OscillatorNode>();

export const getFeedbackMuted = () => muted;
export const subscribeFeedbackMuted = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function setFeedbackMuted(value: boolean) {
  muted = value;
  try { localStorage.setItem(MUTE_KEY, String(value)); } catch { /* Keep the in-memory preference. */ }
  if (value) {
    playing.forEach(oscillator => { try { oscillator.stop(); } catch { /* Already finished. */ } });
    playing.clear();
  }
  listeners.forEach(listener => listener());
}

export function unlockFeedbackAudio() {
  try {
    const AudioConstructor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioConstructor) return;
    if (!context || context.state === 'closed') context = new AudioConstructor();
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
  } catch { /* Audio is optional on restricted devices. */ }
}

export function listenForFeedbackAudioUnlock() {
  const unlock = (event: Event) => { if (event.isTrusted) unlockFeedbackAudio(); };
  document.addEventListener('pointerdown', unlock, true);
  document.addEventListener('keydown', unlock, true);
  return () => {
    document.removeEventListener('pointerdown', unlock, true);
    document.removeEventListener('keydown', unlock, true);
  };
}

function tone(audio: AudioContext, start: number, length: number, from: number, to: number, volume: number) {
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(from, start);
  oscillator.frequency.exponentialRampToValueAtTime(to, start + length);
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(volume, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  oscillator.connect(gain);
  gain.connect(audio.destination);
  playing.add(oscillator);
  oscillator.onended = () => { playing.delete(oscillator); oscillator.disconnect(); gain.disconnect(); };
  oscillator.start(start);
  oscillator.stop(start + length);
}

export function playFeedbackAudio(kind: FeedbackSound) {
  if (muted || !context || context.state !== 'running') return;
  try {
    const start = context.currentTime;
    if (kind === 'extracted') {
      tone(context, start, 0.125, 720, 510, 0.045);
      tone(context, start + 0.125, 0.125, 650, 420, 0.035);
    } else {
      tone(context, start, 0.14, 523.25, 523.25, 0.04);
      tone(context, start + 0.09, 0.15, 659.25, 659.25, 0.035);
      tone(context, start + 0.18, 0.2, 783.99, 1046.5, 0.035);
    }
  } catch { /* Feedback remains visible if the device cannot play audio. */ }
}
