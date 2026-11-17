import { registerPlugin } from '@capacitor/core';
import type { MobileTaskStatus } from '../mobile/taskStatus';
export type TaskCapabilities = { notifications: boolean; overlay: boolean; overlayEnabled: boolean; liveUpdates: boolean; batteryRestricted: boolean; api: number };
export const TaskStatus = registerPlugin<{
  update(status: MobileTaskStatus): Promise<void>;
  getCapabilities(): Promise<TaskCapabilities>;
  requestNotifications(): Promise<TaskCapabilities>;
  setOverlay(options: { enabled: boolean }): Promise<TaskCapabilities>;
  openBatterySettings(): Promise<void>;
  consumeOpenTask(): Promise<{ open: boolean }>;
}>('TaskStatus');
