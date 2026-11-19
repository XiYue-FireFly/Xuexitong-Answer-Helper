import ts from 'typescript';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { verifyCoreFreeze } from './verify-core-freeze.mjs';
const frozen=verifyCoreFreeze();if(!frozen.ok)throw Error(JSON.stringify(frozen.errors));
const input='electron/main.ts', source=readFileSync(input,'utf8');
const ast=ts.createSourceFile(input,source,ts.ScriptTarget.Latest,true);
const fn=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='readDB');
const result=fn?.body?.statements.find(node=>ts.isReturnStatement(node));
if(!result?.expression||!ts.isObjectLiteralExpression(result.expression))throw Error('Frozen readDB default object changed');
const text=result.expression.getText(ast),properties=result.expression.properties;
const defaults={};
for(const property of properties){
  if(!ts.isPropertyAssignment(property))throw Error('Unsupported default database shape');
  const value=property.initializer;
  defaults[property.name.getText(ast)]=value.kind===ts.SyntaxKind.NullKeyword?null:ts.isArrayLiteralExpression(value)&&value.elements.length===0?[]:(()=>{throw Error('Unsupported default value')})();
}
mkdirSync('dist-rust-bridge',{recursive:true});
writeFileSync('dist-rust-bridge/default-database.json',JSON.stringify(defaults));
writeFileSync('dist-rust-bridge/host-policies.manifest.json',JSON.stringify({input,symbol:'readDB:default-return',sourceSha256:createHash('sha256').update(source).digest('hex'),expression:text},null,2));
console.log('Extracted frozen database defaults without rewriting schema');
