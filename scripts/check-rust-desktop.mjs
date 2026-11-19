import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdirSync,writeFileSync,mkdtempSync} from 'node:fs';
import os from 'node:os';
import {createRequire} from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createProfileEnvelope} from './export-electron-profile.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright-core');
const installed=Boolean(process.env.RUST_HOST_EXE);
const out=path.resolve(process.env.RUST_HOST_QA_OUT||`.playwright-mcp/${installed?'rust-installed-native':'rust-desktop-native'}`);mkdirSync(out,{recursive:true});
const fixture=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rust 原核心验证</title><h1>原题页</h1><div class="questionLi" id="one" qid="one" qtype="0"><div class="question-title">1 + 1 = ?<img id="question-img" width="32" height="32" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X9ZkAAAAASUVORK5CYII="></div><label><input type="radio" name="answer" value="A">A. 2</label><label><input type="radio" name="answer" value="B">B. 3</label></div><p style="height:1800px;background:linear-gradient(#eee,#2162db)">保持完整网页</p>`;
let frameUrl='',postedBody='';
const frameServer=createServer((req,res)=>{res.setHeader('Content-Type','text/html;charset=utf-8');res.end(fixture.replace('1 + 1 = ?','2 + 2 = ?').replace('A. 2','A. 4').replace(/<img id="question-img"[^>]*>/,'<canvas id="question-canvas" width="32" height="32"></canvas><script>document.querySelector("#question-canvas").getContext("2d").fillRect(0,0,32,32)</script>'));});await new Promise(resolve=>frameServer.listen(0,'127.0.0.1',resolve));frameUrl=`http://127.0.0.1:${frameServer.address().port}/`;
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html;charset=utf-8');if(req.url==='/work/save'&&req.method==='POST'){let value='';req.on('data',data=>value+=data);req.on('end',()=>{postedBody=value;res.writeHead(302,{Location:'/popup-result'});res.end();});return;}res.end(req.url==='/popup-result'?'<title>原生弹窗结果</title><h1>Popup redirect result</h1>':req.url==='/framed'?`<!doctype html><title>跨域原题容器</title><style>body{margin:0}iframe{width:100%;height:100vh;border:0}</style><iframe src="${frameUrl}"></iframe>`:fixture);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}/`,logs=[],errors=[];let browser,ui;
const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
const debugPort=reservation.address().port,endpoint=`http://127.0.0.1:${debugPort}`;
await new Promise(resolve=>reservation.close(resolve));
const profile=mkdtempSync(path.join(os.tmpdir(),'studypilot-rust-desktop-'));
const child=spawn(path.resolve(process.env.RUST_HOST_EXE||'src-tauri/target/debug/studypilot-rust-host-poc.exe'),[],{windowsHide:true,env:{...process.env,STUDYPILOT_RUST_DESKTOP:'1',STUDYPILOT_RUST_PREVIEW_DATA:profile,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${debugPort}`},stdio:['ignore','pipe','pipe']});
let spawnError;child.on('error',error=>{spawnError=error;});
child.stdout.on('data',data=>logs.push(data.toString()));child.stderr.on('data',data=>logs.push(data.toString()));
const reports=[],pass=name=>{reports.push({name,passed:true});console.log('PASS',name);};
try{
 let debuggerReady=false;
 for(let i=0;i<80;i++){if(spawnError)throw spawnError;if(child.exitCode!==null)throw Error('Isolated QA child exited before debugger startup');try{const response=await fetch(endpoint+'/json/version',{signal:AbortSignal.timeout(500)});if(!response.ok||typeof (await response.json()).webSocketDebuggerUrl!=='string')throw Error('Debugger not ready');debuggerReady=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,250));}}
 assert(debuggerReady,'Isolated debugger did not become ready');
 browser=await chromium.connectOverCDP(endpoint,{noDefaults:true});
 let candidate;
 for(let i=0;i<40&&!candidate;i++){candidate=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('rust-index'));if(!candidate)await new Promise(resolve=>setTimeout(resolve,250));}
 assert(candidate);
 // This read-only host value binds the endpoint to our unpredictable new data
 // directory. Do not assign ui (including its finally-close) until verified.
 await candidate.waitForFunction(()=>window.__RUST_HOST__?.invoke);
 const diagnosticPath=await candidate.evaluate(()=>window.__RUST_HOST__.invoke('diagnostics:get-error-log-path'));
 assert.equal(path.resolve(diagnosticPath),path.join(profile,'rust-host-preview','diagnostics.jsonl'),'Refuse a debugger endpoint outside the isolated QA profile');
 assert.equal(child.exitCode,null,'Isolated QA child must still be running');ui=candidate;
 assert(ui);ui.setDefaultTimeout(20000);ui.on('pageerror',error=>errors.push(error.message));await ui.locator('.desktop-shell').waitFor();
 const nativeWindows=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/rust-host-native-input.ps1','-PayloadBase64',Buffer.from(JSON.stringify({action:'windows',processId:child.pid})).toString('base64')],{encoding:'utf8',windowsHide:true}));
 const windows=Array.isArray(nativeWindows)?nativeWindows:[nativeWindows];const rootWindow=windows.find(window=>window.title==='WISP RS'&&window.owner===0);assert(rootWindow);assert(rootWindow.y-rootWindow.outerY<=Math.ceil(rootWindow.dpi/96*8),'The Rust owner must not reserve native titlebar height');
 assert.equal(await ui.locator('.app-window-titlebar').count(),1);assert.equal(await ui.locator('.app-brand__title').textContent(),'WISP RS');assert.equal(await ui.locator('.app-brand__mark img').count(),1);pass('WISP RS uses the willow mark and one frameless draggable titlebar');
 if(await ui.getByRole('button',{name:'我知道了',exact:true}).count())await ui.getByRole('button',{name:'我知道了',exact:true}).click();
 await ui.waitForFunction(()=>{const el=document.querySelector('webview[data-active-browser=true]');try{return el?.getWebContentsId()>0&&!el.isLoading()&&document.querySelector('.browser-address input')?.value===el.getURL();}catch{return false;}});
 const address=ui.locator('.browser-address input');await address.click();await address.fill(url);
 await ui.waitForFunction(value=>document.querySelector('.browser-address input')?._valueTracker?.getValue()===value,url);
 await ui.getByRole('button',{name:'前往',exact:true}).click();
 await ui.waitForFunction(url=>document.querySelector('webview[data-active-browser=true]')?.getURL()===url,url);
 await ui.waitForTimeout(1200);
 console.log('Native frames',await ui.evaluate(()=>window.__RUST_HOST__.invoke('browser:debug',{guestId:document.querySelector('webview[data-active-browser=true]').getWebContentsId()})));
 for(const page of browser.contexts().flatMap(context=>context.pages()).filter(page=>page.url()===url)){
   console.log('Guest transport',await page.evaluate(()=>({chrome:typeof window.chrome?.webview?.postMessage,hooks:Object.getOwnPropertyNames(window).filter(name=>name.startsWith('__sp_')),core:window.__studyPilotAndroidBridge})));
   await page.evaluate(()=>window.chrome.webview.postMessage({diagnostic:true}));
 }
 await ui.waitForFunction(()=>document.querySelector('webview[data-active-browser=true]')?.isLoading()===false);
 assert.equal(await ui.locator('.mobile-tab').count(),7);pass('original React UI runs with seven tools and native browser proxy');
 const assertDockCorners=async name=>{
   const rect=await ui.locator('.adaptive-dock').boundingBox(),ratio=await ui.evaluate(()=>devicePixelRatio);
   const file=path.join(out,name+'.png');await ui.screenshot({path:file,omitBackground:true});
   const result=execFileSync('python.exe',['-X','utf8','-c','import json,sys; from PIL import Image; r=json.loads(sys.argv[2]); s=float(sys.argv[3]); im=Image.open(sys.argv[1]).convert("RGBA"); points=[(r["x"]+4,r["y"]+4),(r["x"]+r["width"]-4,r["y"]+4),(r["x"]+4,r["y"]+r["height"]-4),(r["x"]+r["width"]-4,r["y"]+r["height"]-4)]; values=[im.getpixel((round(x*s),round(y*s)))[3] for x,y in points]; print(json.dumps(values)); assert max(values)<96, values',file,JSON.stringify(rect),String(ratio)],{encoding:'utf8',windowsHide:true});
   assert(JSON.parse(result).every(alpha=>alpha<96),'No opaque rectangular backing may remain outside the glass capsule');
 };
 for(const edge of ['bottom','left','right','top']){
   await ui.evaluate(edge=>{localStorage.setItem('studypilot_dock_ui_v1',JSON.stringify({edge,glass:'ultra',autoCollapse:true}));dispatchEvent(new StorageEvent('storage',{key:'studypilot_dock_ui_v1'}));},edge);
   await ui.locator('webview[data-active-browser=true]').evaluate(el=>el.executeJavaScript('scrollTo(0,0)'));
   await ui.waitForFunction(()=>!document.querySelector('.adaptive-dock').classList.contains('is-collapsed'));await ui.waitForTimeout(550);
   await assertDockCorners(`dock-${edge}-expanded`);
   await ui.locator('webview[data-active-browser=true]').evaluate(el=>el.executeJavaScript('scrollTo(0,350)'));
   await ui.waitForFunction(()=>document.querySelector('.adaptive-dock').classList.contains('is-collapsed'));await ui.waitForTimeout(550);
   const small=await ui.locator('.adaptive-dock').boundingBox();assert(Math.abs(small.width-62)<2&&Math.abs(small.height-62)<2);
   await assertDockCorners(`dock-${edge}-collapsed`);
   await ui.locator('.dock-answer').click();await ui.waitForFunction(()=>!document.querySelector('.adaptive-dock').classList.contains('is-collapsed'));await ui.waitForTimeout(550);
   await ui.locator('webview[data-active-browser=true]').evaluate(el=>el.executeJavaScript('scrollTo(0,700)'));
   await ui.waitForFunction(()=>document.querySelector('.adaptive-dock').classList.contains('is-collapsed'));
   await ui.locator('webview[data-active-browser=true]').evaluate(el=>el.executeJavaScript('scrollTo(0,0)'));
   await ui.waitForFunction(()=>!document.querySelector('.adaptive-dock').classList.contains('is-collapsed'));
 }
 await ui.locator('.theme-switch-btn').click();await ui.waitForTimeout(600);await assertDockCorners('dock-light-expanded');await ui.locator('.theme-switch-btn').click();
 await ui.evaluate(()=>{localStorage.setItem('studypilot_dock_ui_v1',JSON.stringify({edge:'bottom',glass:'ultra',autoCollapse:true}));dispatchEvent(new StorageEvent('storage',{key:'studypilot_dock_ui_v1'}));});await ui.waitForTimeout(550);
 pass('four-edge glass has no rectangular backing in expanded and collapsed states; click and page-top restore the dock');
 const result=await ui.locator('webview[data-active-browser=true]').evaluate(el=>el.executeJavaScript('Promise.resolve({ok:true,value:null})'));
 assert.deepEqual(result,{ok:true,value:null});const undef=await ui.locator('webview[data-active-browser=true]').evaluate(el=>el.executeJavaScript('undefined'));assert.equal(undef,undefined);
 pass('original browser execution preserves Promise objects and undefined');
 const extracted=await ui.evaluate(()=>new Promise(resolve=>window.dispatchEvent(new CustomEvent('studypilot:extract-question-request',{detail:{onComplete:resolve}}))));
 assert.equal(extracted.success,true,JSON.stringify(extracted));assert.equal(extracted.questions.length,1);pass('unchanged original preload extracts the local question');
 const resource=await ui.evaluate(async question=>{const api=window.electronAPI,guestId=document.querySelector('webview[data-active-browser=true]').getWebContentsId(),sourceUrl=document.querySelector('webview[data-active-browser=true]').getURL();
   const lease=await api.leaseWebAITask({sessionId:'native-media-fixture',sourceContentsId:guestId,sourceUrl});if(!lease.ok)throw Error(JSON.stringify(lease));
   const result=await api.readQuestionMedia({sessionId:'native-media-fixture',mediaId:'fixture-image',questionHash:question.hash,selector:'#question-img'});await api.releaseWebAITask('native-media-fixture');return result;},extracted.questions[0]);
 assert.equal(resource.ok,true,JSON.stringify(resource));assert(resource.bytes.length>0);assert(resource.mime.startsWith('image/'));pass('source-bound native media lease reads the actual question image with frozen policy');
 const applied=await ui.evaluate(question=>new Promise(resolve=>window.dispatchEvent(new CustomEvent('studypilot:apply-answers',{detail:{items:[{question,answer:{answer:'2',choiceLabels:['A'],matchedOptions:['2']}}],onComplete:resolve}}))),extracted.questions[0]);
 assert.equal(applied.success,true,JSON.stringify(applied));assert.equal(await ui.locator('webview[data-active-browser=true]').evaluate(el=>el.executeJavaScript('document.querySelector("input[value=A]").checked')),true);pass('unchanged original answer applier fills the original native webpage');
 const framed=url+'framed';await ui.locator('webview[data-active-browser=true]').evaluate((el,value)=>el.loadURL(value),framed);await ui.waitForFunction(()=>!document.querySelector('webview[data-active-browser=true]').isLoading());await ui.waitForTimeout(1500);
 const nested=await ui.evaluate(()=>new Promise(resolve=>window.dispatchEvent(new CustomEvent('studypilot:extract-question-request',{detail:{onComplete:resolve}}))));
 assert.equal(nested.success,true,JSON.stringify(nested));assert.equal(nested.questions.length,1);assert(nested.questions[0].question.includes('2 + 2'));pass('native frame routing extracts cross-origin iframe with frozen core');
 const canvasResource=await ui.evaluate(async question=>{const api=window.electronAPI,el=document.querySelector('webview[data-active-browser=true]');const lease=await api.leaseWebAITask({sessionId:'native-canvas-fixture',sourceContentsId:el.getWebContentsId(),sourceUrl:el.getURL()});if(!lease.ok)throw Error(JSON.stringify(lease));const value=await api.readQuestionMedia({sessionId:'native-canvas-fixture',mediaId:'canvas',questionHash:question.hash,selector:'#question-canvas'});await api.releaseWebAITask('native-canvas-fixture');return value;},nested.questions[0]);
 assert.equal(canvasResource.ok,true,JSON.stringify(canvasResource));assert(canvasResource.bytes.length>0);pass('native iframe geometry maps canvas fallback into only the owned guest screenshot');
 const captures=await ui.evaluate(async question=>{
   const api=window.electronAPI,el=document.querySelector('webview[data-active-browser=true]'),guestId=el.getWebContentsId(),rect=el.getBoundingClientRect();
   const viewport={x:rect.x,y:rect.y,width:rect.width,height:rect.height},region={x:rect.x+8,y:rect.y+8,width:64,height:64};
   const lease=await api.leaseWebAITask({sessionId:'concurrent-capture-fixture',sourceContentsId:guestId,sourceUrl:el.getURL()});if(!lease.ok)throw Error(JSON.stringify(lease));
   try{return await Promise.all([
     api.captureGlass({guestId,region,viewport}),
     api.readQuestionMedia({sessionId:'concurrent-capture-fixture',mediaId:'canvas-concurrent',questionHash:question.hash,selector:'#question-canvas'}),
     api.captureGlass({guestId,region,viewport})
   ]);}finally{await api.releaseWebAITask('concurrent-capture-fixture');}
 },nested.questions[0]);
 assert(captures[0].dataUrl?.startsWith('data:image/png;base64,'),JSON.stringify(captures[0]));
 assert.equal(captures[1].ok,true,JSON.stringify(captures[1]));assert(captures[1].bytes.length>0);
 assert(captures[2].dataUrl?.startsWith('data:image/png;base64,'),JSON.stringify(captures[2]));pass('concurrent live glass and child canvas captures queue without losing the question image');
 const nestedApplied=await ui.evaluate(question=>new Promise(resolve=>window.dispatchEvent(new CustomEvent('studypilot:apply-answers',{detail:{items:[{question,answer:{answer:'4',choiceLabels:['A'],matchedOptions:['4']}}],onComplete:resolve}}))),nested.questions[0]);
 assert.equal(nestedApplied.success,true,JSON.stringify(nestedApplied));
 const childChecked=await ui.evaluate(async()=>{const host=window.__RUST_HOST__,id=document.querySelector('webview[data-active-browser=true]').getWebContentsId();const debug=await host.invoke('browser:debug',{guestId:id});const frame=debug.frames.frames.find(frame=>frame.frameId!==0&&frame.ready);if(!frame)throw Error('Native child frame missing');return host.invoke('browser:frame-evaluate',{guestId:id,frameId:frame.frameId,code:'document.querySelector("input[value=A]").checked'});});
 assert.equal(childChecked.value.value,true);pass('native frame routing binds the answer to its actual cross-origin document');
 const host=await ui.evaluate(()=>window.__RUST_HOST__.invoke('settings:get'));assert(host===null||typeof host==='object');pass('Rust settings service preserves the original facade');
 if(!installed){
 const aiHtml=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><form><input id="files" type="file" accept="image/*" multiple hidden><div id="images"></div><textarea id="chat-input" placeholder="输入消息"></textarea><button type="button" aria-label="发送" id="send">发送</button></form><div id="history"></div><script>document.querySelector("#files").onchange=event=>{for(const file of event.target.files){const card=document.createElement("div");card.dataset.fileName=file.name;card.dataset.status="ready";const img=document.createElement("img");img.alt=file.name;img.src=URL.createObjectURL(file);img.width=32;img.height=32;card.append(img);document.querySelector("#images").append(card)}};const send=()=>{const input=document.querySelector('textarea'),value=input.value;if(!value.trim())return;input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));const user=document.createElement('div');user.dataset.messageAuthorRole='user';user.textContent=value;document.querySelector('#history').append(user);setTimeout(()=>{const batch=JSON.parse(value.slice(value.lastIndexOf('\\n\\n{')+2)),answer=document.createElement('div');answer.className='ds-markdown';answer.dataset.messageId='rust-reply';answer.dataset.messageStatus='completed';answer.textContent=JSON.stringify({requestId:batch.requestId,answers:batch.questions.map(q=>({id:q.id,answer:'4',choiceLabels:['A'],matchedOptions:['4'],confidence:.99,analysis:'',warnings:[]}))});document.querySelector('#history').append(answer)},1000)};document.querySelector('#send').onclick=send;document.querySelector('textarea').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}};</script>`;
 await ui.evaluate(html=>window.__RUST_HOST__.invoke('test:install-ai-fixture',{host:'chat.deepseek.com',html}),aiHtml);
 await ui.getByRole('button',{name:'答题',exact:true}).click();await ui.getByRole('tab',{name:/网页 AI/}).click();const automatic=ui.getByRole('tab',{name:'自动答题',exact:true});if(await automatic.getAttribute('aria-selected')!=='true')await automatic.click();
 await ui.getByRole('button',{name:'开始自动答题',exact:true}).click();
 await ui.waitForFunction(()=>document.querySelector('.adaptive-dock').classList.contains('is-collapsed'));
 let done=false;for(let i=0;i<160&&!done;i++){done=await ui.getByText('已全部填回',{exact:true}).count()>0;if(!done)await ui.waitForTimeout(300);}
 assert(done,'Original automatic web-AI flow must complete through native browser fixture');await ui.waitForFunction(()=>!document.querySelector('.adaptive-dock').classList.contains('is-collapsed'));pass('unchanged automatic web-AI flow sends, extracts and fills through native guests');
 }
 await ui.locator('webview[data-active-browser=true]').evaluate((el,target)=>el.executeJavaScript(`(()=>{const form=document.createElement('form');form.action=${JSON.stringify(target)};form.method='POST';form.target='_blank';const input=document.createElement('input');input.name='fixture';input.value='native-post-preserved';form.append(input);document.body.append(form);form.submit();return true})()`,true),url+'work/save');
 for(let i=0;i<40&&!postedBody;i++)await ui.waitForTimeout(100);assert.equal(postedBody,'fixture=native-post-preserved');
 await ui.waitForFunction(value=>[...document.querySelectorAll('webview')].some(el=>el.getURL?.()===value),url+'popup-result');pass('hidden native popup preserves POST body and forwards its final redirect');
 await ui.getByRole('button',{name:'题库',exact:true}).click();await ui.waitForTimeout(600);await ui.screenshot({path:path.join(out,'original-ui.png')});
 const exported=createProfileEnvelope({database:{settings:{theme:'dark'},history:['retained'],knowledgeBase:[]},localStorage:{studypilot_settings_v3:JSON.stringify({theme:'dark'}),studypilot_dock_ui_v1:JSON.stringify({edge:'left',glass:'ultra',autoCollapse:true})},sourceVersion:'1.5.1'});
 const imported=await ui.evaluate(async envelope=>{const host=window.__RUST_HOST__;const staged=await host.invoke('profile:stage',envelope);const committed=await host.invoke('profile:commit',{token:staged.token});return {staged,committed};},exported);
 assert.equal(imported.staged.token,imported.committed.token);await ui.reload();await ui.locator('.desktop-shell').waitFor();assert.equal(await ui.locator('.adaptive-dock').getAttribute('data-edge'),'left');
 await ui.evaluate(()=>window.electronAPI.setSettings({theme:'light',migrationTest:'kept'}));await ui.reload();await ui.locator('.desktop-shell').waitFor();assert.equal((await ui.evaluate(()=>window.electronAPI.getSettings())).migrationTest,'kept');pass('native profile import restores UI preferences and survives settings changes plus reload');
 assert.deepEqual(errors,[]);writeFileSync(path.join(out,'results.json'),JSON.stringify({passed:true,installed,reports,errors,skipped:installed?['debug-only automatic AI fixture is not shipped in release']:[]},null,2));
}catch(error){if(ui){console.error(await ui.evaluate(()=>({logs:document.body.innerText.slice(-900),view:document.querySelector('webview')?.getURL?.(),id:document.querySelector('webview')?.getWebContentsId?.(),loading:document.querySelector('webview')?.isLoading?.(),address:document.querySelector('.browser-address input')?.value,focus:document.activeElement?.outerHTML.slice(0,200)})).catch(()=>null));await ui.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}writeFileSync(path.join(out,'results.json'),JSON.stringify({passed:false,reports,errors,error:error.stack},null,2));throw error;
}finally{if(ui)await ui.evaluate(()=>window.__RUST_HOST__.invoke('window:close')).catch(()=>{});if(browser)await browser.close().catch(()=>{});if(child.exitCode===null)child.kill();await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>frameServer.close(resolve));writeFileSync(path.join(out,'process.log'),logs.join(''));}
