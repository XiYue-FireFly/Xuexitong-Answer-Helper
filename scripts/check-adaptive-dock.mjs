import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const require = createRequire(import.meta.url);
const { _electron, chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright-core');
const mobile = process.env.DOCK_QA_PLATFORM === 'android';
const out = path.resolve(process.env.DOCK_QA_OUT || `.playwright-mcp/adaptive-${mobile ? 'android' : 'windows'}`);
mkdirSync(out, { recursive: true });
const adb = (...args) => execFileSync(process.env.ANDROID_ADB || 'D:/Android/Sdk/platform-tools/adb.exe', args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
const fixture = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>抽屉与玻璃验证</title>
<style>body{margin:0;color:#163249;font:20px system-ui}section{height:140vh;padding:24px;background:#e9f4ff}section+section{background:#1d60dd;color:white}button{padding:16px}</style>
<section><h1>网页滚动与四边抽屉</h1><button id="page-action">网页操作</button>
<div class="questionLi" id="q-ui" qid="ui" qtype="0"><div class="question-title">UI 验证 ${Date.now()}：1 + 1 = ?</div><label><input type="radio" name="answer" value="A">A. 2</label><label><input type="radio" name="answer" value="B">B. 3</label></div>
<div id="nested" style="height:160px;overflow:auto;background:#b6e6da"><div style="height:900px">嵌套滚动区域</div></div></section><section><h2>下方蓝色区域</h2></section>
<script>window.pageClicks=0;document.querySelector('button').onclick=()=>window.pageClicks++;</script>`;
const server = createServer((req,res) => { res.setHeader('Content-Type','text/html;charset=utf-8'); res.end(fixture); });
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const port = server.address().port, url = `http://127.0.0.1:${port}/`;
let app, browser, shell, source, sourceId, oldPreferences, oldRotation, oldAutoRotation;
const reports = [], errors = [];
const pass = name => { reports.push({ name, passed: true }); console.log('PASS', name); };
try {
  if (mobile) {
    oldRotation=adb('shell','settings','get','system','user_rotation').toString().trim();
    oldAutoRotation=adb('shell','settings','get','system','accelerometer_rotation').toString().trim();
    adb('reverse',`tcp:${port}`,`tcp:${port}`);
    adb('shell','am','force-stop','com.studypilot.android');
    adb('shell','am','start','-n','com.studypilot.android/.MainActivity');
    let pid;
    for(let i=0;i<30;i++) {
      try { pid=adb('shell','pidof','com.studypilot.android').toString().trim();
        if(pid && adb('shell','cat','/proc/net/unix').toString().includes(`@webview_devtools_remote_${pid}`)) break;
      } catch {}
      await new Promise(resolve=>setTimeout(resolve,300));
    }
    adb('forward','tcp:9222',`localabstract:webview_devtools_remote_${pid}`);
    browser=await chromium.connectOverCDP('http://127.0.0.1:9222',{ noDefaults:true });
    shell=browser.contexts()[0].pages().find(page=>page.url().startsWith('https://localhost'));
    await shell.locator('.mobile-shell').waitFor();
    oldPreferences=await shell.evaluate(()=>localStorage.getItem('studypilot_dock_ui_v1'));
    await shell.evaluate(()=>{ localStorage.setItem('studypilot_dock_ui_v1',JSON.stringify({edge:'bottom',glass:'ultra',autoCollapse:true})); });
    await shell.reload(); await shell.locator('.mobile-shell').waitFor();
    await shell.evaluate(url=>window.Capacitor.nativePromise('NativeWebView','loadUrl',{url}),url);
    source={ evaluate: (fn,arg)=>shell.evaluate(async payload=>{
      const result=await window.Capacitor.nativePromise('NativeWebView','executeScript',{code:`(${payload.fn})(${JSON.stringify(payload.arg) ?? ''})`});
      return result.result;
    },{fn:fn.toString(),arg}) };
  } else {
    const profile=mkdtempSync(path.join(os.tmpdir(),'studypilot-drawer-'));
    const env={...process.env,NODE_ENV:'production',ELECTRON_DISABLE_SECURITY_WARNINGS:'true',APPDATA:path.join(profile,'Roaming'),LOCALAPPDATA:path.join(profile,'Local')};
    delete env.ELECTRON_RUN_AS_NODE;
    app=await _electron.launch({executablePath:process.env.DESKTOP_QA_EXE || require('electron'),args:[...(process.env.DESKTOP_QA_EXE ? [] : [process.cwd()]),`--user-data-dir=${profile}`],env});
    shell=await app.firstWindow();
    await shell.evaluate(()=>{localStorage.setItem('studypilot_start_notice_v2','1');}); await shell.reload();
    await shell.locator('.desktop-shell').waitFor();
    await shell.locator('.browser-address input').fill(url); await shell.locator('.browser-address input').press('Enter');
    await shell.waitForFunction(url=>{try{return document.querySelector('webview[data-active-browser="true"]').getURL()===url;}catch{return false;}},url);
    const id=await shell.locator('webview[data-active-browser="true"]').evaluate(el=>el.getWebContentsId());
    sourceId=id;
    source={evaluate:(fn,arg)=>app.evaluate(({webContents},payload)=>webContents.fromId(payload.id).executeJavaScript(`(${payload.fn})(${JSON.stringify(payload.arg) ?? ''})`),{id,fn:fn.toString(),arg})};
  }
  shell.setDefaultTimeout(15000);
  shell.on('pageerror',error=>errors.push(error.message));
  const dock=shell.locator('.adaptive-dock');
  const screenshot=async name=>{
    if(mobile) writeFileSync(path.join(out,name),adb('exec-out','screencap','-p'));
    else await shell.screenshot({path:path.join(out,name)});
  };
  const tap=async locator=>{
    if(!mobile) return locator.click();
    await locator.scrollIntoViewIfNeeded();
    await shell.waitForTimeout(250);
    const rect=await locator.boundingBox();
    const targets=await (await fetch('http://127.0.0.1:9222/json/list')).json();
    const d=JSON.parse(targets.find(target=>target.url.startsWith('https://localhost')).description);
    const scale=d.width/await shell.evaluate(()=>innerWidth);
    adb('shell','input','tap',String(Math.round(d.screenX+(rect.x+rect.width/2)*scale)),String(Math.round(d.screenY+(rect.y+rect.height/2)*scale)));
  };
  const expand=async()=>{if(await dock.evaluate(el=>el.classList.contains('is-collapsed'))) {await tap(dock.locator('.dock-answer')); await shell.waitForTimeout(500);}};
  const open=async name=>{await expand();const tab=dock.getByRole('button',{name,exact:true});if(await tab.getAttribute('aria-expanded')!=='true') await tap(tab);
    await shell.waitForFunction(name=>[...document.querySelectorAll('.mobile-tab')].some(tab=>tab.getAttribute('aria-label')===name&&tab.getAttribute('aria-expanded')==='true'),name);
    await shell.waitForTimeout(450);};
  const close=async()=>{ const active=dock.locator('.mobile-tab[aria-expanded="true"]'); if(await active.count()) await tap(active);
    await shell.waitForFunction(()=>!document.querySelector('.mobile-tab[aria-expanded="true"]')&&!document.querySelector('.mobile-dismiss.is-active,.desktop-dismiss'));
    await shell.waitForTimeout(100); };
  await shell.waitForTimeout(600);
  assert.equal(await dock.locator('.mobile-tab').count(), mobile ? 3 : 7); pass('platform keeps the requested number of main tools');
  for(const [edge,label] of [['bottom','底部抽屉'],['left','左侧抽屉'],['right','右侧抽屉'],['top','上部抽屉']]) {
    await source.evaluate(()=>scrollTo(0,0)); await open('设置');
    await tap(shell.getByRole('button',{name:label,exact:true})); await shell.waitForTimeout(600);
    assert.equal(await dock.getAttribute('data-edge'),edge);
    const r=await dock.boundingBox(),viewport=await shell.evaluate(()=>({w:innerWidth,h:innerHeight}));
    assert(r.x>=0&&r.y>=0&&r.x+r.width<=viewport.w+1&&r.y+r.height<=viewport.h+1,JSON.stringify(r));
    const centering=await dock.evaluate(nav=>{
      const r=nav.getBoundingClientRect(),vertical=nav.dataset.vertical==='true';
      return [...nav.querySelectorAll('.mobile-tab')].map(button=>{
        const c=button.querySelector('.mobile-tab__content').getBoundingClientRect();
        return vertical ? Math.abs(c.x+c.width/2-r.x-r.width/2) : Math.abs(c.y+c.height/2-r.y-r.height/2);
      });
    });
    assert(centering.every(error=>error<=1.5),`Icons and labels must be centered: ${centering}`);
    const first=await dock.locator('.mobile-tab').first().boundingBox(),last=await dock.locator('.mobile-tab').last().boundingBox();
    await shell.mouse.move(first.x+first.width/2,first.y+first.height/2); await shell.mouse.down();
    await shell.waitForFunction(()=>parseFloat(document.querySelector('.mobile-tabs__track').style.getPropertyValue('--dock-lift'))>.85);
    await screenshot(`${edge}-held.png`);
    await shell.mouse.move(first.x+(last.x-first.x)*.25+first.width/2,first.y+(last.y-first.y)*.25+first.height/2,{steps:12});
    await shell.waitForTimeout(250); await screenshot(`${edge}-drag.png`);
    await shell.mouse.move(last.x+last.width/2,last.y+last.height/2,{steps:16}); await shell.mouse.up();
    await shell.waitForFunction(()=>document.querySelector('.mobile-tab.is-active').dataset.tool==='settings');
    await close();
    await source.evaluate(()=>scrollTo(0,350));
    await shell.waitForFunction(()=>document.querySelector('.adaptive-dock').classList.contains('is-collapsed'));
    await shell.waitForTimeout(600);
    const small=await dock.boundingBox(); assert(Math.abs(small.width-62)<2&&Math.abs(small.height-62)<2,JSON.stringify(small));
    await shell.waitForFunction(()=>document.querySelector('.mobile-tabs__track').dataset.optics==='gpu');
    await screenshot(`${edge}-collapsed.png`);
    await expand(); assert.equal(await dock.evaluate(el=>el.classList.contains('is-collapsed')),false);
    await shell.waitForTimeout(300); assert.equal(await dock.evaluate(el=>el.classList.contains('is-collapsed')),false,'manual expansion must persist without another scroll');
    await source.evaluate(()=>scrollTo(0,700)); await shell.waitForFunction(()=>document.querySelector('.adaptive-dock').classList.contains('is-collapsed'));
    await source.evaluate(()=>scrollTo(0,0)); await shell.waitForFunction(()=>!document.querySelector('.adaptive-dock').classList.contains('is-collapsed'));
    await shell.waitForTimeout(550); await screenshot(`${edge}-expanded.png`);
    pass(`${edge}: position, held drag, live collapsed glass, manual expansion and top restoration`);
  }
  await open('设置');
  if(mobile) for(const name of ['Token 用量','运行记录','错误报告','使用教程']) {
    await tap(shell.getByRole('button',{name,exact:true}));
    await shell.getByRole('button',{name:'返回设置',exact:true}).waitFor();
    await tap(shell.getByRole('button',{name:'返回设置',exact:true}));
  }
  pass('secondary tools remain reachable');
  await tap(shell.getByRole('button',{name:'底部抽屉',exact:true}));
  await tap(shell.getByRole('button',{name:'标准 · 柔和玻璃',exact:true}));
  assert.equal(await dock.getAttribute('data-glass'),'standard');
  await tap(shell.getByRole('button',{name:'极致 · 实时折射',exact:true}));
  await close(); await source.evaluate(()=>document.querySelector('#nested').scrollTo(0,300));
  await shell.waitForFunction(()=>document.querySelector('.adaptive-dock').classList.contains('is-collapsed'));
  await source.evaluate(()=>document.querySelector('#nested').scrollTo(0,0));
  await shell.waitForFunction(()=>!document.querySelector('.adaptive-dock').classList.contains('is-collapsed'));
  pass('quality switch and nested webpage scrolling');
  await tap(mobile ? shell.getByRole('button',{name:'切换明暗主题',exact:true}) : shell.locator('.theme-switch-btn'));
  await open('设置'); await tap(shell.getByRole('button',{name:'上部抽屉',exact:true})); await close();
  await shell.waitForTimeout(600); await screenshot('light-top.png');
  await tap(mobile ? shell.getByRole('button',{name:'切换明暗主题',exact:true}) : shell.locator('.theme-switch-btn'));
  pass('light and dark materials remain usable');
  {
    const aiHtml=`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><form><textarea id="chat-input" placeholder="输入消息"></textarea><button type="button" id="send" aria-label="发送">发送</button></form><div id="history"></div><script>
    const send=()=>{
      const input=document.querySelector('textarea'),value=input.value;if(!value.trim())return;
      input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));const user=document.createElement('div');user.dataset.messageAuthorRole='user';user.textContent=value;document.querySelector('#history').append(user);
      window.completeReply=()=>{const batch=JSON.parse(value.slice(value.lastIndexOf('\\n\\n{')+2));const answer=document.createElement('div');answer.className='ds-markdown';answer.dataset.messageId='ui-reply';answer.dataset.messageStatus='completed';
      answer.textContent=JSON.stringify({requestId:batch.requestId,answers:batch.questions.map(q=>({id:q.id,answer:'2',choiceLabels:['A'],matchedOptions:['2'],confidence:0.99,analysis:'',warnings:[]}))});document.querySelector('#history').append(answer);};
    };document.querySelector('#send').onclick=send;document.querySelector('textarea').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();send();}};</script>`;
    if(mobile) await browser.contexts()[0].route('https://chat.deepseek.com/**',route=>route.fulfill({contentType:'text/html;charset=utf-8',body:aiHtml}));
    else await app.evaluate(({webContents},payload)=>webContents.fromId(payload.id).session.protocol.handle('https',()=>new Response(payload.html,{headers:{'Content-Type':'text/html;charset=utf-8'}})),{id:sourceId,html:aiHtml});
    await open('答题');
    await tap(shell.getByRole('tab',{name:/网页 AI/}));
    const automatic=shell.getByRole('tab',{name:'自动答题',exact:true}); if(await automatic.getAttribute('aria-selected')!=='true') await tap(automatic);
    await tap(shell.getByRole('button',{name:'开始自动答题',exact:true}));
    await shell.waitForFunction(()=>document.querySelector('.adaptive-dock').classList.contains('is-collapsed'));
    let ai;
    for(let i=0;i<80&&!ai;i++) {
      if(mobile) for(const page of browser.contexts()[0].pages().filter(page=>page.url().startsWith('https://chat.deepseek.com/'))) {
          if(await page.evaluate(()=>!!window.completeReply).catch(()=>false)) {ai=page;break;}
        }
      else ai=await app.evaluate(async ({webContents})=>{
        for(const guest of webContents.getAllWebContents().filter(guest=>guest.getURL().startsWith('https://chat.deepseek.com/'))) {
          if(await guest.executeJavaScript('!!window.completeReply').catch(()=>false)) return guest.id;
        }
        return null;
      });
      if(!ai)await shell.waitForTimeout(250);
    }
    assert(ai,'Local automatic fixture must receive the prompt');
    assert.equal(await dock.evaluate(el=>el.classList.contains('is-collapsed')),true);
    await screenshot('automatic-running.png');
    if(mobile) await ai.evaluate(()=>window.completeReply());
    else await app.evaluate(({webContents},id)=>webContents.fromId(id).executeJavaScript('window.completeReply()'),ai);
    let filled=false;
    for(let i=0;i<100&&!filled;i++) {filled=await source.evaluate(()=>document.querySelector('input[value="A"]')?.checked===true);if(!filled)await shell.waitForTimeout(300);}
    assert(filled,'Existing automatic flow must fill its original local fixture');
    await shell.waitForFunction(()=>!document.querySelector('.adaptive-dock').classList.contains('is-collapsed'));
    await shell.waitForTimeout(500); await screenshot('automatic-completed.png');
    pass('real automatic run collapses the dock and expands it after source fill');
  }
  await open('设置');
  await tap(shell.getByRole('button',{name:'右侧抽屉',exact:true}));
  await tap(shell.getByRole('button',{name:'标准 · 柔和玻璃',exact:true}));
  await shell.reload(); await shell.locator('.adaptive-dock').waitFor();
  assert.equal(await shell.locator('.adaptive-dock').getAttribute('data-edge'),'right');
  assert.equal(await shell.locator('.adaptive-dock').getAttribute('data-glass'),'standard');
  pass('appearance preferences persist across reload');
  if(mobile) {
    adb('shell','settings','put','system','accelerometer_rotation','0');
    adb('shell','settings','put','system','user_rotation','1');
    await shell.waitForFunction(()=>innerWidth>innerHeight);
    for(const label of ['左侧抽屉','右侧抽屉','上部抽屉','底部抽屉']) {
      await open('设置'); await tap(shell.getByRole('button',{name:label,exact:true})); await shell.waitForTimeout(600);
      const r=await dock.boundingBox(),v=await shell.evaluate(()=>({w:innerWidth,h:innerHeight}));
      assert(r.x>=0&&r.y>=0&&r.x+r.width<=v.w+1&&r.y+r.height<=v.h+1,JSON.stringify({label,r,v}));
      await screenshot(`landscape-${await dock.getAttribute('data-edge')}.png`); await close();
    }
    pass('landscape keeps all four docks and their settings reachable');
  }
  assert.deepEqual(errors,[]);
  writeFileSync(path.join(out,'results.json'),JSON.stringify({passed:true,platform:mobile?'android':'windows',reports,errors},null,2));
} catch(error) {
  if(shell) console.error('UI state:',await shell.evaluate(()=>({viewport:[innerWidth,innerHeight],active:document.querySelector('.mobile-tab.is-active')?.dataset.tool,
    panel:!!document.querySelector('.mobile-sheet.is-open,.desktop-sheet.is-open'),dock:document.querySelector('.adaptive-dock')?.getBoundingClientRect().toJSON(),text:document.querySelector('.mobile-sheet')?.innerText.slice(0,500)})).catch(()=>null));
  if(mobile) writeFileSync(path.join(out,'failure-device.png'),adb('exec-out','screencap','-p'));
  else if(shell) await shell.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});
  writeFileSync(path.join(out,'results.json'),JSON.stringify({passed:false,reports,errors,error:error.stack},null,2)); throw error;
} finally {
  if(mobile&&shell) await shell.evaluate(value=>{if(value===null)localStorage.removeItem('studypilot_dock_ui_v1');else localStorage.setItem('studypilot_dock_ui_v1',value);},oldPreferences??null).catch(()=>{});
  if(app) await app.close(); if(browser) await browser.close();
  if(mobile) adb('reverse','--remove',`tcp:${port}`);
  if(mobile&&oldRotation!==undefined) {adb('shell','settings','put','system','user_rotation',oldRotation);adb('shell','settings','put','system','accelerometer_rotation',oldAutoRotation);}
  await new Promise(resolve=>server.close(resolve));
}
