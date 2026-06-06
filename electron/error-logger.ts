import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export type ErrorLogLevel = 'info' | 'warn' | 'error' | 'fatal';

export interface ErrorLogPayload {
  source: string;
  level?: ErrorLogLevel;
  message: string;
  stack?: string;
  url?: string;
  line?: number;
  column?: number;
  details?: unknown;
}

function logDirectory() {
  return path.join(app.getPath('userData'), 'logs');
}

function dayStamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getErrorLogPath(date = new Date()) {
  return path.join(logDirectory(), `studypilot-error-${dayStamp(date)}.log`);
}

function safeDetails(details: unknown) {
  if (!details) return undefined;
  try {
    return JSON.parse(JSON.stringify(details));
  } catch {
    return String(details);
  }
}

function normalizeError(error: unknown) {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack
    };
  }
  if (typeof error === 'object' && error !== null) {
    const anyError = error as any;
    return {
      message: String(anyError.message || anyError.reason || anyError.error || JSON.stringify(anyError)),
      stack: anyError.stack ? String(anyError.stack) : undefined
    };
  }
  return {
    message: String(error)
  };
}

export function writeErrorLog(payload: ErrorLogPayload) {
  try {
    fs.mkdirSync(logDirectory(), { recursive: true });
    const entry = {
      timestamp: new Date().toISOString(),
      level: payload.level || 'error',
      source: payload.source,
      message: payload.message,
      stack: payload.stack,
      url: payload.url,
      line: payload.line,
      column: payload.column,
      details: safeDetails(payload.details)
    };
    fs.appendFileSync(getErrorLogPath(), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (error) {
    console.error('[StudyPilot Logger] Failed to write error log:', error);
  }
}

export function writeUnknownError(source: string, error: unknown, details?: unknown, level: ErrorLogLevel = 'error') {
  const normalized = normalizeError(error);
  writeErrorLog({
    source,
    level,
    message: normalized.message,
    stack: normalized.stack,
    details
  });
}

export function pruneOldErrorLogs(maxAgeDays = 14) {
  try {
    const dir = logDirectory();
    if (!fs.existsSync(dir)) return;
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    for (const file of fs.readdirSync(dir)) {
      if (!/^studypilot-error-\d{4}-\d{2}-\d{2}\.log$/.test(file)) continue;
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs < cutoff) fs.unlinkSync(fullPath);
    }
  } catch (error) {
    console.error('[StudyPilot Logger] Failed to prune old logs:', error);
  }
}

export function installProcessErrorLogging() {
  process.on('uncaughtException', (error) => {
    writeUnknownError('main:uncaughtException', error, undefined, 'fatal');
    console.error('[StudyPilot Main] Uncaught exception:', error);
  });

  process.on('unhandledRejection', (reason) => {
    writeUnknownError('main:unhandledRejection', reason, undefined, 'fatal');
    console.error('[StudyPilot Main] Unhandled rejection:', reason);
  });
}
