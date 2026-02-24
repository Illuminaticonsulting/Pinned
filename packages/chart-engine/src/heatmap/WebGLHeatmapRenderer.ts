/**
 * WebGLHeatmapRenderer — WebGL2-based DOM heatmap renderer (VolBook equivalent).
 *
 * Renders order-book depth heatmap on a separate canvas using WebGL2 shaders.
 * Falls back to a Canvas2D flag when WebGL is unavailable.
 */

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface HeatmapAnnotation {
  type: 'iceberg' | 'spoof' | 'absorption' | 'custom';
  priceIndex: number;
  timeIndex: number;
  label?: string;
  color?: string;
}

export interface HeatmapCellUpdate {
  priceIndex: number;
  timeIndex: number;
  intensity: number; // 0-255
}

export interface HeatmapAxisConfig {
  priceMin: number;
  priceMax: number;
  priceStep: number;
  timeOrigin: number; // ms timestamp of column 0
  timeStep: number;   // ms per column
  decimals: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const DATA_WIDTH = 1024;   // price levels
const DATA_HEIGHT = 600;   // time columns

const LEGEND_WIDTH = 32;
const AXIS_OVERLAY_FONT = '11px JetBrains Mono, monospace';

// Color stops used by the transfer function
const COLOR_STOPS: [number, number, number, number][] = [
  //  R     G     B    threshold (0-255 intensity)
  [0x0a, 0x0e, 0x17, 0],     // transparent/dark
  [0x1e, 0x40, 0xaf, 1],     // blue start
  [0x3b, 0x82, 0xf6, 50],    // blue end
  [0x06, 0xb6, 0xd4, 100],   // cyan
  [0xea, 0xb3, 0x08, 150],   // yellow
  [0xf9, 0x73, 0x16, 200],   // orange
  [0xef, 0x44, 0x44, 255],   // red
];

// ─── Shader Sources ────────────────────────────────────────────────────────────

const VERTEX_SHADER_SRC = /* glsl */ `#version 300 es
precision highp float;

const vec2 QUAD[4] = vec2[4](
  vec2(-1.0, -1.0),
  vec2( 1.0, -1.0),
  vec2(-1.0,  1.0),
  vec2( 1.0,  1.0)
);

out vec2 vUV;

void main() {
  vec2 pos = QUAD[gl_VertexID];
  vUV = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER_SRC = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D uDataTex;
in vec2 vUV;
out vec4 fragColor;

// Color transfer function matching the spec:
//   0        = transparent/dark  #0a0e17
//   1-50     = blue              #1e40af → #3b82f6
//   51-100   = cyan              #06b6d4
//   101-150  = yellow            #eab308
//   151-200  = orange            #f97316
//   201-255  = red               #ef4444
vec3 transferColor(float intensity) {
  // Normalize 0-255 → 0.0-1.0 (texture already gives 0-1)
  float v = intensity * 255.0;

  vec3 darkBg   = vec3(0.039, 0.055, 0.090); // #0a0e17
  vec3 blueA    = vec3(0.118, 0.251, 0.686); // #1e40af
  vec3 blueB    = vec3(0.231, 0.510, 0.965); // #3b82f6
  vec3 cyan     = vec3(0.024, 0.714, 0.831); // #06b6d4
  vec3 yellow   = vec3(0.918, 0.702, 0.031); // #eab308
  vec3 orange   = vec3(0.976, 0.451, 0.086); // #f97316
  vec3 red      = vec3(0.937, 0.267, 0.267); // #ef4444

  if (v < 1.0)   return darkBg;

  if (v <= 50.0) {
    float t = (v - 1.0) / 49.0;
    return mix(blueA, blueB, t);
  }
  if (v <= 100.0) {
    float t = (v - 50.0) / 50.0;
    return mix(blueB, cyan, t);
  }
  if (v <= 150.0) {
    float t = (v - 100.0) / 50.0;
    return mix(cyan, yellow, t);
  }
  if (v <= 200.0) {
    float t = (v - 150.0) / 50.0;
    return mix(yellow, orange, t);
  }
  // 201-255
  float t = (v - 200.0) / 55.0;
  return mix(orange, red, t);
}

void main() {
  float intensity = texture(uDataTex, vUV).r;
  vec3 col = transferColor(intensity);
  float alpha = intensity < (1.0 / 255.0) ? 0.0 : 1.0;
  fragColor = vec4(col, alpha);
}
`;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${info}`);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`Program link error: ${info}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return prog;
}

