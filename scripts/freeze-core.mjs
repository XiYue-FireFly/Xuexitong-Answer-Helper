import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const BASELINE_COMMIT = '402dd25553185f39df56ca0014a1916a58c57a8e';
export const DOCUMENT_DIRECTORY = 'docs/migrations/rust-host';
export const MIXED_FILES = ['electron/main.ts', 'electron/web-ai-task-resources.ts'];
export const STRICT_DIRECTORIES = ['src/webAI/', 'src/utils/', 'electron/preload-webview/'];
export const sha256 = value => createHash('sha256').update(value).digest('hex');
// Git's canonical LF bytes are stable across Windows core.autocrlf checkouts.
// No whitespace, BOM, Unicode, or other source normalization is permitted.
export const canonicalBytes = value => isUtf8(value) ? Buffer.from(value.toString('utf8').replace(/\r\n/g, '\n'), 'utf8') : value;
/** Validate both lexical traversal and existing symlink/junction ancestors. */
export function workspacePath(root, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\\') || /[:\x00-\x1f]/.test(relativePath) || path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) || relativePath.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Unsafe workspace path: ${String(relativePath)}`);
  const workspace = realpathSync(root), target = path.resolve(root, ...relativePath.split('/'));
  const contained = candidate => { const relative = path.relative(workspace, candidate); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
  const exists = candidate => { try { lstatSync(candidate); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
  let ancestor = target;
  while (!exists(ancestor)) { const parent = path.dirname(ancestor); if (parent === ancestor) throw new Error(`Unsafe workspace path: ${relativePath}`); ancestor = parent; }
  if (!contained(realpathSync(ancestor))) throw new Error(`Workspace path escapes through symlink or junction: ${relativePath}`);
  return target;
}
const text = node => node.getText(node.getSourceFile());
const sorted = values => [...new Set(values)].sort();
const git = (root, args) => execFileSync('git', ['-C', root, ...args], { maxBuffer: 32 * 1024 * 1024, windowsHide: true });
const parse = (file, source) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const walk = (node, visit) => { visit(node); ts.forEachChild(node, child => walk(child, visit)); };
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
export const astHash = node => sha256(canonicalBytes(Buffer.from(printer.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile()))));
const location = node => ({ line: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1, endLine: node.getSourceFile().getLineAndCharacterOfPosition(node.end).line + 1 });

export function importsOf(file, source) {
  const imports = [];
  if (/\.[cm]?[jt]sx?$/.test(file)) walk(parse(file, source), node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) imports.push(node.arguments[0].text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) imports.push(node.argument.literal.text);
    if (ts.isNewExpression(node) && text(node.expression) === 'URL' && node.arguments?.[0] && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[1] && text(node.arguments[1]) === 'import.meta.url') imports.push(node.arguments[0].text);
  });
  if (file.endsWith('.css')) for (const match of source.matchAll(/(?:@import\s+|url\(\s*)["']([^"']+)["']/g)) imports.push(match[1]);
  return sorted(imports);
}

export function dependencyGraph(files, read, availableFiles = files) {
  const existing = new Set(availableFiles), entries = [], external = [], unresolved = [];
  for (const file of files) for (const specifier of importsOf(file, read(file).toString('utf8'))) {
    if (!specifier.startsWith('.')) { external.push(specifier); continue; }
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier.split('?')[0]));
    const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json', '.css'].map(extension => base + extension), ...['.ts', '.tsx', '.js', '.jsx'].map(extension => `${base}/index${extension}`)];
    const dependency = candidates.find(candidate => existing.has(candidate));
    if (dependency) entries.push({ from: file, specifier, to: dependency });
    else unresolved.push({ from: file, specifier });
  }
  return { entries, external: sorted(external), unresolved };
}

