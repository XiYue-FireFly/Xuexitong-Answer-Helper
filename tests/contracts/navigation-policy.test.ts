import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { extractNavigationIntent, extractNavigationPolicy } from '../../scripts/build-rust-navigation-policy.mjs';

describe('original native-host navigation policy extraction',()=>{
  it('reuses exact frozen function spans and the original frame bridge output',()=>{
    const source=readFileSync('electron/main.ts','utf8'),built=extractNavigationPolicy(source);
    const ast=ts.createSourceFile('main.ts',source,ts.ScriptTarget.Latest,true);
    const original=ast.statements.find((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node)&&node.name?.text==='frameClickBridgeSource')!;
    const evaluate=ts.transpile(original.getText(ast)+'\nframeClickBridgeSource();',{target:ts.ScriptTarget.ES2020});
    expect(built.frameClickSource).toBe(runInNewContext(evaluate));
    expect(built.manifest.symbols).toHaveLength(8);
    expect(()=>extractNavigationPolicy(source.replace('const BLOCKED_INTERNAL_TAB_URL =','const BLOCKED_INTERNAL_TAB_URL = /altered/; const changed ='))).toThrow('Frozen navigation policy source changed');
    expect(built.manifest.limitation).toContain('remain R4 acceptance requirements');
  });

  it('keeps original blocked URLs, incomplete exam list and stat knowledge decisions',()=>{
    const built=extractNavigationPolicy(readFileSync('electron/main.ts','utf8'));
    const factory=runInNewContext(built.factorySource,{URL}),policy=factory();
    expect(policy.shouldBlockInternalTabUrl('https://course.test/mooc-ans/work/submit')).toBe(true);
    expect(policy.shouldBlockInternalTabUrl('https://course.test/work/list')).toBe(false);
    expect(policy.shouldDropStatKnowledgeUrl('https://stat2-ans.chaoxing.com/study-knowledge/ans')).toBe(true);
    expect(policy.isIncompleteExamListUrl('https://course.test/exam-ans/mooc2/exam/exam-list')).toBe(true);
    expect(policy.isIncompleteExamListUrl('https://course.test/exam-ans/mooc2/exam/exam-list?courseId=7')).toBe(false);
    expect(policy.isExamListUrl('https://course.test/exam-ans/mooc2/exam/exam-list?courseId=7')).toBe(true);
  });

  it('preserves the exact source-only GET intent window and URL JSON transport binding',()=>{
    const original=readFileSync('electron/web-ai-task-resources.ts','utf8'),built=extractNavigationIntent(original);
    const factory=runInNewContext(built.factorySource,{JSON}),target='https://source.test/next?value="escaped"';
    const script=factory(target);
    expect(script).toBe(built.binding.head+JSON.stringify(target)+built.binding.tail);
    const now=123456;
    const evaluate=(state:unknown)=>runInNewContext(script,{window:{__studyPilotTaskNavigation:state},Date:{now:()=>now}});
    expect(evaluate({method:'GET',url:target,at:now-2999})).toBe(true);
    expect(evaluate({method:'GET',url:target,at:now-3000})).toBe(false);
    expect(evaluate({method:'POST',url:target,at:now})).toBe(false);
    expect(evaluate({method:'GET',url:'https://other.test/',at:now})).toBe(false);
    expect(()=>extractNavigationIntent(original.replace('s.method === \'GET\'','s.method === \'POST\''))).toThrow('Frozen task navigation intent source changed');
  });
});
