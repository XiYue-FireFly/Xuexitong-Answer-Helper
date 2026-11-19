import { getRustHost } from './hostClient';

const APPLIED_KEY = 'rust-profile-applied';
const BACKUP_KEY = 'rust-profile-renderer-backup';
const SECTION_ID = 'rust-profile-migration';
const MAX_EXPORT_BYTES = 140 * 1024 * 1024;
const profileKey = (key: string) => /^studypilot[_-]/.test(key);
type ImportedProfile = { token: string; localStorage: Record<string, string> };
type StagedProfile = { token: string; sourceVersion?: string; localStorageKeys?: number; guestLogin?: string };
const installations = new WeakMap<Document, () => void>();

function importedProfile(value: unknown): ImportedProfile {
  if (!value || typeof value !== 'object') throw new Error('迁移配置无效。');
  const profile = value as ImportedProfile;
  if (!/^[a-f0-9]{64}$/.test(profile.token) || !profile.localStorage || typeof profile.localStorage !== 'object'
      || Array.isArray(profile.localStorage) || Object.entries(profile.localStorage).some(([key, entry]) => !profileKey(key) || typeof entry !== 'string')) {
    throw new Error('迁移配置包含未支持的数据。');
  }
  return profile;
}

function snapshot(storage: Storage): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key && profileKey(key)) values[key] = storage.getItem(key)!;
  }
  return values;
}

function replace(storage: Storage, values: Record<string, string>) {
  for (const key of Object.keys(snapshot(storage))) if (!(key in values)) storage.removeItem(key);
  for (const [key, value] of Object.entries(values)) storage.setItem(key, value);
}

function applyProfile(value: unknown): void {
  const profile = importedProfile(value);
  const storage = window.localStorage;
  if (storage.getItem(APPLIED_KEY) === profile.token) return;
  const previous = snapshot(storage), previousToken = storage.getItem(APPLIED_KEY);
  // Retain an origin-local rollback copy before replacing any business key.
  // A quota failure here leaves the original profile entirely unchanged.
  try {
    storage.setItem(BACKUP_KEY, JSON.stringify({ token: previousToken, localStorage: previous }));
    replace(storage, profile.localStorage);
    storage.setItem(APPLIED_KEY, profile.token);
  } catch {
    try {
      replace(storage, previous);
      if (previousToken === null) storage.removeItem(APPLIED_KEY); else storage.setItem(APPLIED_KEY, previousToken);
    } catch {
      throw new Error('迁移存储失败；原配置备份仍保留，请释放存储空间后重试启动。');
    }
    throw new Error('迁移存储失败，已恢复导入前配置。');
  }
}

/** Await before importing any frozen module that reads settings/localStorage. */
export async function restoreImportedProfile(): Promise<void> {
  const profile = await getRustHost().invoke<ImportedProfile | null>('profile:startup', undefined);
  if (profile !== null) applyProfile(profile);
}

function createSection(document: Document): HTMLElement {
  const section = document.createElement('section');
  section.id = SECTION_ID;
  section.className = 'glass-panel dock-settings';
  section.setAttribute('aria-label', '从 Electron 导入数据');
  const heading = document.createElement('h5'); heading.textContent = '从 Electron 导入数据';
  const description = document.createElement('p');
  description.textContent = '选择从原应用导出的迁移包，保留题库、设置、历史、Token 与工具栏偏好。网页登录需要重新登录。';
  const label = document.createElement('label'); label.className = 'dock-settings__toggle'; label.textContent = '迁移包文件';
  const file = document.createElement('input'); file.type = 'file'; file.accept = 'application/json,.json'; file.setAttribute('aria-label', '选择 Electron 迁移包');
  label.append(file);
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  status.textContent = '尚未选择文件。';
  const actions = document.createElement('div'); actions.className = 'dock-settings__quality';
  const confirm = document.createElement('button'); confirm.type = 'button'; confirm.disabled = true; confirm.textContent = '确认导入并重新加载';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消'; cancel.hidden = true;
  actions.append(confirm, cancel);
  section.append(heading, description, label, status, actions);
  let staged: StagedProfile | null = null, selection = 0, committing = false;
  cancel.addEventListener('click', () => {
    if (committing) return;
    selection++; staged = null; confirm.disabled = true; cancel.hidden = true; file.value = '';
    status.textContent = '已取消，当前配置未改变。';
  });
  file.addEventListener('change', () => {
    const current = ++selection;
    staged = null; confirm.disabled = true; cancel.hidden = true;
    const selected = file.files?.[0];
    if (!selected) { status.textContent = '尚未选择文件。'; return; }
    if (!selected.size || selected.size > MAX_EXPORT_BYTES) { status.textContent = '迁移包为空或超出大小限制。'; return; }
    status.textContent = '正在校验迁移包…';
    void (async () => {
      try {
        const envelope: unknown = JSON.parse(await selected.text());
        if (selection !== current || !section.isConnected) return;
        const result = await getRustHost().invoke<StagedProfile>('profile:stage', envelope);
        if (selection !== current || !section.isConnected) return;
        if (!result || !/^[a-f0-9]{64}$/.test(result.token) || !Number.isSafeInteger(result.localStorageKeys) || result.localStorageKeys! < 0) throw new Error('Invalid staged profile');
        staged = result; confirm.disabled = false; cancel.hidden = false;
        const version = typeof result.sourceVersion === 'string' ? result.sourceVersion : '原应用';
        status.textContent = `已校验 ${version} 数据包，包含 ${result.localStorageKeys} 项本地存储。确认后将使用导入配置并重新加载。`;
      } catch {
        if (selection === current && section.isConnected) status.textContent = '迁移包校验失败，当前配置未改变。请重新选择完整导出文件。';
      }
    })();
  });
  confirm.addEventListener('click', () => {
    if (!staged || committing) return;
    const candidate = staged; committing = true;
    confirm.disabled = true; cancel.disabled = true; file.disabled = true;
    status.textContent = '正在提交导入配置…';
    void (async () => {
      try {
        const result = await getRustHost().invoke<{ token?: string; localStorage: Record<string, string> }>('profile:commit', { token: candidate.token });
        applyProfile({ ...result, token: result.token ?? candidate.token });
        status.textContent = '导入完成，正在重新加载。';
        window.location.reload();
      } catch {
        status.textContent = '导入未完成，请重试。原 Electron 数据保持完整。';
        committing = false; confirm.disabled = false; cancel.disabled = false; file.disabled = false;
      }
    })();
  });
  return section;
}

/** Add the independent host settings only where the frozen settings panel mounts. */
export function installMigrationUI(): () => void {
  const existing = installations.get(document);
  if (existing) return existing;
  let disposed = false;
  const attach = () => {
    if (disposed || document.getElementById(SECTION_ID)) return;
    const anchor = document.querySelector('.dock-settings');
    if (anchor?.isConnected) anchor.insertAdjacentElement('afterend', createSection(document));
  };
  const observer = new MutationObserver(attach);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  const dispose = () => {
    if (disposed) return;
    disposed = true; observer.disconnect(); document.getElementById(SECTION_ID)?.remove();
    window.removeEventListener('pagehide', dispose); installations.delete(document);
  };
  window.addEventListener('pagehide', dispose, { once: true });
  installations.set(document, dispose); attach();
  return dispose;
}