const HOST_SYMBOLS = {
  lifecycle: new Set(['mainWindow', 'webviewStorageFlushTimer', 'webviewSessionCookieTimer', 'isFinalizingQuit', 'createWindow', 'flushWebviewStorage', 'scheduleWebviewStorageFlush', 'persistWebviewSessionCookies', 'scheduleWebviewSessionCookiePersistence']),
  transport: new Set(['frameUrl', 'logWebviewNavigation', 'readRecentErrorLogs', 'createRequestHeaders', 'injectFrameClickBridge', 'injectAllFrameClickBridges', 'requestJson', 'fetchText', 'fetchJson', 'registerWebAITaskResources'])
};
const CORE_REASONS = {
  inspectSourceMedia: 'Question/material ownership, visibility, identity and URL policy must execute unchanged in the source document.',
  readDocumentImage: 'Document-origin image decoding includes MIME and byte-limit semantics; only fetch binding is replaceable.',
  installNavigationIntent: 'Captures confirmed GET intent and blocks converting unknown or POST navigation into GET.',
  createWebAITaskResourceManager: 'Mixed coordinator owns source binding, refcounts, cancellation, navigation, cache and quotas; retain policy and extract only host I/O.',
  frameClickBridgeSource: 'Injected website selectors, exam URL construction and navigation classification remain JavaScript.',
  normalizeCloudBankManifest: 'Cloud question-bank schema normalization, validation and ordering are business semantics.',
  readDB: 'Default persisted schema and corrupt-file recovery behavior are frozen alongside transport.',
  writeDB: 'Existing serialization, atomic ordering and failure behavior are the compatibility reference.'
};

export function symbolsFor(file, source) {
  const ast = parse(file, source), symbols = [];
  function add(node, name, enclosing = null) {
    let classification = 'core';
    if (!enclosing) for (const [kind, names] of Object.entries(HOST_SYMBOLS)) if (names.has(name)) classification = kind;
    const reason = classification === 'core' ? CORE_REASONS[name] || 'Conservative default: source, payload semantics and policy remain frozen until explicitly reviewed.' : classification === 'transport' ? 'Host I/O binding may be replaced; original payload, errors, ordering and cleanup remain the compatibility contract.' : 'Window/session lifecycle may be replaced while preserving observable state and cleanup.';
    symbols.push({ name, enclosing, kind: ts.SyntaxKind[node.kind], classification, reason, ...location(node), sourceSha256: sha256(canonicalBytes(Buffer.from(text(node)))), astSha256: astHash(node) });
  }
  ast.statements.forEach((statement, index) => {
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) add(declaration, text(declaration.name));
    else if (statement.name) add(statement, text(statement.name));
    else if (ts.isImportDeclaration(statement)) add(statement, `import:${statement.moduleSpecifier.text}`);
    else if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
      const call = statement.expression, channel = call.arguments[0];
      add(statement, `${text(call.expression)}:${channel && ts.isStringLiteralLike(channel) ? channel.text : `statement-${index}`}`);
    } else add(statement, `statement:${index}:${ts.SyntaxKind[statement.kind]}`);
  });
  // Nested named functions are separate review targets even inside a host wrapper.
  walk(ast, node => {
    if (ts.isFunctionDeclaration(node) && node.parent !== ast && node.name) {
      let owner = node.parent;
      while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
      add(node, node.name.text, owner?.name?.text || '<callback>');
    }
    if (ts.isVariableDeclaration(node) && node.parent?.parent?.parent !== ast) {
      let owner = node.parent;
      while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
      add(node, text(node.name), owner?.name?.text || '<callback>');
    }
  });
  return symbols;
}

function buildTransforms(read) {
  const specifications = [
    { id: 'electron-transport-import', file: 'electron/preload-webview.ts', node: 'ImportDeclaration', module: 'electron', count: 1, bindings: ['ipcRenderer', 'webFrame'] },
    { id: 'desktop-capability-detection', file: 'src/store/appStore.ts', node: 'PropertyAssignment', symbol: 'isElectron', count: 1, expectedExpression: "typeof window !== 'undefined' && navigator.userAgent.toLowerCase().includes('electron')" },
    { id: 'webview-component-connection', file: 'src/components/BrowserPanel.tsx', node: 'JsxSelfClosingElement', tagName: 'webview', count: 1 }
  ];
  return specifications.map(specification => {
    const targets = [];
    walk(parse(specification.file, read(specification.file).toString('utf8')), node => {
      if (specification.id === 'electron-transport-import' && ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && node.moduleSpecifier.text === specification.module
        || specification.id === 'desktop-capability-detection' && ts.isPropertyAssignment(node) && text(node.name) === specification.symbol
        || specification.id === 'webview-component-connection' && ts.isJsxSelfClosingElement(node) && text(node.tagName) === specification.tagName) targets.push({ ...location(node), astSha256: astHash(node), sourceSha256: sha256(canonicalBytes(Buffer.from(text(node)))) });
    });
    if (targets.length !== specification.count) throw new Error(`Build transform target drift: ${specification.id} (${targets.length})`);
    return { ...specification, targets };
  });
}

