// Afterglow renderer. WebGL2, three stages:
//   1. glow cache   design -> frame space -> blurred bloom (1/2 res) + halo (1/8 res).
//                   Rebuilt only when the design, its placement, sizes or resolution change.
//   2. composite    background (cover fit + grade) + design blend + halo + bloom + vignette -> comp FBO
//   3. final        chromatic aberration + grain -> canvas
// Per video frame only stages 2 and 3 run: a handful of texture taps per pixel.

const VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS_PLACE = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uDesign;
uniform vec4 uRect;   // x0, y0, w, h in frame uv (GL, y up)
out vec4 o;
void main() {
  vec2 d = (vUv - uRect.xy) / uRect.zw;
  // sample first, mask after: a texture() call inside a branch has undefined mip derivatives at the
  // rect edge, which some GPUs turn into a coarse mip and a bright 1 px line along the edge
  vec4 s = texture(uDesign, d);
  o = s * (step(0.0, d.x) * step(0.0, d.y) * step(d.x, 1.0) * step(d.y, 1.0));
}`;

const FS_BLUR = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uStep;
uniform float uSigma;   // texels
out vec4 o;
void main() {
  if (uSigma < 0.35) { o = texture(uSrc, vUv); return; }
  int R = int(min(ceil(uSigma * 3.0), 64.0));
  float k = -0.5 / (uSigma * uSigma);
  vec4 acc = vec4(0.0); float ws = 0.0;
  for (int i = -R; i <= R; i++) {
    float w = exp(float(i * i) * k);
    acc += texture(uSrc, vUv + uStep * float(i)) * w;
    ws += w;
  }
  o = acc / ws;
}`;

const FS_COMP = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uBg, uDesign, uBloom, uHalo;
uniform vec2 uRes, uBgSize;
uniform vec3 uBgX;          // zoom, panX, panY (-1..1)
uniform int uHasBg, uHasDesign;
uniform vec4 uRect;
uniform int uBlend;
uniform float uStrength;
uniform int uGlowOn, uHaloBlend;
uniform float uHaloAmt, uBloomAmt;
uniform float uExposure, uContrast, uSat;
uniform int uVigOn;
uniform float uVig, uVigStart;
out vec4 o;

vec3 blendOf(vec3 b, vec3 s, int m) {
  if (m == 0) return s;
  if (m == 1) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b));
  if (m == 2) return 1.0 - (1.0 - b) * (1.0 - s);
  return b + s;
}
vec3 layer(vec3 b, vec4 p, float amt, int m) {
  if (p.a <= 0.0005 || amt <= 0.0) return b;
  vec3 s = clamp(p.rgb / p.a, 0.0, 1.0);
  return clamp(mix(b, blendOf(b, s, m), p.a * amt), 0.0, 1.0);
}

