import { build } from 'vite';
import { cpSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHostPolicies } from './build-rust-host-policies-net.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
buildHostPolicies();
await build({ root, configFile: path.join(root, 'vite.rust.config.ts') });
// Preserve the local architecture/input fixture surfaces used by native QA.
// They are independent assets and never transform business source or output.
for (const entry of readdirSync(path.join(root, 'rust-host-poc'), { withFileTypes: true })) {
  if (entry.isFile() && /\.(?:html|css|m?js|json|png|svg|jpg)$/i.test(entry.name)) cpSync(path.join(root, 'rust-host-poc', entry.name), path.join(root, 'dist-rust', entry.name));
}
