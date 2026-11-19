import { createHash } from 'node:crypto';
import { open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const MAX_PACKAGE_BYTES = 128 * 1024 * 1024;
const profileKey = key => /^studypilot[_-]/.test(key);

/** Opaque existing data is wrapped, never normalized into a new business schema. */
export function createProfileEnvelope({ database, localStorage, sourceVersion, indexedDBDatabases = [] }) {
  if (!object(database)) throw new Error('The existing database must be a JSON object');
  if (!object(localStorage) || !Object.values(localStorage).every(value => typeof value === 'string')) throw new Error('A complete renderer localStorage snapshot is required');
  if (!Array.isArray(indexedDBDatabases) || indexedDBDatabases.length) throw new Error('Renderer IndexedDB exists and requires a reviewed exporter before migration');
  if (typeof sourceVersion !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(sourceVersion)) throw new Error('An explicit source application version is required');
  const payload = {
    database,
    localStorage: Object.fromEntries(Object.entries(localStorage).filter(([key]) => profileKey(key))),
    sourceVersion, exportedAt: new Date().toISOString(),
    rendererIndexedDB: 'none-detected', guestLogin: 'reauthentication-required',
  };
  const payloadJson = JSON.stringify(payload);
  if (Buffer.byteLength(payloadJson) > MAX_PACKAGE_BYTES) throw new Error('Profile exceeds the migration package budget');
  return { schemaVersion: 1, format: 'studypilot-profile-export', sourceHost: 'electron', payloadJson, sha256: digest(payloadJson) };
}

export function verifyProfileEnvelope(envelope) {
  if (!object(envelope) || envelope.schemaVersion !== 1 || envelope.format !== 'studypilot-profile-export' || envelope.sourceHost !== 'electron'
      || typeof envelope.payloadJson !== 'string' || Buffer.byteLength(envelope.payloadJson) > MAX_PACKAGE_BYTES
      || !/^[a-f0-9]{64}$/.test(envelope.sha256 || '') || digest(envelope.payloadJson) !== envelope.sha256) throw new Error('Invalid profile version or checksum');
  const payload = JSON.parse(envelope.payloadJson);
  if (!object(payload.database) || !object(payload.localStorage) || !Object.entries(payload.localStorage).every(([key, value]) => profileKey(key) && typeof value === 'string')
      || payload.rendererIndexedDB !== 'none-detected' || payload.guestLogin !== 'reauthentication-required') throw new Error('Incomplete renderer profile or unsupported login migration');
  return payload;
}

/** Only the explicitly named export is written. Existing files are never replaced. */
export async function writeProfileExport(output, envelope) {
  verifyProfileEnvelope(envelope);
  const file = await open(path.resolve(output), 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(envelope, null, 2) + '\n'); await file.sync(); }
  catch (error) { await file.close(); await unlink(path.resolve(output)).catch(() => {}); throw error; }
  await file.close();
}

function loopback(value, protocols) {
  const url = new URL(value);
  if (!protocols.includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('The debugging endpoint must be explicit loopback without credentials');
  return url;
}

/** Attach to one explicitly selected existing UI; never create/navigate/close it. */
async function rendererSnapshot(endpoint, uiUrl) {
  if (!uiUrl) throw new Error('--ui-url must identify exactly the existing Electron UI');
  const base = loopback(endpoint, ['http:']);
  const targets = await fetch(new URL('/json/list', base), { redirect: 'error', signal: AbortSignal.timeout(5000) }).then(response => { if (!response.ok) throw new Error('Cannot list Electron renderer targets'); return response.json(); });
  const matches = targets.filter(target => target.type === 'page' && target.url === uiUrl);
  if (matches.length !== 1) throw new Error('The explicit Electron UI must match exactly one existing renderer');
  const target = loopback(matches[0].webSocketDebuggerUrl, ['ws:']);
  if (target.hostname !== base.hostname || target.port !== base.port) throw new Error('Renderer debugger left the selected loopback endpoint');
  const socket = new WebSocket(target);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Renderer export timed out')), 5000);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.close();
      if (error) reject(error); else resolve(value);
    };
    socket.addEventListener('error', () => finish(new Error('Renderer export connection failed')));
    socket.addEventListener('close', () => { if (!settled) finish(new Error('Renderer export disconnected')); });
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
      expression: `(async () => { if (!window.electronAPI || typeof window.electronAPI.getSettings !== 'function') throw new Error('Not the Electron UI'); return { localStorage: Object.fromEntries(Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)])), indexedDBDatabases: typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).map(db => db.name) : ['unavailable-enumeration'] }; })()`,
      awaitPromise: true, returnByValue: true,
    } })));
    socket.addEventListener('message', event => {
      try {
        const response = JSON.parse(String(event.data));
        if (response.id !== 1) return;
        if (response.error || response.result?.exceptionDetails || !object(response.result?.result?.value)) { finish(new Error('Renderer refused read-only profile export')); return; }
        finish(null, response.result.result.value);
      } catch { finish(new Error('Invalid renderer export response')); }
    });
  });
}

async function main(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    if (!['--database', '--renderer-json', '--cdp', '--ui-url', '--output', '--source-version'].includes(args[index]) || !args[index + 1] || options.has(args[index])) throw new Error('Use --database <copy> (--renderer-json <snapshot> | --cdp <loopback> --ui-url <exact UI URL>) --output <new file> --source-version <version>');
    options.set(args[index], args[index + 1]);
  }
  if (!options.get('--database') || !options.get('--output') || !options.get('--source-version') || Number(options.has('--renderer-json')) + Number(options.has('--cdp')) !== 1) throw new Error('Explicit database, renderer snapshot, output and source version are required');
  const before = await readFile(options.get('--database'));
  const renderer = options.has('--renderer-json') ? JSON.parse(await readFile(options.get('--renderer-json'), 'utf8')) : await rendererSnapshot(options.get('--cdp'), options.get('--ui-url'));
  if (!object(renderer) || !Array.isArray(renderer.indexedDBDatabases)) throw new Error('Renderer IndexedDB inventory is required for a complete source snapshot');
  if (!before.equals(await readFile(options.get('--database')))) throw new Error('Source database changed while exporting; retry when the app is idle');
  const envelope = createProfileEnvelope({ database: JSON.parse(before.toString('utf8')), localStorage: renderer.localStorage, indexedDBDatabases: renderer.indexedDBDatabases, sourceVersion: options.get('--source-version') });
  await writeProfileExport(options.get('--output'), envelope);
  // Never print settings, credentials, page URLs, or the exported business data.
  console.log('Read-only profile export saved; website sessions require sign-in in Rust.');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => { console.error(error.code === 'EEXIST' ? 'Export output already exists.' : 'Profile export failed. Check the explicit source paths and renderer snapshot.'); process.exitCode = 1; });
}