function registrations(file, source, receiver, method, ast = parse(file, source)) {
  const result = [];
  walk(ast, node => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || text(node.expression.expression) !== receiver || node.expression.name.text !== method) return;
    const [channel, handler] = node.arguments;
    if (!channel || !ts.isStringLiteralLike(channel) || !handler) return;
    result.push({ file, channel: channel.text, node, handler });
  });
  return result;
}

const RELEASE = {
  'window:set-titlebar-theme': 'No retained resource. Missing/destroyed main window returns success:false without error.',
  'settings:get': 'Read only; corrupt JSON is backed up to .bak and default DB is returned.',
  'settings:set': 'Replace settings; write temp then rename. Existing write failure is logged but handler still returns success:true.',
  'settings:get-webview-preload': 'Returns file URL for the existing compiled page preload.',
  'ai:discover-models': 'No subscription. Normalize /models endpoint; de-duplicate/sort IDs and retain at most 500. fetchText timeout and redirect policy apply.',
  'diagnostics:get-error-log-path': 'Read only; returns current error-log path string.',
  'diagnostics:get-recent-error-logs': 'Read only; default 80, clamp 1..300, newest first; malformed lines preserved as diagnostic entries.',
  'app:check-update': 'No installation. Prefer redirected Releases page; API fallback; network failure is success:true/hasUpdate:false with warning and Releases URL.',
  'app:open-url': 'Only http/https; external opener errors reject the invocation (no catch wrapper).',
  'browser:open-internal-tab': 'Validate navigation policy then emit browser:open-tab; no navigation or subscription retained by handler.',
  'cloud-bank:list': '404 is an empty successful manifest with warning; all other HTTP/JSON failures return success:false.',
  'cloud-bank:download': 'Only banks/<single-file>.json; accept JSON array or entries array. No local DB write.',
  'cloud-bank:upload': 'Token/name/nonempty entries required. Read existing manifest first; only 404 creates a new manifest. Write bank before manifest; newest entry first, max 200.',
  'app:notify': 'Title max 80/body max 240. System notification is silent:false; unsupported API returns success:false.',
  'session:get-webview-state': 'Read persist:studypilot-sites partition identity, persistent flag and storagePath.',
  'session:clear-webview-login': 'Await clearStorageData then clearCache; failure rejects invocation. No promise to preserve login after this method.',
  'browser:navigate': 'Compatibility acknowledgement only; returns URL. Renderer owns real navigation.',
  'glass:capture': 'Only visible/non-minimized main-frame caller and its live webview; region <=8192 each dimension, output <=1200 each dimension. Rejection/failure returns empty object, never captures shell.',
  'browser:screenshot': 'Capture mainWindow surface (optionally rect) to PNG data URL. Distinct from glass guest capture.',
  'automation:snapshot': 'Placeholder acknowledgement only; must not gain execution behavior during migration.',
  'automation:execute-plan': 'Placeholder success echo of payload only; must not gain execution behavior during migration.',
  'ai:chat': 'POST /chat/completions. timeout clamp 5000..120000 (default 60000), abort request on timeout. Resolve once. SSE sends requestId/chunk until end; non-SSE returns complete text with json:true. Sender destruction drops chunks; legacy API has no cancel method. Known defect LEGACY-AI-UTF8-001: independent Buffer.toString(utf8) can corrupt split UTF-8 characters. This observation is not desired new-host behavior; see compatibilityDecisions.LEGACY-AI-UTF8-001 for the explicit decision required before R5/G4.',
  'web-ai:lease-task': 'Only owning main-window sender and owned live webviews at exact sourceUrl. Retain original background-throttling and refcount host/source/AI; shared initialization must settle before acknowledgement. Confirmed GET navigation opens new tab; unknown/POST blocked.',
  'web-ai:release-task': 'Validate owning caller/session token; idempotent missing-session success. Abort pending reads, clear image bytes/cache, remove last navigation/destroyed listeners, disable document intent and restore previous throttling when refcount reaches zero.',
  'web-ai:read-question-media': 'Only leased task/document and validated question/material element; per image 8 MiB raw, per task 32 MiB raw, default 10000ms. Cache questionHash:mediaId; SHA-256 digest; credentials belong to source. Same-origin GET redirect <=5; validated DOM screenshot fallback. Release/destruction/source change/timeout rejects stale work; timers/abort listeners always released.'
};

