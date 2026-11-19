import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { BASELINE_COMMIT, canonicalBytes, sha256 } from './freeze-core.mjs';
import { verifyCoreFreeze } from './verify-core-freeze.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const CONSTANTS=['BLOCKED_INTERNAL_TAB_URL','BLOCKED_STAT_KNOWLEDGE_URL','INCOMPLETE_EXAM_LIST_PATH'];
const FUNCTIONS=['shouldBlockInternalTabUrl','shouldDropStatKnowledgeUrl','isIncompleteExamListUrl','isExamListUrl','frameClickBridgeSource'];

export function extractNavigationIntent(source){
  const file='electron/web-ai-task-resources.ts',manifest=JSON.parse(readFileSync(path.join(root,'docs/migrations/rust-host/core-manifest.json'),'utf8'));
  const sourceSha256=sha256(canonicalBytes(Buffer.from(source)));
  if(sourceSha256!==manifest.files.find(entry=>entry.path===file).canonicalSha256)throw new Error('Frozen task navigation intent source changed');
  const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true),matches=[];
  const visit=node=>{if(ts.isTemplateExpression(node)&&node.head.text.includes('const s = window.__studyPilotTaskNavigation;'))matches.push(node);ts.forEachChild(node,visit);};visit(ast);
  if(matches.length!==1)throw new Error('Frozen task navigation intent template count mismatch');
  const template=matches[0];
  if(template.templateSpans.length!==1||template.templateSpans[0].expression.getText(ast)!=='JSON.stringify(url)')throw new Error('Unexpected task navigation intent binding');
  const original=template.getText(ast),binding={head:template.head.text,tail:template.templateSpans[0].literal.text};
  const factorySource=ts.transpile(`(function(url: string){ return ${original}; })`,{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.None});
  return{factorySource,binding,manifest:{input:file,sourceSha256,templateSha256:sha256(canonicalBytes(Buffer.from(original))),factorySha256:sha256(Buffer.from(factorySource)),bindingSha256:sha256(Buffer.from(JSON.stringify(binding)))}};
}

export function extractNavigationPolicy(source){
  const manifest=JSON.parse(readFileSync(path.join(root,'docs/migrations/rust-host/core-manifest.json'),'utf8'));
  if(sha256(canonicalBytes(Buffer.from(source)))!==manifest.files.find(file=>file.path==='electron/main.ts').canonicalSha256)throw new Error('Frozen navigation policy source changed');
  const ast=ts.createSourceFile('electron/main.ts',source,ts.ScriptTarget.Latest,true),symbols=[];
  for(const name of [...CONSTANTS,...FUNCTIONS]){
    const nodes=ast.statements.flatMap(statement=>ts.isVariableStatement(statement)?statement.declarationList.declarations.filter(declaration=>declaration.name.getText(ast)===name):ts.isFunctionDeclaration(statement)&&statement.name?.text===name?[statement]:[]);
    if(nodes.length!==1)throw new Error(`Navigation policy symbol count mismatch: ${name}`);
    const node=nodes[0],original=node.getText(ast);
    symbols.push({name,source:ts.isVariableDeclaration(node)?`const ${original};`:original,sourceSha256:sha256(canonicalBytes(Buffer.from(original)))});
  }
  const typedFactory=`(function(){\n${symbols.map(symbol=>symbol.source).join('\n\n')}\nreturn Object.freeze({${FUNCTIONS.join(',')}});\n})`;
  const factorySource=ts.transpile(`const navigationPolicyFactory=${typedFactory};`,{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.None})+'\nnavigationPolicyFactory;\n';
  // Only the frozen pure function is evaluated in a sandbox. Its generated
  // website script is written verbatim and never executed by this builder.
  const policy=runInNewContext(factorySource,{URL});
  const frameClickSource=policy().frameClickBridgeSource();
  if(typeof frameClickSource!=='string'||!frameClickSource.includes('__studyPilotFrameClickBridge'))throw new Error('Frozen frame click bridge did not produce its original script');
  const callableSource=`(${ts.transpile(`const factory=${typedFactory};`,{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.None}).replace(/^const factory\s*=\s*/,'').trim().replace(/;$/,'')})\n`;
  return{factorySource:callableSource,frameClickSource,manifest:{schemaVersion:1,baselineCommit:BASELINE_COMMIT,input:'electron/main.ts',inputSha256:sha256(canonicalBytes(Buffer.from(source))),
    symbols:symbols.map(({name,sourceSha256})=>({name,sourceSha256})),factorySha256:sha256(Buffer.from(callableSource)),frameClickSha256:sha256(Buffer.from(frameClickSource)),
    transport:'The original frame-click script posts the original frame messages; original preload navigation.ts receives and validates them.',
    limitation:'This artifact does not implement a synchronous Rust on_navigation URL classifier or task-lease navigation interception. Those remain R4 acceptance requirements.'}};
}

export function buildNavigationPolicy({write=true,verify=true}={}){
  if(verify){const result=verifyCoreFreeze(root);if(!result.ok)throw new Error(`Core freeze failed: ${result.errors.join('; ')}`);}
  const built=extractNavigationPolicy(readFileSync(path.join(root,'electron/main.ts'),'utf8'));
  const intent=extractNavigationIntent(readFileSync(path.join(root,'electron/web-ai-task-resources.ts'),'utf8'));
  built.intent=intent;built.manifest.intent=intent.manifest;
  if(write){const directory=path.join(root,'dist-rust-navigation');mkdirSync(directory,{recursive:true});
    writeFileSync(path.join(directory,'policy-factory.js'),built.factorySource);writeFileSync(path.join(directory,'frame-click.js'),built.frameClickSource);
    writeFileSync(path.join(directory,'navigation-intent-predicate.js'),intent.factorySource);writeFileSync(path.join(directory,'navigation-intent-template.json'),JSON.stringify(intent.binding));
    writeFileSync(path.join(directory,'navigation-policy.manifest.json'),JSON.stringify(built.manifest,null,2)+'\n');}
  return built;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const built=buildNavigationPolicy();console.log(`Extracted ${built.manifest.symbols.length} original navigation declarations and the unchanged frame click bridge`);
}
