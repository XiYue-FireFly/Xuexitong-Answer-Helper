import {spawnSync} from 'node:child_process';
import {mkdirSync,copyFileSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {verifyCoreFreeze} from './verify-core-freeze.mjs';
const guard=verifyCoreFreeze();if(!guard.ok)throw Error(JSON.stringify(guard.errors));
function run(command,args){const r=spawnSync(command,args,{stdio:'inherit',windowsHide:true});if(r.status!==0)throw Error(`${command} failed (${r.status})`);}
run(process.execPath,['scripts/build-rust-page-bridge.mjs']);
run(process.execPath,['scripts/build-rust-host-policies.mjs']);
run(process.execPath,['scripts/build-rust-media-policy.mjs']);
run(process.execPath,['scripts/build-rust-navigation-policy.mjs']);
run(process.execPath,['scripts/build-rust-ui.mjs']);
run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/rust-host-toolchain.ps1','-Action','build']);
const destination=path.resolve('release/rust/windows-ui-preview');mkdirSync(destination,{recursive:true});
const target=path.join(destination,'WISP-RS-Preview.exe');copyFileSync('src-tauri/target/debug/studypilot-rust-host-poc.exe',target);
writeFileSync(path.join(destination,'Start-Rust-Preview.cmd'),'@echo off\r\nset STUDYPILOT_RUST_DESKTOP=1\r\n"%~dp0WISP-RS-Preview.exe"\r\n');
const hash=createHash('sha256').update(readFileSync(target)).digest('hex');writeFileSync(path.join(destination,'SHA256SUMS.txt'),`${hash}  WISP-RS-Preview.exe\n`);
console.log(`Built independent Rust preview: ${destination}`);