const PAGE_SCHEMAS = {
  'studypilot:snapshot': { request: 'none', reply: 'studypilot:snapshot-result', response: '{success:true,data:PageSnapshot}|{success:false,error:string}', release: 'Single reply; document DOM only. First 80 visible controls, original selectors and labels.' },
  'studypilot:web-document-request': { request: 'renew?:boolean', reply: 'studypilot:web-document', response: 'documentId:string', release: 'renew regenerates identity. A document load creates a fresh identity.' },
  'studypilot:web-cancel-operation': { request: 'operationId:string', reply: null, response: 'none', release: 'Cancellation marker expires after 60000ms. Underlying queued page write barrier remains until settlement.' },
  'studypilot:extract-question': { request: 'payload?:{sessionId?:string,operationId?:string,targetTabId?:string,documentId?:string}', reply: 'studypilot:question-result', response: '{success:true,data:QuestionPayload,questions:QuestionPayload[],...identity} | {success:false,error:string,...identity}', release: 'operationId requires matching documentId. sessionId enables webEnhanced capture. No questions returns explicit error.' },
  'studypilot:execute-plan': { request: 'plan:AutomationPlan', reply: 'studypilot:execute-result', response: '{success:true,message:string}|{success:false,error:string}', release: 'Unlike main-process placeholder, page implementation requires approved:true and runs ordered steps.' },
  'studypilot:apply-answer': { request: 'payload:AnswerApplyPayload & {operationId?:string,documentId?:string,expiresAt?:number,sessionId?:string,targetTabId?:string}', reply: 'studypilot:apply-answer-result', response: 'Inferred ReturnType<applyAnswerV2> from frozen source; optional identity {sessionId,operationId,targetTabId,documentId}; thrown error is {success:false,error:string}', release: 'Reject wrong document/cancelled/expired operation. Serialize only operationId writes through webApplyQueue; remove cancellation marker in finally. Host cancellation cannot end actual page-side write barrier.' },
  'studypilot:exam-next-question': { request: 'none', reply: 'studypilot:exam-next-question-result', response: '{success:boolean,done?:boolean,message?:string,error?:string}', release: 'Single asynchronous reply. Click after 180ms; poll every 250ms for at most 7000ms. Full-preview final page returns done:true; no submit action.' }
};

/** The checker binds references in their actual lexical scope and module.
 * Only baseline source is visible; external package functions stay opaque.
 * A local alias or duplicate implementation that cannot be resolved fails closed.
 */
