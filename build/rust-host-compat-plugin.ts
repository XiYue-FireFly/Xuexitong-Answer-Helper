import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import ts from 'typescript';
import type { Plugin } from 'vite';
import { astHash, canonicalBytes, sha256 } from '../scripts/freeze-core.mjs';

const root = path.resolve(__dirname, '..');
const boundary = JSON.parse(readFileSync(path.join(root, 'docs/migrations/rust-host/symbol-boundary.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(path.join(root, 'docs/migrations/rust-host/core-manifest.json'), 'utf8'));
const TARGETS = new Map<string, { id: string; local: string; imported: string; module: string }>([
  ['src/store/appStore.ts', { id: 'desktop-capability-detection', local: '__studyPilotIsRustHost', imported: 'isRustDesktopHost', module: '@rust-host/hostClient' }],
  ['src/components/BrowserPanel.tsx', { id: 'webview-component-connection', local: '__StudyPilotRustGuestView', imported: 'CompatGuestView', module: '@rust-host/CompatGuestView' }]
]);
const parse = (code: string, file: string) => ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const walk = (node: ts.Node, visit: (node: ts.Node) => void) => { visit(node); ts.forEachChild(node, child => walk(child, visit)); };
const print = (node: ts.Node) => canonicalBytes(Buffer.from(ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed }).printNode(ts.EmitHint.Unspecified, node, node.getSourceFile()))).toString();

function nodesFor(ast: ts.SourceFile, id: string, converted = false): ts.Node[] {
  const result: ts.Node[] = [];
  walk(ast, node => {
    if (id === 'desktop-capability-detection' && ts.isPropertyAssignment(node) && node.name.getText(ast) === 'isElectron') result.push(node);
    if (id === 'webview-component-connection' && ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === (converted ? '__StudyPilotRustGuestView' : 'webview')) result.push(node);
  });
  return result;
}

export function assertRustTransformBoundary(original: string, converted: string, file: string): void {
  const specification = TARGETS.get(file);
  if (!specification) { if (original !== converted) throw new Error(`Non-whitelisted Rust transform: ${file}`); return; }
  const before = parse(original, file), after = parse(converted, file);
  const originalNodes = nodesFor(before, specification.id), convertedNodes = nodesFor(after, specification.id, true);
  if (originalNodes.length !== 1 || convertedNodes.length !== 1) throw new Error(`Rust transform node count mismatch: ${file}`);
  const imports = after.statements.filter(statement => ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier) && statement.moduleSpecifier.text === specification.module);
  const expectedImport = `import { ${specification.imported} as ${specification.local} } from '${specification.module}';`;
  if (imports.length !== 1 || print(imports[0]) !== print(parse(expectedImport, file).statements[0])) throw new Error(`Rust adapter import mismatch: ${file}`);
  let reverted = converted;
  const target = convertedNodes[0], baseline = originalNodes[0];
  let edits: { start: number; end: number; value: string }[] = [{ start: imports[0].getFullStart(), end: imports[0].end, value: '' }];
  if (ts.isPropertyAssignment(target) && ts.isPropertyAssignment(baseline)) {
    if (target.initializer.getText(after) !== `${specification.local}()`) throw new Error(`Rust detector initializer mismatch: ${file}`);
    edits.push({ start: target.initializer.getStart(after), end: target.initializer.end, value: baseline.initializer.getText(before) });
  } else if (ts.isJsxSelfClosingElement(target) && ts.isJsxSelfClosingElement(baseline)) edits.push({ start: target.tagName.getStart(after), end: target.tagName.end, value: 'webview' });
  else throw new Error(`Unexpected Rust transform node: ${file}`);
  for (const edit of edits.sort((left, right) => right.start - left.start)) reverted = reverted.slice(0, edit.start) + edit.value + reverted.slice(edit.end);
  if (print(before) !== print(parse(reverted, file))) throw new Error(`Business AST changed outside Rust whitelist: ${file}`);
}

export function transformRustSource(code: string, file: string): string {
  const specification = TARGETS.get(file);
  const frozen = manifest.files.find((entry: { path: string }) => entry.path === file);
  if (frozen && sha256(canonicalBytes(Buffer.from(code))) !== frozen.canonicalSha256) throw new Error(`Frozen Rust transform input changed: ${file}`);
  const ast = parse(code, file);
  walk(ast, node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) && /^(?:electron|node:)/.test(node.moduleSpecifier.text)) throw new Error(`Unadapted runtime import in Rust UI: ${file}`);
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) && /^(?:electron|node:)/.test(node.arguments[0].text)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) throw new Error(`Unadapted runtime import in Rust UI: ${file}`);
  });
  if (!specification) return code;
  if (!frozen) throw new Error(`Frozen Rust transform input absent: ${file}`);
  const allow = boundary.allowedBuildTransforms.find((entry: { id: string }) => entry.id === specification.id);
  const nodes = nodesFor(ast, specification.id);
  if (!allow || nodes.length !== allow.count || allow.count !== 1 || astHash(nodes[0]) !== allow.targets[0].astSha256) throw new Error(`Pinned Rust AST node mismatch: ${file}`);
  let collision = false;
  walk(ast, node => { if (ts.isIdentifier(node) && node.text === specification.local) collision = true; });
  if (collision) throw new Error(`Rust adapter binding collision: ${file}`);
  const target = nodes[0];
  const replace = ts.isPropertyAssignment(target) ? target.initializer : ts.isJsxSelfClosingElement(target) ? target.tagName : undefined;
  if (!replace) throw new Error(`Unsupported Rust AST target: ${file}`);
  const replacement = specification.id === 'desktop-capability-detection' ? `${specification.local}()` : specification.local;
  const converted = `import { ${specification.imported} as ${specification.local} } from '${specification.module}';\n` + code.slice(0, replace.getStart(ast)) + replacement + code.slice(replace.end);
  assertRustTransformBoundary(code, converted, file);
  return converted;
}

export default function rustHostCompatPlugin(): Plugin {
  const seen = new Set<string>();
  return {
    name: 'rust-host-pinned-compat', enforce: 'pre',
    buildStart() {
      execFileSync(process.execPath, [path.join(root, 'scripts/verify-core-freeze.mjs')], { cwd: root, windowsHide: true, stdio: 'pipe', maxBuffer: 4 * 1024 * 1024 });
    },
    transform(code, id) {
      const absolute = id.split('?')[0];
      if (!/\.[jt]sx?$/.test(absolute) || absolute.includes('/node_modules/') || absolute.includes('\\node_modules\\')) return;
      const file = path.relative(root, absolute).replaceAll('\\', '/');
      const converted = transformRustSource(code, file);
      if (!TARGETS.has(file)) return;
      seen.add(file); return { code: converted, map: null };
    },
    buildEnd(error) { if (!error) for (const file of TARGETS.keys()) if (!seen.has(file)) throw new Error(`Required Rust AST adapter was not built: ${file}`); }
  };
}
