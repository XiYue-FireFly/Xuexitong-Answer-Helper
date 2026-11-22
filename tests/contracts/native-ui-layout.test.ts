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

  function richFixture(viewport={width:1280,height:850}){
    let now=0,next=0;
    const scheduled=new Map<number,()=>void>();
    const events=new Map<string,Set<()=>void>>();
    let mutation:()=>void=()=>{};
    let observerOptions:any=null;
    const dockAttrs=new Map<string,string>();
    const trackAttrs=new Map<string,string>();
    const dockStyle:Record<string,string>={display:'flex',visibility:'visible',borderTopLeftRadius:'9999px',borderTopRightRadius:'9999px',borderBottomRightRadius:'9999px',borderBottomLeftRadius:'9999px'};
    const dockRect={x:100,y:700,width:600,height:60};
    const track={
      getAttribute:(name:string)=>trackAttrs.has(name)?trackAttrs.get(name)!:null,
      dataset:new Proxy({} as Record<string,string>,{
        get:(_t,prop:string)=>trackAttrs.get(`data-${prop}`),
      }),
    };
    const dock={
      offsetWidth:600,offsetHeight:60,parentElement:null,
      classList:{contains:(name:string)=>name==='adaptive-dock'},
      getAttribute:(name:string)=>dockAttrs.has(name)?dockAttrs.get(name)!:null,
      querySelector:(selector:string)=>{
        if(selector.includes('.mobile-tabs__track')&&(trackAttrs.has('data-dragging')||trackAttrs.has('data-pressed')))return track;
        return null;
      },
      getBoundingClientRect:()=>({...dockRect}),
      getAnimations:()=>[],
    };
    const modals=new Map<string,any>();
    const fixedOverlays:Array<{element:any;style:Record<string,string>}>=[];
    const deliveries:{command:string,payload:any}[]=[];
    const invoke=vi.fn(async(_command:string,payload:any)=>{
      if(payload.command==='ui:layout-context')return {documentGeneration:42};
      deliveries.push(payload);
    });
    const styleMap=new WeakMap<object,Record<string,string>>();
    styleMap.set(dock,dockStyle);
    const document={
      documentElement:{clientWidth:viewport.width,clientHeight:viewport.height},
      querySelector:(selector:string)=>{
        for(const [token,node] of modals.entries()){
          if(selector.includes(token))return node;
        }
        return null;
      },
      querySelectorAll:(selector:string)=>{
        if(selector==='.adaptive-dock')return [dock];
        if(selector.includes('.desktop-dismiss'))return [...modals.values()];
        if(selector==='body *')return fixedOverlays.map(item=>item.element);
        if(selector.includes('[style*="fixed"]'))return fixedOverlays.filter(item=>item.element.inlineFixed).map(item=>item.element);
        return [];
      },
    };
    runInNewContext(source,{
      document,
      window:{innerWidth:viewport.width,innerHeight:viewport.height,__TAURI__:{core:{invoke}}},
      getComputedStyle:(element:any)=>styleMap.get(element)||dockStyle,
      requestAnimationFrame:(callback:()=>void)=>{scheduled.set(++next,callback);return next;},
      cancelAnimationFrame:(id:number)=>scheduled.delete(id),
      ResizeObserver:class{observe(){}unobserve(){}disconnect(){}},
      MutationObserver:class{
        constructor(callback:()=>void){mutation=callback;}
        observe(_target:any,options:any){observerOptions=options;}
        disconnect(){}
      },
      addEventListener:(name:string,listener:()=>void)=>{if(!events.has(name))events.set(name,new Set());events.get(name)!.add(listener);},
      removeEventListener:(name:string,listener:()=>void)=>events.get(name)?.delete(listener),
      setTimeout:()=>0,performance:{now:()=>now},
    });
    async function frame(){now+=16;const callbacks=[...scheduled.values()];scheduled.clear();for(const callback of callbacks)callback();for(let i=0;i<16;i++)await Promise.resolve();}
    function addFixedOverlay(options:{
      x?:number;y?:number;width?:number;height?:number;position?:string;display?:string;visibility?:string;opacity?:string;zIndex?:string;pointerEvents?:string;classes?:string[];hidden?:boolean;ariaHidden?:string;inlineFixed?:boolean;explicit?:string;
    }){
      const classes=new Set(options.classes||[]);
      const element={
        hidden:Boolean(options.hidden),
        inlineFixed:options.inlineFixed!==false,
        classList:{contains:(name:string)=>classes.has(name)},
        getAttribute:(name:string)=>name==='aria-hidden'?(options.ariaHidden??null):null,
        getBoundingClientRect:()=>({x:options.x??0,y:options.y??0,width:options.width??viewport.width,height:options.height??viewport.height}),
      };
      const style={
        position:options.position??'fixed',
        display:options.display??'flex',
        visibility:options.visibility??'visible',
        opacity:options.opacity??'1',
        zIndex:options.zIndex??'10000',
        pointerEvents:options.pointerEvents??'auto',
      };
      styleMap.set(element,style);
      fixedOverlays.push({element,style});
      if(options.explicit)modals.set(options.explicit,element);
      mutation();
      return ()=>{const idx=fixedOverlays.findIndex(item=>item.element===element);if(idx>=0)fixedOverlays.splice(idx,1);if(options.explicit)modals.delete(options.explicit);mutation();};
    }
    return {
      dock,dockRect,dockAttrs,trackAttrs,modals,deliveries,frame,addFixedOverlay,
      mutate:()=>mutation(),
      getObserverOptions:()=>observerOptions,
    };
  }

  it('TC-R1-02: expands dock optical bleed by 12px along cross-axis while pressed/dragging and restores on release',async()=>{
    const state=richFixture({width:1280,height:850});
    await state.frame();
    // MutationObserver watches optical lift & modal attributes
    expect(state.getObserverOptions().attributeFilter).toEqual(
      expect.arrayContaining(['data-dragging','data-pressed','data-native-modal','aria-modal','role']),
    );
    // Normal horizontal dock geometry
    expect(state.deliveries.at(-1)!.payload.regions[0]).toMatchObject({x:100,y:700,width:600,height:60});
    expect(state.deliveries.at(-1)!.payload.regions[0].radii[0][0]).toBeCloseTo(30,6);

    // Pressed on nested .mobile-tabs__track expands top/bottom by 12px
    state.trackAttrs.set('data-pressed','true');
    state.mutate();await state.frame();
    const expanded=state.deliveries.at(-1)!.payload.regions[0];
    expect(expanded).toMatchObject({x:100,y:688,width:600,height:84});
    expect(expanded.radii[0][0]).toBeCloseTo(42,6);
    expect(expanded.radii[0][1]).toBeCloseTo(42,6);

    // Release restores exact bounding box immediately
    state.trackAttrs.delete('data-pressed');
    state.mutate();await state.frame();
    expect(state.deliveries.at(-1)!.payload.regions[0]).toMatchObject({x:100,y:700,width:600,height:60});

    // Vertical dock near left edge clamps to viewport x >= 0 while dragging on dock element
    Object.assign(state.dockRect,{x:4,y:200,width:62,height:420});
    state.dock.offsetWidth=62;state.dock.offsetHeight=420;
    state.dockAttrs.set('data-vertical','true');
    state.dockAttrs.set('data-dragging','true');
    state.mutate();await state.frame();
    const verticalExpanded=state.deliveries.at(-1)!.payload.regions[0];
    expect(verticalExpanded).toMatchObject({x:0,y:200,width:78,height:420});
    expect(verticalExpanded.radii[0][0]).toBeCloseTo(39,6);

    // Release vertical dock restores original rect
    state.dockAttrs.delete('data-dragging');
    state.mutate();await state.frame();
    expect(state.deliveries.at(-1)!.payload.regions[0]).toMatchObject({x:4,y:200,width:62,height:420});
  });

  it('TC-R3-01: detects visible fullscreen fixed overlays and [data-native-modal="true"] without false positives',async()=>{
    const state=richFixture({width:1280,height:850});
    await state.frame();
    expect(state.deliveries.at(-1)!.payload.blocked).toBe(false);

    // Fullscreen visible fixed overlay without role="dialog" triggers blocked: true
    const removeNotice=state.addFixedOverlay({width:1280,height:850,zIndex:'10000',display:'flex',visibility:'visible',opacity:'1'});
    await state.frame();
    expect(state.deliveries.at(-1)!.payload.blocked).toBe(true);

    // Closing overlay restores blocked: false
    removeNotice();
    await state.frame();
    expect(state.deliveries.at(-1)!.payload.blocked).toBe(false);

    // Explicit [data-native-modal="true"] triggers blocked: true and clears on removal
    state.modals.set('[data-native-modal="true"]',{});
    state.mutate();await state.frame();
    expect(state.deliveries.at(-1)!.payload.blocked).toBe(true);
    state.modals.clear();
    state.mutate();await state.frame();
    expect(state.deliveries.at(-1)!.payload.blocked).toBe(false);

    // Hidden, zero-size, drag-shield, pointer-events:none, low-zIndex, or small fixed nodes must not block
    const cleanups=[
      state.addFixedOverlay({display:'none'}),
      state.addFixedOverlay({visibility:'hidden'}),
      state.addFixedOverlay({opacity:'0'}),
      state.addFixedOverlay({width:0,height:0}),
      state.addFixedOverlay({classes:['workbench-drag-shield']}),
      state.addFixedOverlay({classes:['mock-page-container']}),
      state.addFixedOverlay({pointerEvents:'none'}),
      state.addFixedOverlay({zIndex:'50'}),
      state.addFixedOverlay({width:400,height:200}),
    ];
    await state.frame();
    expect(state.deliveries.at(-1)!.payload.blocked).toBe(false);
    for(const remove of cleanups)remove();
  });

  it.each([
    {edge:'top',rect:{x:100,y:4,width:600,height:60},expected:{x:100,y:0,width:600,height:76}},
    {edge:'bottom',rect:{x:100,y:736,width:600,height:60},expected:{x:100,y:724,width:600,height:76}},
    {edge:'left',rect:{x:4,y:100,width:60,height:600},expected:{x:0,y:100,width:76,height:600}},
    {edge:'right',rect:{x:936,y:100,width:60,height:600},expected:{x:924,y:100,width:76,height:600}},
  ])('TC-R1-02: clamps optical bleed at $edge and restores on release',async({edge,rect,expected})=>{
    const state=richFixture({width:1000,height:800});
    Object.assign(state.dockRect,rect);
    state.dock.offsetWidth=rect.width;state.dock.offsetHeight=rect.height;
    state.dockAttrs.set('data-edge',edge);
    state.trackAttrs.set('data-dragging','true');
    await state.frame();
    expect(state.deliveries.at(-1)!.payload.regions[0]).toMatchObject(expected);
    state.trackAttrs.set('data-dragging','false');
    state.mutate();await state.frame();
    expect(state.deliveries.at(-1)!.payload.regions[0]).toMatchObject(rect);
  });

  it('TC-R1-02: omits a fully offscreen expanded dock instead of emitting out-of-viewport bounds',async()=>{
    const state=richFixture();
    state.dockRect.x=1500;
    state.dockAttrs.set('data-pressed','true');
    await state.frame();
    expect(state.deliveries.at(-1)!.payload.regions).toEqual([]);
  });

  it('TC-R3-01: detects deeply nested class-styled fixed modals and measures viewport intersection',async()=>{
    const state=richFixture();
    await state.frame();
    const remove=state.addFixedOverlay({inlineFixed:false,classes:['custom-screen']});
    await state.frame();
    expect(state.deliveries.at(-1)!.payload.blocked).toBe(true);
    remove();await state.frame();
    expect(state.deliveries.at(-1)!.payload.blocked).toBe(false);
    for(const position of [{x:1280},{x:-1280},{y:850},{y:-850},{x:500}]){
      const cleanup=state.addFixedOverlay(position);
      await state.frame();
      expect(state.deliveries.at(-1)!.payload.blocked).toBe(false);
      cleanup();await state.frame();
    }
    const removeThreshold=state.addFixedOverlay({width:896,height:595});
    await state.frame();
    expect(state.deliveries.at(-1)!.payload.blocked).toBe(true);
    removeThreshold();await state.frame();
    expect(state.deliveries.at(-1)!.payload.blocked).toBe(false);
  });

  it.each(['.desktop-dismiss','dialog[open]','[role=dialog]','[aria-modal="true"]','[data-native-modal="true"]'])(
    'TC-R3-01: blocks explicit %s only while visible and restores after hiding/removal',async(explicit)=>{
      const state=richFixture();
      await state.frame();
      const removeVisible=state.addFixedOverlay({explicit,width:400,height:200,zIndex:'1'});
      await state.frame();
      expect(state.deliveries.at(-1)!.payload.blocked).toBe(true);
      removeVisible();await state.frame();
      expect(state.deliveries.at(-1)!.payload.blocked).toBe(false);
      for(const hidden of [{display:'none'},{visibility:'hidden'},{opacity:'0'},{hidden:true},{ariaHidden:'true'},{width:0}]){
        const cleanup=state.addFixedOverlay({explicit,...hidden});
        await state.frame();
        expect(state.deliveries.at(-1)!.payload.blocked).toBe(false);
        cleanup();await state.frame();
      }
    },
  );
});