export function createFunctionResolver(read, files) {
  const prefix = '/__studypilot_baseline__/', sources = new Map(), available = new Set(files.map(file => prefix + file));
  for (const file of sorted(files.filter(file => /\.[cm]?[jt]sx?$/.test(file)))) sources.set(prefix + file, canonicalBytes(read(file)).toString('utf8'));
  const absolute = file => file.replaceAll('\\', '/');
  const relative = file => absolute(file).replace(prefix, '');
  const resolveImport = (specifier, containingFile) => {
    if (!specifier.startsWith('.')) return undefined;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(absolute(containingFile)), specifier));
    if (available.has(base) && !/\.[cm]?[jt]sx?$/.test(base)) return undefined;
    const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs'].map(extension => base + extension), ...['.ts', '.tsx', '.js', '.jsx'].map(extension => `${base}/index${extension}`)];
    const found = candidates.filter(candidate => sources.has(candidate));
    if (found.length !== 1) throw new Error(`Ambiguous or missing local module ${specifier} from ${relative(containingFile)}: ${found.length} candidates`);
    const resolvedFileName = found[0];
    return { resolvedFileName, extension: resolvedFileName.endsWith('.tsx') ? ts.Extension.Tsx : resolvedFileName.endsWith('.ts') ? ts.Extension.Ts : ts.Extension.Js };
  };
  const host = {
    getSourceFile: (file, languageVersion) => sources.has(absolute(file)) ? ts.createSourceFile(absolute(file), sources.get(absolute(file)), languageVersion, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS) : undefined,
    readFile: file => sources.get(absolute(file)), fileExists: file => sources.has(absolute(file)),
    getDefaultLibFileName: () => prefix + 'no-lib.d.ts', writeFile: () => {}, getCurrentDirectory: () => prefix,
    getCanonicalFileName: absolute, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
    resolveModuleNames: (names, containingFile) => names.map(name => resolveImport(name, containingFile))
  };
  const program = ts.createProgram([...sources.keys()], { noLib: true, allowJs: true, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve }, host);
  const checker = program.getTypeChecker();
  const id = node => `${relative(node.getSourceFile().fileName)}:${node.pos}:${node.end}`;
  function fromSymbol(symbol, seen = new Set()) {
    if (!symbol || seen.has(symbol)) return [];
    seen.add(symbol);
    if (symbol.flags & ts.SymbolFlags.Alias) {
      const alias = checker.getAliasedSymbol(symbol);
      const localImport = symbol.declarations?.some(declaration => {
        let parent = declaration;
        while (parent && !ts.isImportDeclaration(parent) && !ts.isExportDeclaration(parent)) parent = parent.parent;
        return parent?.moduleSpecifier && ts.isStringLiteralLike(parent.moduleSpecifier) && parent.moduleSpecifier.text.startsWith('.');
      });
      if (localImport && !alias?.declarations?.length) throw new Error(`Unresolved local function alias ${symbol.name}`);
      return fromSymbol(alias, seen);
    }
    const implementations = [];
    for (const declaration of symbol.declarations || []) {
      if (ts.isFunctionDeclaration(declaration) && declaration.body) implementations.push(declaration);
      else if (ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration)) {
        const initializer = declaration.initializer;
        if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) implementations.push(initializer);
        else if (initializer && (ts.isIdentifier(initializer) || ts.isPropertyAccessExpression(initializer))) implementations.push(...fromSymbol(checker.getSymbolAtLocation(ts.isPropertyAccessExpression(initializer) ? initializer.name : initializer), seen));
      } else if (ts.isShorthandPropertyAssignment(declaration)) implementations.push(...fromSymbol(checker.getShorthandAssignmentValueSymbol(declaration), seen));
      else if (ts.isMethodDeclaration(declaration) && declaration.body) implementations.push(declaration);
    }
    const distinct = [...new Map(implementations.map(node => [id(node), node])).values()];
    if (distinct.length > 1) throw new Error(`Ambiguous function implementation ${symbol.name}: ${distinct.map(id).join(', ')}`);
    return distinct;
  }
  const resolve = expression => fromSymbol(checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expression) ? expression.name : expression));
  return {
    ast: file => { const ast = program.getSourceFile(prefix + file); if (!ast) throw new Error(`Source absent from lexical graph: ${file}`); return ast; },
    resolve,
    describe: node => ({ id: id(node), file: relative(node.getSourceFile().fileName), name: node.name ? text(node.name) : node.parent?.name ? text(node.parent.name) : '<anonymous>', ...location(node), astSha256: astHash(node) })
  };
}

function details(entry, resolver) {
  const parameters = entry.handler.parameters?.map(parameter => text(parameter)) || [];
  const rootNames = new Set(entry.handler.parameters?.map(parameter => text(parameter.name)) || []);
  const access = [], returns = [], errors = [], deliveries = [], reachable = new Map();
  const pending = [entry.handler];
  while (pending.length) {
    const current = pending.pop();
    walk(current, node => {
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        let root = node; while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = root.expression;
        if (ts.isIdentifier(root) && rootNames.has(root.text)) access.push(text(node));
      }
      if (ts.isReturnStatement(node) && node.expression && !ts.isFunctionLike(node.expression)) returns.push(text(node.expression).length < 1600 ? text(node.expression) : `<${ts.SyntaxKind[node.expression.kind]}:see-source>`);
      if (ts.isPropertyAssignment(node) && text(node.name) === 'error') errors.push(text(node.initializer));
      if (ts.isCallExpression(node)) {
        if ((ts.isIdentifier(node.expression) && ['failure', 'Error'].includes(node.expression.text)) && node.arguments[0]) errors.push(text(node.arguments[0]));
        if (ts.isPropertyAccessExpression(node.expression) && ['send', 'sendToHost', 'resolve', 'finish'].includes(node.expression.name.text)) deliveries.push(text(node));
        if (ts.isIdentifier(node.expression) && ['resolve', 'finish'].includes(node.expression.text)) deliveries.push(text(node));
        const references = [node.expression];
        if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'toString') references.push(node.expression.expression);
        for (const argument of node.arguments) if (ts.isIdentifier(argument) || ts.isPropertyAccessExpression(argument)) references.push(argument);
        for (const reference of references) for (const implementation of resolver.resolve(reference)) {
          const description = resolver.describe(implementation);
          if (!reachable.has(description.id)) { reachable.set(description.id, description); pending.push(implementation); }
        }
      }
      if (ts.isNewExpression(node) && text(node.expression) === 'Error' && node.arguments?.[0]) errors.push(text(node.arguments[0]));
    });
  }
  return { parameters, payloadAccessPaths: sorted(access), returnExpressions: sorted(returns), errorExpressions: sorted(errors), deliveries: sorted(deliveries), referencedFunctions: [...reachable.values()].sort((left, right) => left.id.localeCompare(right.id, 'en')) };
}

