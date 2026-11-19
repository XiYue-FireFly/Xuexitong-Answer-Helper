import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright-core');
const root = process.cwd(), out = path.resolve('.playwright-mcp/rust-host-native');
mkdirSync(out, { recursive: true });
const executable = path.resolve(process.env.RUST_HOST_EXE || 'src-tauri/target/debug/studypilot-rust-host-poc.exe');
const port = 9333;
const child = spawn(executable, ['--poc'], { cwd: root, windowsHide: true, env: { ...process.env,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, stdio: ['ignore','pipe','pipe'] });
const logs = []; child.stdout.on('data', data => logs.push(data.toString())); child.stderr.on('data', data => logs.push(data.toString()));
const native = payload => {
  const data = Buffer.from(JSON.stringify({ processId: child.pid, ...payload })).toString('base64');
  const result = execFileSync('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/rust-host-native-input.ps1'),'-PayloadBase64',data],
    { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  return payload.action === 'windows' ? JSON.parse(result) : result;
};
const reports = [], errors = [];
const pass = (name, details={}) => { reports.push({ name, passed: true, ...details }); console.log('PASS',name); };
let browser, ui, guest;
try {
  let connected;
  for (let attempt=0;attempt<80&&!connected;attempt++) {
    try { connected=await fetch(`http://127.0.0.1:${port}/json/version`).then(r=>r.json()); } catch { await new Promise(resolve=>setTimeout(resolve,250)); }
    if (child.exitCode !== null) throw Error(`Rust process exited ${child.exitCode}: ${logs.join('')}`);
  }
  assert(connected,'Rust WebView2 debugging endpoint must start');
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{noDefaults:true});
  for(let attempt=0;attempt<40&&(!ui||!guest);attempt++) {
    const pages=browser.contexts().flatMap(context=>context.pages());
    ui=pages.find(page=>/\/ui\.html$/.test(page.url()));
    for(const page of pages.filter(page=>/\/guest\.html$/.test(page.url()))) {
      if(await page.evaluate(()=>!window.__POC_BACKGROUND__).catch(()=>false)) guest=page;
    }
    if(!ui||!guest)await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert(ui&&guest,'Native UI and guest targets must exist');
  ui.setDefaultTimeout(15000); guest.setDefaultTimeout(15000);
  ui.on('pageerror',error=>errors.push(error.message));
  await ui.waitForFunction(()=>document.querySelector('#host-status').textContent.includes('已连接'));
  await guest.waitForFunction(()=>!!window.pocFixtureState);
  const invoke=(command,args={})=>ui.evaluate(({command,args})=>window.__TAURI__.core.invoke(command,args),{command,args});
  const windows=()=>{const result=native({action:'windows'});return Array.isArray(result)?result:[result];};
  const owner=()=>windows().find(win=>win.title.includes('local guest fixture'));
  const clickAt=async(page,selector)=>{
    const rect=await page.locator(selector).boundingBox(); assert(rect,selector);
    const win=owner(), width=await page.evaluate(()=>innerWidth), ratio=win.width/width;
    native({action:'click',x:Math.round(win.x+(rect.x+rect.width/2)*ratio),y:Math.round(win.y+(rect.y+rect.height/2)*ratio)});
    await page.waitForTimeout(150);
  };
  const viewport=await guest.evaluate(()=>[innerWidth,innerHeight]);
  assert.deepEqual(viewport,await ui.evaluate(()=>[innerWidth,innerHeight]));
  pass('native owner and transparent overlay share the full viewport',{viewport});
  const count=()=>guest.evaluate(()=>window.pocFixtureState.clicks);
  const initial=await count(); await clickAt(guest,'#guest-click');
  await guest.waitForFunction(value=>window.pocFixtureState.clicks===value,initial+1);
  pass('physical Windows click passes through the transparent UI hole');
  await clickAt(ui,'#toggle-panel'); await ui.waitForFunction(()=>document.body.dataset.blocked==='true');
  await ui.waitForTimeout(350);
  const before=await count(); await clickAt(guest,'#guest-click');
  await ui.waitForFunction(()=>document.body.dataset.blocked==='false');
  assert.equal(await count(),before,'Outside close must consume the entire native click');
  await clickAt(guest,'#guest-click'); await guest.waitForFunction(value=>window.pocFixtureState.clicks===value,before+1);
  pass('native outside dismissal consumes the complete gesture');
  const backgroundBefore=await invoke('poc_probe',{target:'background'});
  const enter=await invoke('poc_enter'); assert.equal(enter.trustedEnter,true);
  assert.equal(enter.after.submissions,enter.before.submissions+1); assert.equal(enter.after.lastEvent.trusted,true);
  const backgroundAfter=await invoke('poc_probe',{target:'background'});
  assert.equal(backgroundBefore.submissions,backgroundAfter.submissions);assert.equal(backgroundBefore.trustedEnters,backgroundAfter.trustedEnters);
  pass('browser input dispatch reaches only the selected guest as one trusted Enter',{before:enter.before.submissions,after:enter.after.submissions});
  const negative=await guest.evaluate(async()=>{
    try {await window.__TAURI__.core.invoke('poc_info');return false;} catch {return true;}
  });
  assert.equal(negative,true); pass('guest cannot invoke trusted host commands');
  await guest.evaluate(()=>{
    window.__imeEvents=[];
    for(const name of ['compositionstart','compositionupdate','compositionend','input'])document.querySelector('#guest-editor').addEventListener(name,event=>window.__imeEvents.push({type:event.type,data:event.data,trusted:event.isTrusted}));
    document.querySelector('#guest-editor').value='';
  });
  await clickAt(guest,'#guest-editor');
  native({action:'type',text:'nihao '});await guest.waitForTimeout(500);
  let ime=await guest.evaluate(()=>({value:document.querySelector('#guest-editor').value,events:window.__imeEvents}));
  let toggled=false;
  if(!/[\u3400-\u9fff]/.test(ime.value)){
    native({action:'toggle-ime'});toggled=true;
    await guest.evaluate(()=>{document.querySelector('#guest-editor').value='';window.__imeEvents=[];});
    native({action:'type',text:'nihao '});await guest.waitForTimeout(500);
    ime=await guest.evaluate(()=>({value:document.querySelector('#guest-editor').value,events:window.__imeEvents}));
  }
  if(toggled)native({action:'toggle-ime'});
  assert(/[\u3400-\u9fff]/.test(ime.value)&&ime.events.some(event=>event.type==='input'&&event.trusted&&/[\u3400-\u9fff]/.test(event.data||'')),JSON.stringify(ime));
  pass('native Pinyin keyboard input commits trusted Chinese text through the installed IME',{ime});
  const touchBefore=await count(),touchRect=await guest.locator('#guest-click').boundingBox(),touchWin=owner(),touchRatio=touchWin.width/viewport[0];
  native({action:'touch',x:Math.round(touchWin.x+(touchRect.x+touchRect.width/2)*touchRatio),y:Math.round(touchWin.y+(touchRect.y+touchRect.height/2)*touchRatio)});
  await guest.waitForFunction(value=>window.pocFixtureState.clicks===value,touchBefore+1);
  const pointer=await guest.evaluate(()=>window.pocFixtureState.lastPointer);assert.equal(pointer.type,'touch');assert.equal(pointer.trusted,true);
  pass('Windows touch injection passes through the native hole as a trusted touch',{pointer});
  const background=await invoke('poc_probe',{target:'background'}); assert.equal(background.background,true);
  pass('separate hidden guest remains alive',{ticks:background.ticks});
  if(await ui.locator('#panel').getAttribute('data-open')==='true') {
    await clickAt(ui,'#close-panel');await ui.waitForFunction(()=>document.body.dataset.blocked==='false');
  }
  for(const edge of ['left','right','top','bottom']) {
    await clickAt(ui,`button[data-edge="${edge}"]`); await clickAt(ui,'#toggle-panel');
    await ui.waitForFunction(()=>document.querySelector('#panel').dataset.open==='true'); await ui.waitForTimeout(350);
    assert.deepEqual(viewport,await guest.evaluate(()=>[innerWidth,innerHeight]));
    const r=await ui.locator('#panel').boundingBox(); assert(r.x>=0&&r.y>=0&&r.x+r.width<=viewport[0]+1&&r.y+r.height<=viewport[1]+1);
    await ui.screenshot({path:path.join(out,`${edge}-overlay.png`)});
    await clickAt(ui,'#close-panel'); await ui.waitForFunction(()=>document.body.dataset.blocked==='false'); await ui.waitForTimeout(150);
  }
  pass('all four native overlay panels preserve the guest viewport');
  await ui.evaluate(()=>{window.__POC_PAUSE_CAPTURE=true;});
  await ui.waitForTimeout(1400);
  const capture=await invoke('poc_capture',{request:{region:{x:0,y:0,width:viewport[0],height:viewport[1]},viewport:{x:0,y:0,width:viewport[0],height:viewport[1]}}});
  writeFileSync(path.join(out,'guest-capture.png'),Buffer.from(capture.dataUrl.split(',')[1],'base64'));
  assert(capture.sampledSize.every(value=>value<=1200));
  pass('CapturePreview returns only the bounded owned guest surface',{sampledSize:capture.sampledSize,elapsedMs:capture.elapsedMs});
  const top=await guest.evaluate(()=>scrollY), win=owner(); native({action:'wheel',x:win.x+Math.floor(win.width/2),y:win.y+Math.floor(win.height/2),amount:-480});
  await guest.waitForFunction(before=>scrollY>before,top); const scrolled=await guest.evaluate(()=>scrollY);
  pass('physical wheel scroll reaches the webpage under the overlay',{scrolled});
  native({action:'minimize'}); await ui.waitForTimeout(500);
  let refusal='';try{await invoke('poc_capture',{request:{region:{x:0,y:0,width:100,height:100},viewport:{x:0,y:0,width:viewport[0],height:viewport[1]}}});}catch(error){refusal=String(error);}
  assert(/minimized|not visible|foreground/i.test(refusal),`Minimized captures must be rejected: ${refusal}`);native({action:'restore'});await ui.waitForTimeout(500);
  const restored=windows(),restoredGuest=restored.find(win=>win.title.includes('local guest fixture')),restoredUi=restored.find(win=>win.title.includes('trusted UI overlay'));
  assert(restoredUi.visible&&restoredGuest.visible);assert.equal(restoredUi.x,restoredGuest.x);assert.equal(restoredUi.y,restoredGuest.y);assert.equal(restoredUi.width,restoredGuest.width);assert.equal(restoredUi.height,restoredGuest.height);
  const resumed=await invoke('poc_capture',{request:{region:{x:0,y:0,width:100,height:100},viewport:{x:0,y:0,width:viewport[0],height:viewport[1]}}});assert(resumed.dataUrl.startsWith('data:image/png;base64,'));
  pass('minimize rejects capture and restore returns the owned overlay');
  assert.deepEqual(errors,[]);
  writeFileSync(path.join(out,'results.json'),JSON.stringify({passed:true,scope:'R1 native G1; installed IME/touch verified; additional system DPI and performance comparisons pending',reports,errors},null,2));
}catch(error){
  writeFileSync(path.join(out,'results.json'),JSON.stringify({passed:false,reports,errors,error:error.stack},null,2));
  if(ui)await ui.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});throw error;
}finally{
  if(browser)await browser.close().catch(()=>{});
  if(child.exitCode===null)child.kill();
  writeFileSync(path.join(out,'process.log'),logs.join(''));
}
