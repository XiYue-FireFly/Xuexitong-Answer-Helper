import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { MobileTaskStatus } from '../mobile/taskStatus';
export type TaskCapabilities = { notifications: boolean; overlay: boolean; overlayEnabled: boolean; mediaCard: boolean;
  manufacturer: string; brand: string; liveUpdates: boolean; batteryRestricted: boolean; api: number };
export const TaskStatus = registerPlugin<{
  update(status: MobileTaskStatus): Promise<void>;
  getCapabilities(): Promise<TaskCapabilities>;
  requestNotifications(): Promise<TaskCapabilities>;
  setOverlay(options: { enabled: boolean }): Promise<TaskCapabilities>;
  setMediaCard(options: { enabled: boolean }): Promise<TaskCapabilities>;
  addListener(event: 'mediaControl', listener: (event: { paused: boolean }) => void): Promise<PluginListenerHandle>;
  openLiveUpdateSettings(): Promise<void>;
  openBatterySettings(): Promise<void>;
  consumeOpenTask(): Promise<{ open: boolean }>;
}>('TaskStatus');