function formatPrice(price: number, decimals: number): string {
  return price.toFixed(decimals);
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

// ─── WebGLHeatmapRenderer ──────────────────────────────────────────────────────

export class WebGLHeatmapRenderer {
  // DOM
  private container: HTMLElement | null = null;
  private glCanvas: HTMLCanvasElement | null = null;
  private overlayCanvas: HTMLCanvasElement | null = null;
  private legendCanvas: HTMLCanvasElement | null = null;
  private wrapper: HTMLDivElement | null = null;

  // WebGL
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private dataTexture: WebGLTexture | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private dataTexLoc: WebGLUniformLocation | null = null;

  // State
  private dataWidth = DATA_WIDTH;
  private dataHeight = DATA_HEIGHT;
  private cpuData: Uint8Array = new Uint8Array(DATA_WIDTH * DATA_HEIGHT);
  private axisConfig: HeatmapAxisConfig = {
    priceMin: 0,
    priceMax: 100000,
    priceStep: 10,
    timeOrigin: Date.now(),
    timeStep: 1000,
    decimals: 2,
  };
  private annotations: HeatmapAnnotation[] = [];
  private webglSupported = true;
  private resizeObserver: ResizeObserver | null = null;
  private destroyed = false;

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Initialize the renderer inside the given container element.
   */
  init(container: HTMLElement): void {
    this.container = container;

    // Wrapper
    this.wrapper = document.createElement('div');
    Object.assign(this.wrapper.style, {
      position: 'relative',
      width: '100%',
      height: '100%',
      overflow: 'hidden',
      background: '#0a0e17',
    } as CSSStyleDeclaration);
    container.appendChild(this.wrapper);

    // WebGL canvas
    this.glCanvas = document.createElement('canvas');
    Object.assign(this.glCanvas.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      width: `calc(100% - ${LEGEND_WIDTH}px)`,
      height: '100%',
    } as CSSStyleDeclaration);
    this.wrapper.appendChild(this.glCanvas);

    // Try WebGL2
    this.gl = this.glCanvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    }) as WebGL2RenderingContext | null;

    if (!this.gl) {
      console.warn('[Heatmap] WebGL2 not available, setting fallback flag');
      this.webglSupported = false;
      return;
    }

    this.initWebGL();

    // 2D overlay for axes
    this.overlayCanvas = document.createElement('canvas');
    Object.assign(this.overlayCanvas.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      width: `calc(100% - ${LEGEND_WIDTH}px)`,
      height: '100%',
      pointerEvents: 'none',
    } as CSSStyleDeclaration);
    this.wrapper.appendChild(this.overlayCanvas);

    // Legend canvas
    this.legendCanvas = document.createElement('canvas');
    Object.assign(this.legendCanvas.style, {
      position: 'absolute',
      top: '0',
      right: '0',
      width: `${LEGEND_WIDTH}px`,
      height: '100%',
    } as CSSStyleDeclaration);
    this.wrapper.appendChild(this.legendCanvas);

    // Resize handling
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);

    this.resize();
    this.drawLegend();
  }

  /** Whether WebGL is available (if not, use Canvas2DHeatmapFallback). */
  get isWebGLSupported(): boolean {
    return this.webglSupported;
  }

  /**
   * Upload an entire heatmap data blob.
   * The blob is expected to be an ArrayBuffer containing packed heatmap data.
   */
  setData(blob: ArrayBuffer): void {
    const headerSize = 8; // 4 bytes width + 4 bytes height
    if (blob.byteLength < headerSize) return;

    const view = new DataView(blob);
    const width = view.getUint32(0, true);
    const height = view.getUint32(4, true);
    const pixelData = new Uint8Array(blob, headerSize, width * height);

    this.setFullData(pixelData, width, height);
  }

  /**
   * Upload the full data texture.
   */
  setFullData(data: Uint8Array, width: number, height: number): void {
    this.dataWidth = width;
    this.dataHeight = height;
    this.cpuData = new Uint8Array(data);

    if (!this.gl || !this.dataTexture) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.dataTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8,
      width,
      height,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      this.cpuData,
    );
    this.render();
  }

  /**
   * Partial cell update via texSubImage2D.
   */
  updateCells(cells: HeatmapCellUpdate[]): void {
    if (!this.gl || !this.dataTexture) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.dataTexture);

    for (const cell of cells) {
      const { priceIndex, timeIndex, intensity } = cell;
      if (
        priceIndex < 0 || priceIndex >= this.dataWidth ||
        timeIndex < 0 || timeIndex >= this.dataHeight
      ) continue;

      // Update CPU copy
      this.cpuData[timeIndex * this.dataWidth + priceIndex] = intensity & 0xff;

      // Upload single pixel
      const pixel = new Uint8Array([intensity & 0xff]);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        priceIndex,
        timeIndex,
        1,
        1,
        gl.RED,
        gl.UNSIGNED_BYTE,
        pixel,
      );
    }

    this.render();
  }

  /**
   * Add an annotation overlay marker.
   */
  addAnnotation(event: HeatmapAnnotation): void {
    this.annotations.push(event);
    this.drawOverlay();
  }

  /**
   * Update the axis configuration for price/time labels.
   */
  setAxisConfig(config: Partial<HeatmapAxisConfig>): void {
    Object.assign(this.axisConfig, config);
    this.drawOverlay();
  }

  /**
   * Handle resize.
   */
  resize(): void {
    if (this.destroyed || !this.wrapper) return;

    const rect = this.wrapper.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const heatmapW = Math.floor(rect.width - LEGEND_WIDTH);
    const h = Math.floor(rect.height);

    // GL canvas
    if (this.glCanvas) {
      this.glCanvas.width = heatmapW * dpr;
      this.glCanvas.height = h * dpr;
      if (this.gl) {
        this.gl.viewport(0, 0, this.glCanvas.width, this.glCanvas.height);
      }
    }

    // Overlay canvas
    if (this.overlayCanvas) {
      this.overlayCanvas.width = heatmapW * dpr;
      this.overlayCanvas.height = h * dpr;
    }

    // Legend canvas
    if (this.legendCanvas) {
      this.legendCanvas.width = LEGEND_WIDTH * dpr;
      this.legendCanvas.height = h * dpr;
    }

    this.render();
    this.drawLegend();
  }

  /**
   * Tear down all resources.
   */
  destroy(): void {
    this.destroyed = true;
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.gl) {
      if (this.dataTexture) this.gl.deleteTexture(this.dataTexture);
      if (this.vao) this.gl.deleteVertexArray(this.vao);
      if (this.program) this.gl.deleteProgram(this.program);
      this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    if (this.wrapper && this.container) {
      this.container.removeChild(this.wrapper);
    }
    this.gl = null;
    this.program = null;
    this.dataTexture = null;
    this.vao = null;
    this.glCanvas = null;
    this.overlayCanvas = null;
    this.legendCanvas = null;
    this.wrapper = null;
    this.container = null;
    this.annotations = [];
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private initWebGL(): void {
    const gl = this.gl!;

    // Compile program
    this.program = createProgram(gl, VERTEX_SHADER_SRC, FRAGMENT_SHADER_SRC);
    this.dataTexLoc = gl.getUniformLocation(this.program, 'uDataTex');

    // Vertex array (empty — we use gl_VertexID)
    this.vao = gl.createVertexArray()!;

    // Data texture
    this.dataTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.dataTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Allocate initial empty texture
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8,
      this.dataWidth,
      this.dataHeight,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      this.cpuData,
    );

    // Blending
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  private render(): void {
    if (!this.gl || !this.program || !this.vao || this.destroyed) return;
    const gl = this.gl;

    gl.clearColor(0.039, 0.055, 0.090, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.dataTexture);
    gl.uniform1i(this.dataTexLoc, 0);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    this.drawOverlay();
  }

  private drawOverlay(): void {
    if (!this.overlayCanvas) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.overlayCanvas.getContext('2d');
    if (!ctx) return;

    const w = this.overlayCanvas.width / dpr;
    const h = this.overlayCanvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    this.drawPriceAxis(ctx, w, h);
    this.drawTimeAxis(ctx, w, h);
    this.drawAnnotations(ctx, w, h);
  }

  private drawPriceAxis(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const { priceMin, priceMax, priceStep, decimals } = this.axisConfig;
    const range = priceMax - priceMin;
    if (range <= 0) return;

    ctx.font = AXIS_OVERLAY_FONT;
    ctx.fillStyle = '#9ca3af';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    const labelCount = Math.floor(range / priceStep);
    const maxLabels = Math.min(labelCount, 30);
    const step = labelCount > 0 ? Math.ceil(labelCount / maxLabels) * priceStep : priceStep;

    for (let price = priceMin; price <= priceMax; price += step) {
      const y = h - ((price - priceMin) / range) * h;
      if (y < 10 || y > h - 10) continue;

      // Tick line
      ctx.strokeStyle = 'rgba(156, 163, 175, 0.15)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();

      // Label
      ctx.fillStyle = '#9ca3af';
      ctx.fillText(formatPrice(price, decimals), 4, y);
    }
  }

  private drawTimeAxis(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const { timeOrigin, timeStep } = this.axisConfig;
    if (timeStep <= 0) return;

    ctx.font = AXIS_OVERLAY_FONT;
    ctx.fillStyle = '#6b7280';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    // Show labels every ~80px
    const colWidth = w / this.dataHeight;
    const labelInterval = Math.max(1, Math.floor(80 / colWidth));

    for (let col = 0; col < this.dataHeight; col += labelInterval) {
      const x = (col / this.dataHeight) * w;
      const ts = timeOrigin + col * timeStep;
      ctx.fillText(formatTime(ts), x, h - 2);
    }
  }

  private drawAnnotations(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    for (const ann of this.annotations) {
      const x = (ann.timeIndex / this.dataHeight) * w;
      const y = h - (ann.priceIndex / this.dataWidth) * h;

      const color = ann.color ?? this.getAnnotationColor(ann.type);

      // Marker circle
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      // Border
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Icon / label
      ctx.font = '9px Inter, sans-serif';
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const icon = this.getAnnotationIcon(ann.type);
      ctx.fillText(icon, x, y);

      // Label below
      if (ann.label) {
        ctx.font = '10px Inter, sans-serif';
        ctx.fillStyle = color;
        ctx.textBaseline = 'top';
        ctx.fillText(ann.label, x, y + 8);
      }
    }
  }

  private getAnnotationColor(type: HeatmapAnnotation['type']): string {
    switch (type) {
      case 'iceberg': return '#3b82f6';
      case 'spoof': return '#f97316';
      case 'absorption': return '#22c55e';
      default: return '#a855f7';
    }
  }

  private getAnnotationIcon(type: HeatmapAnnotation['type']): string {
    switch (type) {
      case 'iceberg': return '🧊';
      case 'spoof': return '👻';
      case 'absorption': return '⬤';
      default: return '●';
    }
  }

  private drawLegend(): void {
    if (!this.legendCanvas) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.legendCanvas.getContext('2d');
    if (!ctx) return;

    const w = this.legendCanvas.width / dpr;
    const h = this.legendCanvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = '#111827';
    ctx.fillRect(0, 0, w, h);

    // Gradient bar
    const barX = 4;
    const barW = w - 8;
    const barTop = 24;
    const barBottom = h - 24;
    const barH = barBottom - barTop;

    for (let i = 0; i < barH; i++) {
      const intensity = Math.round(((barH - i) / barH) * 255);
      const color = this.intensityToCSS(intensity);
      ctx.fillStyle = color;
      ctx.fillRect(barX, barTop + i, barW, 1);
    }

    // Border
    ctx.strokeStyle = '#374151';
    ctx.lineWidth = 1;
    ctx.strokeRect(barX, barTop, barW, barH);

    // Labels
    ctx.font = '9px JetBrains Mono, monospace';
    ctx.fillStyle = '#9ca3af';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('High', w / 2, barTop - 4);
    ctx.textBaseline = 'top';
    ctx.fillText('Low', w / 2, barBottom + 4);
  }

  private intensityToCSS(v: number): string {
    if (v < 1) return '#0a0e17';
    for (let i = 1; i < COLOR_STOPS.length; i++) {
      const prev = COLOR_STOPS[i - 1]!;
      const curr = COLOR_STOPS[i]!;
      const [r0, g0, b0, t0] = prev;
      const [r1, g1, b1, t1] = curr;
      if (v <= t1) {
        const t = t1 === t0 ? 1 : (v - t0) / (t1 - t0);
        const r = Math.round(r0 + (r1 - r0) * t);
        const g = Math.round(g0 + (g1 - g0) * t);
        const b = Math.round(b0 + (b1 - b0) * t);
        return `rgb(${r},${g},${b})`;
      }
    }
    return '#ef4444';
  }
}
