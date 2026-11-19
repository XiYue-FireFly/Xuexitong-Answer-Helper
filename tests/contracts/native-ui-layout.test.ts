import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source=readFileSync('src-tauri/src/desktop/ui-layout.js','utf8');

function fixture(options:{pending?:boolean}={}){
  let now=0, next=0, blocked=false, transition=false;
  const scheduled=new Map<number,()=>void>();
  const events=new Map<string,Set<()=>void>>();
  let mutation:()=>void=()=>{}, resized:()=>void=()=>{};
  const style={display:'block',visibility:'visible',borderTopLeftRadius:'9999px',borderTopRightRadius:'9999px',borderBottomRightRadius:'9999px',borderBottomLeftRadius:'9999px'};
  const rect={x:100,y:700,width:600,height:60};
  const dock={offsetWidth:600,offsetHeight:60,parentElement:null,getBoundingClientRect:()=>({...rect}),getAnimations:()=>transition?[{playState:'running',effect:{getKeyframes:()=>[{width:'600px'},{width:'60px'}]}}]:[]};
  const deliveries:{command:string,payload:any}[]=[];
  const resolvers:(()=>void)[]=[];
  const invoke=vi.fn(async (_command:string,payload:any)=>{
    if(payload.command==='ui:layout-context')return {documentGeneration:17};
    deliveries.push(payload);
    if(options.pending) await new Promise<void>(resolve=>resolvers.push(resolve));
  });
  const observe=vi.fn();
  const document={documentElement:{},querySelector:(selector:string)=>selector.includes('desktop-dismiss')&&blocked?{}:null,
    querySelectorAll:(selector:string)=>selector==='.adaptive-dock'?[dock]:[]};
  runInNewContext(source,{
    document,window:{__TAURI__:{core:{invoke}}},getComputedStyle:()=>style,
    requestAnimationFrame:(callback:()=>void)=>{scheduled.set(++next,callback);return next;},cancelAnimationFrame:(id:number)=>scheduled.delete(id),
    ResizeObserver:class{constructor(callback:()=>void){resized=callback;}observe=observe;unobserve(){}disconnect(){}},
    MutationObserver:class{constructor(callback:()=>void){mutation=callback;}observe(){}disconnect(){}},
    addEventListener:(name:string,listener:()=>void)=>{if(!events.has(name))events.set(name,new Set());events.get(name)!.add(listener);},
    removeEventListener:(name:string,listener:()=>void)=>events.get(name)?.delete(listener),
    setTimeout:()=>0,performance:{now:()=>now},
  });
  async function frame(){now+=16;const callbacks=[...scheduled.values()];scheduled.clear();for(const callback of callbacks)callback();for(let i=0;i<16;i++)await Promise.resolve();}
  return {rect,style,deliveries,invoke,resolvers,scheduled,observe,frame,
    mutate:()=>mutation(),resize:()=>resized(),transition:(value:boolean)=>{transition=value;},block:(value:boolean)=>{blocked=value;mutation();},
    event:(name:string)=>{for(const listener of events.get(name)||[])listener();}};
}

describe('native UI layout follows rendered geometry',()=>{
  it('sends the real capsule radius and percentage elliptical corners',async()=>{
    const state=fixture();await state.frame();
    expect(state.deliveries[0].payload.documentGeneration).toBe(17);
    for(const corner of state.deliveries[0].payload.regions[0].radii){expect(corner[0]).toBeCloseTo(30,10);expect(corner[1]).toBeCloseTo(30,10);}
    Object.assign(state.style,{borderTopLeftRadius:'50% 25%',borderTopRightRadius:'0px',borderBottomRightRadius:'0px',borderBottomLeftRadius:'0px'});
    state.mutate();await state.frame();
    expect(state.deliveries.at(-1)!.payload.regions[0].radii[0]).toEqual([300,15]);
  });

  it('samples every animation frame and stops when geometry transitions finish',async()=>{
    const state=fixture();await state.frame();state.transition(true);state.event('transitionrun');
    for(const width of [500,400,300,200,100,60]){state.rect.width=width;state.resize();await state.frame();}
    expect(state.deliveries.slice(1).map(message=>message.payload.regions[0].width)).toEqual([500,400,300,200,100,60]);
    state.transition(false);state.event('transitionend');await state.frame();
    expect(state.scheduled.size).toBe(0);
    expect(state.observe).toHaveBeenCalledOnce();
  });

  it('keeps full-window blocking and coalesces delayed IPC to the newest shape',async()=>{
    const state=fixture({pending:true});await state.frame();
    for(const width of [500,300,60]){state.rect.width=width;state.mutate();await state.frame();}
    expect(state.deliveries).toHaveLength(1);
    state.block(true);await state.frame();state.resolvers.shift()!();await state.frame();await state.frame();
    expect(state.deliveries).toHaveLength(2);
    expect(state.deliveries[1].payload).toMatchObject({blocked:true,regions:[{width:60}]});
    state.resolvers.shift()!();await state.frame();state.event('pagehide');
    state.rect.width=400;state.resize();await state.frame();expect(state.deliveries).toHaveLength(2);
  });
});
