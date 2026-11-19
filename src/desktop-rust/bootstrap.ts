import { getRustHost } from './hostClient';
import { installLegacyApi } from './legacyApi';
import { installMigrationUI, restoreImportedProfile } from './migrationUI';
import { installHostPolicies } from './hostPolicies';
import { installMediaPolicy } from './mediaPolicy';

async function bootRustDesktop() {
  const host = getRustHost();
  installHostPolicies(host);
  installMediaPolicy(host);
  // The original store reads desktop capability during module initialization.
  await installLegacyApi();
  await restoreImportedProfile();
  await import('../main');
  if (!document.querySelector('.desktop-shell')) await new Promise<void>(resolve => {
    const observer = new MutationObserver(() => { if (document.querySelector('.desktop-shell')) { observer.disconnect(); resolve(); } });
    observer.observe(document.getElementById('root') || document.body, { childList: true, subtree: true });
  });
  installMigrationUI();
}

void bootRustDesktop().catch(error => {
  const root = document.getElementById('root');
  if (root) { root.setAttribute('role', 'alert'); root.textContent = error instanceof Error ? error.message : String(error); }
  console.error('Rust desktop bootstrap failed', error);
});
