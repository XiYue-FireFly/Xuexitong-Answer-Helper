import { DOCK_OPTICAL_BLEED, fitDockLens } from './dockPhysics';
import type { BrowserBounds } from '../platform/nativeWebViewPlugin';
/** Small WebGL 1 optical layer. CSS remains available when GPU rendering is lost. */
export type DockOptics = { x: number; width: number; lift: number; stretch: number; light: number; dark: boolean; originX: number; originY: number };
export function createGlassRenderer(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
  if (!gl) return null;
  const vertex = `attribute vec2 point; varying vec2 uv; void main(){uv=(point+1.0)*0.5;gl_Position=vec4(point,0.0,1.0);}`;
  const fragment = `precision mediump float;
    varying vec2 uv; uniform sampler2D scene; uniform vec2 size; uniform float barHeight; uniform vec4 sceneFrame;
    uniform vec4 lens; uniform float lift; uniform float dark; uniform float light;
    float capsule(vec2 p,vec4 r){float radius=min(r.z,r.w)*0.5;vec2 q=abs(p-r.xy)-r.zw*0.5+radius;return length(max(q,0.0))+min(max(q.x,q.y),0.0)-radius;}
    vec3 sampleScene(vec2 p){vec2 t=clamp(sceneFrame.xy+p*sceneFrame.zw,vec2(0.002),vec2(0.998));return texture2D(scene,t).rgb;}
    vec3 blurredScene(vec2 p,float radius){
      vec3 c=sampleScene(p)*0.20;
      c+=(sampleScene(p+vec2(radius,0.0))+sampleScene(p-vec2(radius,0.0))+sampleScene(p+vec2(0.0,radius))+sampleScene(p-vec2(0.0,radius)))*0.12;
      vec2 a=vec2(radius*0.7);c+=(sampleScene(p+a)+sampleScene(p-a)+sampleScene(p+vec2(a.x,-a.y))+sampleScene(p+vec2(-a.x,a.y)))*0.08;
      return c;
    }
    vec3 pane(vec2 p,vec4 r,float raised){
      float d=capsule(p,r);vec2 n=normalize(vec2(capsule(p+vec2(0.6,0.0),r)-d,capsule(p+vec2(0.0,0.6),r)-d)+0.00001);
      float depth=max(-d,0.0);float bevel=mix(10.0,7.0,raised);
      float slope=1.0-clamp(depth/bevel,0.0,1.0);
      float curve=1.0-sqrt(max(0.0,1.0-slope*slope));
      vec2 insetRay=-n*curve*16.0;
      vec2 liftedRay=n*(10.0+lift*7.0)*smoothstep(0.0,bevel,depth)*(1.0-smoothstep(bevel,r.w*0.5,depth));
      vec2 ray=p+mix(insetRay,liftedRay,raised);
      float spread=(1.0-smoothstep(2.0,11.0,depth))*mix(2.0,4.0,raised);
      vec3 c=sampleScene(ray);c.r=sampleScene(ray+n*spread).r;c.b=sampleScene(ray-n*spread).b;
      c=mix(c,blurredScene(ray,mix(3.0,1.0,raised)),mix(0.16,0.06,raised));
      float luma=dot(c,vec3(0.2126,0.7152,0.0722));c=mix(vec3(luma),c,1.22);
      vec3 tint=mix(vec3(0.96,0.98,1.0),vec3(0.045,0.065,0.10),dark);
      c=mix(c,tint,mix(0.07,0.16,dark)*mix(1.0,0.40,raised));
      float rim=exp(-depth/1.35);float spec=pow(max(0.0,dot(n,normalize(vec2(light*0.4,-1.0)))),2.0);
      c+=(vec3(1.0)-c)*rim*(0.22+0.5*spec);c-=rim*abs(n.x)*0.10;
      c+=vec3(0.04)*raised*lift*exp(-dot(p-r.xy,p-r.xy)/900.0);
      return c;
    }
    void main(){vec2 p=vec2(uv.x,1.0-uv.y)*size;
      vec4 bar=vec4(size.x*0.5,size.y*0.5,size.x-4.0,barHeight-4.0+lift*2.0);
      float db=capsule(p,bar);float dl=capsule(p,lens);
      float ab=1.0-smoothstep(-0.8,0.8,db);float al=(1.0-smoothstep(-0.8,0.8,dl))*mix(0.50,0.96,lift);
      vec3 base=pane(p,bar,0.0);vec3 rest=mix(base,mix(vec3(0.65,0.80,1.0),vec3(0.10,0.18,0.29),dark),0.28);
      vec3 top=mix(rest,pane(p,lens,1.0),clamp(lift,0.0,1.0));
      float alpha=max(ab,al);vec3 color=mix(base,top,al);
      float rim=(1.0-smoothstep(0.0,1.0,abs(dl)))*mix(0.15,0.58,lift);color+=vec3(rim);
      gl_FragColor=vec4(color*alpha,alpha);
    }`;
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!; gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { gl.deleteShader(shader); throw new Error('Glass shader unavailable'); }
    return shader;
  };
  let program: WebGLProgram | null = null;
  const shaders: WebGLShader[] = [];
  try {
    shaders.push(compile(gl.VERTEX_SHADER, vertex)); shaders.push(compile(gl.FRAGMENT_SHADER, fragment));
    program = gl.createProgram()!; shaders.forEach(shader => gl.attachShader(program!, shader)); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Glass program unavailable');
  } catch { shaders.forEach(shader => gl.deleteShader(shader)); if (program) gl.deleteProgram(program); return null; }
  gl.useProgram(program);
  const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
  const point = gl.getAttribLocation(program, 'point'); gl.enableVertexAttribArray(point); gl.vertexAttribPointer(point, 2, gl.FLOAT, false, 0, 0);
  const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([70,104,153,255]));
  const uniforms = Object.fromEntries(['size','lens','lift','dark','light','sceneFrame','barHeight'].map(name => [name, gl.getUniformLocation(program!, name)]));
  let bounds: BrowserBounds = { x: 0, y: 0, width: 1, height: 1 };
  return {
    image(image: HTMLImageElement, region: BrowserBounds) { if (!gl.isContextLost()) { bounds = region; gl.bindTexture(gl.TEXTURE_2D, texture); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image); } },
    draw(width: number, height: number, state: DockOptics) {
      if (gl.isContextLost()) return;
      const ratio = Math.min(devicePixelRatio, 1.75);
      const opticalHeight = height + DOCK_OPTICAL_BLEED * 2;
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(opticalHeight * ratio)) { canvas.width = Math.round(width * ratio); canvas.height = Math.round(opticalHeight * ratio); }
      gl.viewport(0, 0, canvas.width, canvas.height); gl.useProgram(program);
      const lens = fitDockLens(state.x + state.width / 2, state.width, state.lift, state.stretch, width, height);
      gl.uniform2f(uniforms.size, width, opticalHeight); gl.uniform1f(uniforms.barHeight, height);
      gl.uniform4f(uniforms.sceneFrame, (state.originX - bounds.x) / bounds.width, (state.originY - DOCK_OPTICAL_BLEED - bounds.y) / bounds.height, 1 / bounds.width, 1 / bounds.height);
      gl.uniform4f(uniforms.lens, lens.x + lens.width / 2, opticalHeight / 2, lens.width, lens.height);
      gl.uniform1f(uniforms.lift, state.lift); gl.uniform1f(uniforms.dark, state.dark ? 1 : 0); gl.uniform1f(uniforms.light, state.light);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },
    dispose() { gl.deleteTexture(texture); gl.deleteBuffer(buffer); shaders.forEach(shader => gl.deleteShader(shader)); gl.deleteProgram(program); },
  };
}