void main() {
  vec2 uv = vUv;
  vec3 c = vec3(0.0);
  if (uHasBg == 1) {
    float fa = uRes.x / uRes.y, ba = uBgSize.x / uBgSize.y;
    vec2 s = fa > ba ? vec2(1.0, ba / fa) : vec2(fa / ba, 1.0);
    s /= uBgX.x;
    vec2 buv = 0.5 + (uv - 0.5) * s + uBgX.yz * (1.0 - s) * 0.5;
    c = texture(uBg, buv).rgb;
    c *= exp2(uExposure);
    c = (c - 0.5) * (1.0 + uContrast) + 0.5;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = clamp(mix(vec3(l), c, 1.0 + uSat), 0.0, 1.0);
  }
  if (uHasDesign == 1) {
    vec2 d = (uv - uRect.xy) / uRect.zw;
    vec4 p = texture(uDesign, d) * (step(0.0, d.x) * step(0.0, d.y) * step(d.x, 1.0) * step(d.y, 1.0)); // see FS_PLACE
    vec4 h = uGlowOn == 1 ? texture(uHalo, uv) : vec4(0.0);
    vec3 bl = uGlowOn == 1 ? texture(uBloom, uv).rgb : vec3(0.0);
    // Amounts above 100% stack a second copy, interleaved like duplicating the
    // (design, halo, bloom) group in Figma. Matches the GN frame to ~1.6% mean error.
    for (int g = 0; g < 2; g++) {
      float ks = g == 0 ? min(uStrength, 1.0) : max(uStrength - 1.0, 0.0);
      float kh = g == 0 ? min(uHaloAmt, 1.0) : max(uHaloAmt - 1.0, 0.0);
      c = layer(c, p, ks, uBlend);
      if (uGlowOn == 1) {
        c = layer(c, h, kh, uHaloBlend);
        c = min(c + bl * (uBloomAmt * 0.5), 1.0);
      }
    }
  }
  if (uVigOn == 1 && uVig > 0.0) {
    vec2 q = (uv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
    float r = length(q) / length(vec2(uRes.x / uRes.y, 1.0) * 0.5);
    float a = clamp((r - uVigStart) / 0.39, 0.0, 1.0) * uVig;
    vec3 ov = mix(vec3(0.0), 2.0 * c - 1.0, step(0.5, c));   // overlay with black
    c = mix(c, ov, a);
  }
  o = vec4(c, 1.0);
}`;

const FS_FINAL = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uComp;
uniform vec2 uRes;
uniform float uRef;          // render px per reference px (1080p short side)
uniform int uCaOn, uCaMode, uCaSpectral, uCaMaxN;
uniform float uCaAmt, uCaFalloff;
uniform vec2 uCaDir;
uniform int uGrOn, uGrMono;
uniform float uGrAmt, uGrSize;
uniform uint uSeed;
out vec4 o;

uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
float gauss(ivec2 c, uint s) {
  vec3 u = vec3(pcg3d(uvec3(uvec2(c), s))) * (1.0 / 4294967295.0);
  return (u.x + u.y + u.z - 1.5) * 2.0;
}
float vnoise(vec2 g, uint s) {
  vec2 i = floor(g), f = fract(g);
  f = f * f * (3.0 - 2.0 * f);
  ivec2 c = ivec2(i);
  return mix(mix(gauss(c, s), gauss(c + ivec2(1, 0), s), f.x), mix(gauss(c + ivec2(0, 1), s), gauss(c + ivec2(1, 1), s), f.x), f.y);
}
float grain(vec2 p, float cell, uint s) {
  if (cell <= 1.0) return gauss(ivec2(floor(p)), s);
  vec2 g = p / cell;
  return (vnoise(g, s) + vnoise(mat2(0.8, -0.6, 0.6, 0.8) * g + 19.7, s + 77u)) * 0.95;
}
float bump(float x, float c, float w) { float d = (x - c) / w; return max(0.0, 1.0 - d * d); }
vec3 spectrum(float t) { float h = t * 0.5 + 0.5; return vec3(bump(h, 0.80, 0.42), bump(h, 0.5, 0.3), bump(h, 0.20, 0.42)); }
vec3 samp(vec2 p) { return texture(uComp, p / uRes).rgb; }

void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 c = uRes * 0.5;
  float hd = length(c);
  vec2 off = vec2(0.0);
  if (uCaOn == 1 && uCaAmt > 0.0) {
    float A = uCaAmt * uRef;
    if (uCaMode == 0) {
      vec2 d = (p - c) / hd; float r = length(d);
      off = r > 1e-5 ? d / r * A * pow(r, uCaFalloff) : vec2(0.0);
    } else off = uCaDir * A;
  }
  vec3 col;
  float L = length(off);
  if (L > 0.05) {
    if (uCaSpectral == 1) {
      int n = int(clamp(ceil(2.0 * L / 1.25) + 1.0, 3.0, float(uCaMaxN)));
      vec3 acc = vec3(0.0), ws = vec3(0.0);
      for (int i = 0; i < 48; i++) {
        if (i >= n) break;
        float t = (float(i) + 0.5) / float(n) * 2.0 - 1.0;
        vec3 w = spectrum(t);
        acc += samp(p + off * t) * w; ws += w;
      }
      col = acc / ws;
    } else {
      col = vec3(samp(p + off).r, samp(p).g, samp(p - off).b);
    }
  } else col = samp(p);

  if (uGrOn == 1 && uGrAmt > 0.0) {
    float cell = max(uGrSize * uRef, 1.0);
    vec3 n = uGrMono == 1 ? vec3(grain(p, cell, uSeed))
      : vec3(grain(p, cell, uSeed), grain(p, cell, uSeed + 1013u), grain(p, cell, uSeed + 2027u));
    col = clamp(col + n * (uGrAmt * 0.32), 0.0, 1.0);
  }
  o = vec4(col, 1.0);
}`;

function compile(gl, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
  return { p, u };
}

const BLEND = { normal: 0, overlay: 1, screen: 2, add: 3 };

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL 2 is not available');
    this.gl = gl;
    this.half = !!gl.getExtension('EXT_color_buffer_float');   // 16F targets: no banding in soft glows
    this.progs = { place: compile(gl, FS_PLACE), blur: compile(gl, FS_BLUR), comp: compile(gl, FS_COMP), final: compile(gl, FS_FINAL) };
    this.vao = gl.createVertexArray();
    this.bg = { tex: null, w: 0, h: 0 };
    this.design = { tex: null, w: 0, h: 0 };
    this.targets = {};
    // 1x1 transparent stand-in for unused samplers, so no unit is left pointing at a render target
    // (e.g. comp.tex from the last final pass), which WebGL treats as a feedback loop and skips the draw.
    this.blank = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.blank);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    this.glowKey = '';
    this.size = [0, 0];
  }

  _tex(w, h, float) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, float && this.half ? gl.RGBA16F : gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  _target(name, w, h) {
    const gl = this.gl;
    let t = this.targets[name];
    if (t && t.w === w && t.h === h) return t;
    if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
    const tex = this._tex(w, h, true);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    t = this.targets[name] = { tex, fb, w, h };
    return t;
  }
  _draw(prog, target) {
    const gl = this.gl;
    if (target) { gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb); gl.viewport(0, 0, target.w, target.h); }
    else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.canvas.width, this.canvas.height); }
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  _bind(prog, name, unit, tex) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(prog.u[name], unit);
  }

  // Background: HTMLVideoElement or HTMLImageElement. Call uploadBackground() on every new video frame.
  setBackground(el, w, h) {
    this.bgEl = el;
    this.bg.w = w; this.bg.h = h;
    if (!el) return;
    this.uploadBackground();
  }
  uploadBackground() {
    const gl = this.gl, el = this.bgEl;
    if (!el) return;
    if (!this.bg.tex) {
      this.bg.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.bg.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.bg.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el);
  }

  // Design: image or canvas (transparent). Premultiplied + mipmapped.
  // fit = frame-width fraction the design covers at size 100 (1 for images, auto-fit width for text).
  setDesign(img, fit = 1) {
    const gl = this.gl;
    if (this.design.tex) { gl.deleteTexture(this.design.tex); this.design.tex = null; }
    this.glowKey = '';
    if (!img) { this.design.w = this.design.h = 0; return; }
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.design = { tex: t, w: img.naturalWidth || img.width, h: img.naturalHeight || img.height, fit };
  }

  // Design rect in GL frame uv from UI state (x, y = center % from top-left; size = % of frame width)
  designRect(S, W, H) {
    const d = this.design;
    if (!d.tex) return [0, 0, 1, 1];
    const w = S.design.size / 100 * (d.fit || 1);
    const h = w * (W / H) / (d.w / d.h);
    const cx = S.design.x / 100, cy = 1 - S.design.y / 100;
    return [cx - w / 2, cy - h / 2, w, h];
  }

  _buildGlow(S, W, H, rect, ref) {
    const gl = this.gl;
    const key = [W, H, rect.join(','), S.glow.haloSize, S.glow.bloomSize, this.design.tex ? 1 : 0].join('|');
    if (key === this.glowKey) return;
    this.glowKey = key;
    const bw = Math.max(4, Math.round(W / 2)), bh = Math.max(4, Math.round(H / 2));
    const hw = Math.max(4, Math.round(W / 8)), hh = Math.max(4, Math.round(H / 8));
    const bA = this._target('bloomA', bw, bh), bB = this._target('bloomB', bw, bh);
    const hA = this._target('haloA', hw, hh), hB = this._target('haloB', hw, hh);
    const place = this.progs.place, blur = this.progs.blur;
    gl.useProgram(place.p);
    this._bind(place, 'uDesign', 0, this.design.tex);
    gl.uniform4f(place.u.uRect, rect[0], rect[1], rect[2], rect[3]);
    this._draw(place, bA);
    this._draw(place, hA);
    const pass = (A, B, sigma) => {
      gl.useProgram(blur.p);
      this._bind(blur, 'uSrc', 0, A.tex);
      gl.uniform2f(blur.u.uStep, 1 / A.w, 0); gl.uniform1f(blur.u.uSigma, sigma);
      this._draw(blur, B);
      this._bind(blur, 'uSrc', 0, B.tex);
      gl.uniform2f(blur.u.uStep, 0, 1 / A.h);
      this._draw(blur, A);
    };
    pass(bA, bB, S.glow.bloomSize * ref / 2);
    pass(hA, hB, S.glow.haloSize * ref / 8);
  }

  // q: { scale: render size factor vs canvas, caMaxN, seed }
  render(S, q) {
    const gl = this.gl;
    const W = this.canvas.width, H = this.canvas.height;
    const ref = Math.min(W, H) / 1080;
    const comp = this._target('comp', W, H);
    const hasDesign = !!this.design.tex;
    const rect = this.designRect(S, W, H);
    if (hasDesign && S.glow.on) this._buildGlow(S, W, H, rect, ref);

    const c = this.progs.comp;
    gl.useProgram(c.p);
    gl.uniform2f(c.u.uRes, W, H);
    gl.uniform1i(c.u.uHasBg, this.bg.tex && this.bgEl ? 1 : 0);
    this._bind(c, 'uBg', 0, this.bg.tex || this.blank);
    this._bind(c, 'uDesign', 1, this.blank);
    this._bind(c, 'uBloom', 2, this.blank);
    this._bind(c, 'uHalo', 3, this.blank);
    gl.uniform2f(c.u.uBgSize, this.bg.w || 1, this.bg.h || 1);
    gl.uniform3f(c.u.uBgX, S.video.zoom / 100, S.video.panX / 100, -S.video.panY / 100);
    gl.uniform1f(c.u.uExposure, S.video.exposure / 100);
    gl.uniform1f(c.u.uContrast, S.video.contrast / 100);
    gl.uniform1f(c.u.uSat, S.video.saturation / 100);
    gl.uniform1i(c.u.uHasDesign, hasDesign ? 1 : 0);
    if (hasDesign) {
      this._bind(c, 'uDesign', 1, this.design.tex);
      gl.uniform4f(c.u.uRect, rect[0], rect[1], rect[2], rect[3]);
      gl.uniform1i(c.u.uBlend, BLEND[S.design.blend]);
      gl.uniform1f(c.u.uStrength, S.design.strength / 100);
      const glowOn = S.glow.on && this.targets.bloomA;
      gl.uniform1i(c.u.uGlowOn, glowOn ? 1 : 0);
      if (glowOn) {
        this._bind(c, 'uBloom', 2, this.targets.bloomA.tex);
        this._bind(c, 'uHalo', 3, this.targets.haloA.tex);
        gl.uniform1f(c.u.uHaloAmt, S.glow.halo / 100);
        gl.uniform1i(c.u.uHaloBlend, BLEND[S.glow.haloBlend]);
        gl.uniform1f(c.u.uBloomAmt, S.glow.bloom / 100);
      }
    }
    gl.uniform1i(c.u.uVigOn, S.look.on ? 1 : 0);
    gl.uniform1f(c.u.uVig, S.look.vignette / 100);
    gl.uniform1f(c.u.uVigStart, 1.2 - S.look.spread / 100 * 0.9);
    this._draw(c, comp);

    const f = this.progs.final;
    gl.useProgram(f.p);
    this._bind(f, 'uComp', 0, comp.tex);
    gl.uniform2f(f.u.uRes, W, H);
    gl.uniform1f(f.u.uRef, ref);
    const a = S.ca.angle * Math.PI / 180;
    gl.uniform1i(f.u.uCaOn, S.ca.on ? 1 : 0);
    gl.uniform1i(f.u.uCaMode, S.ca.mode === 'radial' ? 0 : 1);
    gl.uniform1i(f.u.uCaSpectral, S.ca.style === 'spectral' ? 1 : 0);
    gl.uniform1i(f.u.uCaMaxN, q.caMaxN || 32);
    gl.uniform1f(f.u.uCaAmt, S.ca.amount);
    gl.uniform1f(f.u.uCaFalloff, S.ca.falloff);
    gl.uniform2f(f.u.uCaDir, Math.cos(a), Math.sin(a));
    gl.uniform1i(f.u.uGrOn, S.grain.on ? 1 : 0);
    gl.uniform1i(f.u.uGrMono, S.grain.color === 'mono' ? 1 : 0);
    gl.uniform1f(f.u.uGrAmt, S.grain.amount / 100);
    gl.uniform1f(f.u.uGrSize, S.grain.size);
    gl.uniform1ui(f.u.uSeed, (q.seed >>> 0) + 1);
    this._draw(f, null);
  }
}