export function createApiContract(read, dependencyFiles = []) {
  const sources = ['electron/preload.ts', 'electron/main.ts', 'electron/web-ai-task-resources.ts', 'electron/preload-webview.ts'];
  const resolver = createFunctionResolver(read, sorted([...sources, ...dependencyFiles.filter(file => /^(?:src|electron)\//.test(file))]));
  const handles = sources.flatMap(file => registrations(file, read(file).toString('utf8'), 'ipcMain', 'handle', resolver.ast(file)));
  const requests = handles.map(entry => ({ channel: entry.channel, file: entry.file, ...location(entry.node), astSha256: astHash(entry.node), ...details(entry, resolver), release: RELEASE[entry.channel] || 'Unclassified: migration must stop.' }));
  const hostEvents = sources.flatMap(file => registrations(file, read(file).toString('utf8'), 'ipcMain', 'on', resolver.ast(file))).map(entry => ({ channel: entry.channel, file: entry.file, ...location(entry.node), ...details(entry, resolver), release: 'One-way event, no reply or request resource. Process-level handler lives until application shutdown.' }));
  const pageRequests = registrations('electron/preload-webview.ts', read('electron/preload-webview.ts').toString('utf8'), 'ipcRenderer', 'on', resolver.ast('electron/preload-webview.ts')).map(entry => ({ channel: entry.channel, file: entry.file, ...location(entry.node), ...PAGE_SCHEMAS[entry.channel], ...details(entry, resolver) }));
  const methods = [];
  walk(parse(sources[0], read(sources[0]).toString('utf8')), node => {
    if (!ts.isCallExpression(node) || text(node.expression) !== 'contextBridge.exposeInMainWorld' || !node.arguments[1] || !ts.isObjectLiteralExpression(node.arguments[1])) return;
    for (const property of node.arguments[1].properties) {
      if (!ts.isPropertyAssignment(property)) throw new Error('Unexpected preload facade property');
      const bindings = [];
      walk(property.initializer, child => {
        if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression) && text(child.expression.expression) === 'ipcRenderer' && child.arguments[0] && ts.isStringLiteralLike(child.arguments[0])) bindings.push({ kind: child.expression.name.text, channel: child.arguments[0].text });
      });
      methods.push({ name: text(property.name), parameters: property.initializer.parameters?.map(parameter => text(parameter)) || [], bindings, ...location(property), release: bindings.some(binding => binding.kind === 'on') ? 'Returns unsubscribe function removing exactly this subscription via removeListener; callback receives payload without Electron event.' : bindings.some(binding => binding.kind === 'send') ? 'One-way, void return.' : RELEASE[bindings[0]?.channel], sourceSha256: sha256(canonicalBytes(Buffer.from(text(property)))) });
    }
  });
  const schemas = [];
  const schemaFiles = ['electron/web-ai-task-resources.ts', 'src/store/appStore.ts', 'electron/preload-webview/types.ts'];
  for (const file of schemaFiles) {
    let content; try { content = read(file).toString('utf8'); } catch { continue; }
    walk(parse(file, content), node => { if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name) schemas.push({ name: node.name.text, file, ...location(node), declaration: text(node) }); });
  }
  const counts = { preloadMethods: methods.length, requestHandlers: requests.length, oneWayEvents: hostEvents.length, pageRequests: pageRequests.length };
  if (JSON.stringify(counts) !== JSON.stringify({ preloadMethods: 34, requestHandlers: 25, oneWayEvents: 5, pageRequests: 7 })) throw new Error(`API inventory drift: ${JSON.stringify(counts)}`);
  return { schemaVersion: 1, baselineCommit: BASELINE_COMMIT, counts, semantics: 'Observed legacy behavior reference, not an implementation claim or an instruction to reproduce known defects. Source expressions preserve untyped payloads and lexically resolved transitive helper errors; missing a Rust implementation is never a successful empty result.', compatibilityDecisions: { 'LEGACY-AI-UTF8-001': { status: 'explicit-decision-required-before-R5-and-G4', kind: 'known-defect', source: 'electron/main.ts:1486', observation: 'Buffer.toString(utf8) on independent SSE chunks corrupts characters split across buffers.', desiredInvariant: 'Valid UTF-8 characters must survive arbitrary network byte chunk boundaries.', requiredDecision: 'Record an explicitly reviewed host transport deviation to use a streaming decoder, or document an approved temporary compatibility policy. The R0 observed corruption fixture does not approve reproducing this defect in Rust.', evidence: '.playwright-mcp/rust-baseline/transport-fixtures.json#/knownDefects/LEGACY-AI-UTF8-001' } }, methods, requestHandlers: requests, oneWayEvents: hostEvents, pageRequests, schemas };
}

export function createSnapshot(root = process.cwd()) {
  const tracked = git(root, ['ls-tree', '-r', '--name-only', '-z', BASELINE_COMMIT]).toString('utf8').split('\0').filter(Boolean);
  const cache = new Map();
  const read = file => { if (!cache.has(file)) cache.set(file, git(root, ['show', `${BASELINE_COMMIT}:${file}`])); return cache.get(file); };
  const roots = tracked.filter(file => /^(src|electron|tests)\//.test(file));
  const allGraph = dependencyGraph(tracked.filter(file => /\.(?:[cm]?[jt]sx?|css)$/.test(file)), read, tracked);
  const included = new Set(roots);
  let grew = true;
  while (grew) { grew = false; for (const edge of allGraph.entries) if (included.has(edge.from) && !included.has(edge.to)) { included.add(edge.to); grew = true; } }
  const files = [...included].sort().map(file => ({ path: file, bytes: read(file).length, gitBlob: git(root, ['rev-parse', `${BASELINE_COMMIT}:${file}`]).toString().trim(), sha256: sha256(read(file)), canonicalSha256: sha256(canonicalBytes(read(file))), role: MIXED_FILES.includes(file) ? 'mixed-reference' : file.startsWith('tests/') ? 'existing-regression' : 'frozen-source' }));
  const uiChanges = git(root, ['diff-tree', '--no-commit-id', '--name-status', '-r', BASELINE_COMMIT]).toString('utf8').trim().split(/\r?\n/).filter(Boolean).map(line => { const [status, file] = line.split('\t'); return { status, path: file, sha256: sha256(read(file)), bytes: read(file).length }; });
  const manifest = { schemaVersion: 1, baselineCommit: BASELINE_COMMIT, hashPolicy: 'SHA-256 of immutable Git blob bytes plus SHA-256 after CRLF-to-LF only for valid UTF-8. Binary bytes remain exact. Verifier accepts LF/CRLF checkout conversion and rejects every other byte change.', roots, strictDirectories: STRICT_DIRECTORIES, files, dependencyEdges: allGraph.entries.filter(edge => included.has(edge.from)), externalImports: allGraph.external, unresolvedRelativeImports: allGraph.unresolved.filter(edge => included.has(edge.from)) };
  if (manifest.unresolvedRelativeImports.length) throw new Error(`Unresolved frozen dependency: ${JSON.stringify(manifest.unresolvedRelativeImports)}`);
  const boundary = { schemaVersion: 1, baselineCommit: BASELINE_COMMIT, defaultClassification: 'core', policy: 'All original mixed-file bytes also remain frozen. Classification authorizes new host adapters, never editing/copy-rewriting core. AST extraction must retain source hashes. Unlisted symbols are core.', allowedBuildTransforms: buildTransforms(read), files: MIXED_FILES.map(file => ({ path: file, sourceSha256: sha256(read(file)), canonicalSha256: sha256(canonicalBytes(read(file))), symbols: symbolsFor(file, read(file).toString('utf8')) })) };
  const behaviors = [
    { behavior: 'tab-switch-and-source-ownership', file: 'tests/web-ai-sessions.test.ts', test: 'restores the source owner on AI tab selection and protects retryable identity' },
    { behavior: 'unanswered-skip', file: 'tests/web-ai-controller.test.ts', test: 'skips exhausted missing answers and fills the valid answers without stopping the task' },
    { behavior: 'out-of-order-and-duplicate-replies', file: 'tests/web-ai-page-requests.test.ts', test: 'routes reversed replies and ignores other tabs, documents and duplicate replies' },
    { behavior: 'source-invalidated', file: 'tests/web-ai-page-requests.test.ts', test: 'invalidates inflight operations on navigation without cancelling another session' },
    { behavior: 'image-byte-quotas', file: 'tests/web-ai-task-resources.test.ts', test: 'rejects non-images and limits streamed individual and total task bytes' },
    { behavior: 'question-bank-import-export', file: 'tests/appstore.test.ts', test: '保留 %s 的原始题型并支持导入导出' }
  ].map(item => ({ ...item, sourceSha256: sha256(read(item.file)), evidence: '.playwright-mcp/rust-baseline/tests-before.log', outcome: 'See fresh command result; frozen test assertions and input fixtures are the executable baseline.' }));
  const api = createApiContract(read, tracked);
  const buildInputs = ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.electron.json', 'vite.config.ts', 'scripts/build-webview-preload.mjs'].filter(file => tracked.includes(file)).map(file => ({ path: file, sha256: sha256(read(file)), canonicalSha256: sha256(canonicalBytes(read(file))) }));
  const baseline = { schemaVersion: 1, baselineCommit: BASELINE_COMMIT, baselineParent: git(root, ['rev-parse', `${BASELINE_COMMIT}^`]).toString().trim(), applicationVersion: JSON.parse(read('package.json')).version, workingTreePolicy: `Reviewed UI source is anchored at immutable commit ${BASELINE_COMMIT}. Only that commit is read by this generator. Untracked files are excluded. Do not regenerate from HEAD to bless drift.`, preservedChanges: uiChanges, buildInputs, behaviorFixtures: [...behaviors, { behavior: 'streaming-json-sse-and-timeout', file: 'tests/contracts/core-freeze.test.ts', test: 'records legacy JSON, SSE byte chunks and request cleanup using the original AST handler', evidence: '.playwright-mcp/rust-baseline/transport-fixtures.json' }], validationDirectory: '.playwright-mcp/rust-baseline', documentHashes: { coreManifest: sha256(JSON.stringify(manifest)), symbolBoundary: sha256(JSON.stringify(boundary)), apiContract: sha256(JSON.stringify(api)) } };
  return { baseline, manifest, boundary, api };
}

export function writeSnapshot(root = process.cwd()) {
  const snapshot = createSnapshot(root), directory = path.join(root, DOCUMENT_DIRECTORY);
  mkdirSync(directory, { recursive: true });
  for (const [name, value] of [['baseline', snapshot.baseline], ['core-manifest', snapshot.manifest], ['symbol-boundary', snapshot.boundary], ['api-contract', snapshot.api]]) writeFileSync(path.join(directory, `${name}.json`), JSON.stringify(value, null, 2) + '\n');
  const fixtures = path.join(root, '.playwright-mcp/rust-baseline/behavior-fixtures');
  mkdirSync(fixtures, { recursive: true });
  for (const file of sorted(snapshot.baseline.behaviorFixtures.filter(item => !item.file.startsWith('tests/contracts/')).map(item => item.file))) {
    writeFileSync(path.join(fixtures, path.basename(file) + '.txt'), git(root, ['show', `${BASELINE_COMMIT}:${file}`]));
  }
  writeFileSync(path.join(fixtures, 'index.json'), JSON.stringify(snapshot.baseline.behaviorFixtures, null, 2) + '\n');
  return snapshot;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--write')) throw new Error('Use --write to generate the immutable reviewed baseline; verification uses verify-core-freeze.mjs.');
  const snapshot = writeSnapshot();
  console.log(`Frozen ${snapshot.manifest.files.length} files at ${BASELINE_COMMIT}; ${snapshot.boundary.files.reduce((sum, file) => sum + file.symbols.length, 0)} mixed-file symbols; API ${JSON.stringify(snapshot.api.counts)}`);
}
