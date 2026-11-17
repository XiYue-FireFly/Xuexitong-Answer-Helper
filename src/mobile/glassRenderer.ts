import { fitDockLens } from './dockPhysics';
/** Small WebGL 1 optical layer. CSS remains available when GPU rendering is lost. */
export type DockOptics = { x: number; width: number; lift: number; stretch: number; light: number; dark: boolean };
export function createGlassRenderer(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
  if (!gl) return null;
  const vertex = `attribute vec2 point; varying vec2 uv; void main(){uv=(point+1.0)*0.5;gl_Position=vec4(point,0.0,1.0);}`;
  const fragment = `precision mediump float;
    varying vec2 uv; uniform sampler2D scene; uniform vec2 size;
    uniform vec4 lens; uniform float lift; uniform float dark; uniform float light;
    float capsule(vec2 p,vec4 r){vec2 q=abs(p-r.xy)-max(r.zw*0.5-vec2(r.w*0.5),vec2(0.0));return length(max(q,0.0))+min(max(q.x,q.y),0.0)-r.w*0.5;}
    vec3 sampleScene(vec2 p){vec2 t=clamp(p/size,vec2(0.002),vec2(0.998));return texture2D(scene,vec2(t.x,1.0-t.y)).rgb;}
    vec3 pane(vec2 p,vec4 r,float power,float haze){
      float d=capsule(p,r);vec2 n=normalize(vec2(capsule(p+vec2(0.6,0.0),r)-d,capsule(p+vec2(0.0,0.6),r)-d)+0.00001);
      float edge=exp(-abs(d)/4.5);vec2 bend=n*edge*power;
      vec3 c=sampleScene(p+bend);c.r=sampleScene(p+bend+n*edge*2.8).r;c.b=sampleScene(p+bend-n*edge*2.8).b;
      vec3 soft=(sampleScene(p+bend+vec2(3.0,0.0))+sampleScene(p+bend-vec2(3.0,0.0))+sampleScene(p+bend+vec2(0.0,3.0))+sampleScene(p+bend-vec2(0.0,3.0)))*0.25;
      c=mix(c,soft,haze);c=mix(c,mix(vec3(0.91,0.95,1.0),vec3(0.055,0.09,0.15),dark),mix(0.38,0.57,dark));
      float spec=pow(max(0.0,dot(n,normalize(vec2(light,-1.0)))),3.0);
      c+=vec3(0.72,0.87,1.0)*edge*(0.10+0.40*spec);c-=edge*max(0.0,n.y)*0.09;
      return c;
    }
    void main(){vec2 p=vec2(uv.x,1.0-uv.y)*size;
      vec4 bar=vec4(size.x*0.5,size.y*0.5,size.x-4.0,size.y-4.0);
      float db=capsule(p,bar);float dl=capsule(p,lens);
      float ab=1.0-smoothstep(-0.8,0.8,db);float al=(1.0-smoothstep(-0.8,0.8,dl))*mix(0.32,0.96,lift);
      vec3 base=pane(p,bar,8.0,0.75);vec3 top=pane(p,lens,-12.0-lift*5.0,0.1)+vec3(0.04,0.07,0.10);
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
  const uniforms = Object.fromEntries(['size','lens','lift','dark','light'].map(name => [name, gl.getUniformLocation(program!, name)]));
  return {
    image(image: HTMLImageElement) { if (!gl.isContextLost()) { gl.bindTexture(gl.TEXTURE_2D, texture); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image); } },
    draw(width: number, height: number, state: DockOptics) {
      if (gl.isContextLost()) return;
      const ratio = Math.min(devicePixelRatio, 1.75);
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) { canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); }
      gl.viewport(0, 0, canvas.width, canvas.height); gl.useProgram(program);
      const lens = fitDockLens(state.x + state.width / 2, state.width, state.lift, state.stretch, width, height);
      gl.uniform2f(uniforms.size, width, height);
      gl.uniform4f(uniforms.lens, lens.x + lens.width / 2, height / 2, lens.width, lens.height);
      gl.uniform1f(uniforms.lift, state.lift); gl.uniform1f(uniforms.dark, state.dark ? 1 : 0); gl.uniform1f(uniforms.light, state.light);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },
    dispose() { gl.deleteTexture(texture); gl.deleteBuffer(buffer); shaders.forEach(shader => gl.deleteShader(shader)); gl.deleteProgram(program); },
  };
}
