import React, { useEffect, useRef } from "react";

type RGB = readonly [number, number, number];
type RGBA = [number, number, number, number];

type ColorTree = {
  transparent: RGB;
  trail: {
    main: RGB;
  };
  center: {
    stage1: RGB;
    stage2: RGB;
    stage3: RGB;
    stage4: RGB;
  };
  point: {
    main: RGB;
  };
  border: {
    tip: RGB;
    core: RGB;
    final: RGB;
  };
  triangle: {
    stage1: RGB;
    stage2: RGB;
    stage3: RGB;
    stage4: RGB;
  };
};

type TrailPoint = {
  x: number;
  y: number;
  life: number;
};

type TriangleParticle = {
  angle: number;
  flipY: 1 | -1;
  peakSize: number;
  pulsePhase: number;
  pulsePeriodFrames: number;
};

type TrailSideParticle = {
  bornAt: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  peakSize: number;
  flipY: 1 | -1;
  pulsePhase: number;
  pulsePeriodFrames: number;
};

type ClickEffect = {
  x: number;
  y: number;
  bornAt: number;
  strength: number;
  tris: TriangleParticle[];
  border: {
    innerAnchorAngle: number;
    outerAnchorAngle: number;
    gapRatio: number;
  };
};

type MouseSparkOptions = {
  color?: string;
  scale?: number;
  opacity?: number;
  speed?: number;
  maxTrail?: number;
  enableGlow?: boolean;
};

type BACometProps = {
  className?: string;
  enableGlow?: boolean;
};

declare global {
  interface Window {
    currentInputMode?: "mouse" | "touch";
    enableAlwaysTrailEffect?: boolean;
    effectiveAlwaysTrail?: boolean;
    setInputContext?: (mode: string, alwaysTrailEnabled: boolean) => void;
    externalBoom?: (percentX: number, percentY: number) => void;
    externalMove?: (percentX: number, percentY: number) => void;
    externalUp?: () => void;
    updateColor?: (rgbString: string) => void;
    updateEffectSettings?: (scale: number, opacity: number, speed: number) => void;
    updateBorderBehavior?: (
      growCW: number,
      growCCW: number,
      shrinkCW: number,
      shrinkCCW: number,
      gapRatioMin: number,
      gapRatioMax: number
    ) => void;
    updateGlowSoftness?: (centerSoftness: number, borderSoftness: number) => void;
    updateGlowSettings?: (
      centerGlowRadius: number,
      borderGlowRadius: number,
      centerGlowIntensity: number,
      borderGlowIntensity: number
    ) => void;
    updateTrailGlow?: (
      radius: number,
      intensity: number,
      softness: number,
      spacing: number
    ) => void;
    updateTrailTriangleBehavior?: (
      minSpawnDistance: number,
      spawnProbability: number,
      minCenterOffset: number,
      maxCenterOffset: number,
      maxRadialDistance: number,
      normalConeDeg: number
    ) => void;
  }
}

const hexToRgb = (hex: string): RGB => {
  const clean = hex.replace("#", "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  const num = Number.parseInt(full, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
};

const FX_ORIGIN_COLOR = Object.freeze({
  transparent: "#000000",
  trail: {
    main: "#00FEFF",
  },
  center: {
    stage1: "#FFFFFF",
    stage2: "#cae0ff",
    stage3: "#4381ee",
    stage4: "#5084dd",
  },
  point: {
    main: "#4FAFC5",
  },
  border: {
    tip: "#d6f8ff",
    core: "#dcfdff",
    final: "#5efcff",
  },
  triangle: {
    stage1: "#FFFFFF",
    stage2: "#e9fffd",
    stage3: "#b4fffd",
    stage4: "#9cfffd",
  },
});

const FX_COLOR: ColorTree = Object.freeze({
  transparent: hexToRgb(FX_ORIGIN_COLOR.transparent),
  trail: {
    main: hexToRgb(FX_ORIGIN_COLOR.trail.main),
  },
  center: {
    stage1: hexToRgb(FX_ORIGIN_COLOR.center.stage1),
    stage2: hexToRgb(FX_ORIGIN_COLOR.center.stage2),
    stage3: hexToRgb(FX_ORIGIN_COLOR.center.stage3),
    stage4: hexToRgb(FX_ORIGIN_COLOR.center.stage4),
  },
  point: {
    main: hexToRgb(FX_ORIGIN_COLOR.point.main),
  },
  border: {
    tip: hexToRgb(FX_ORIGIN_COLOR.border.tip),
    core: hexToRgb(FX_ORIGIN_COLOR.border.core),
    final: hexToRgb(FX_ORIGIN_COLOR.border.final),
  },
  triangle: {
    stage1: hexToRgb(FX_ORIGIN_COLOR.triangle.stage1),
    stage2: hexToRgb(FX_ORIGIN_COLOR.triangle.stage2),
    stage3: hexToRgb(FX_ORIGIN_COLOR.triangle.stage3),
    stage4: hexToRgb(FX_ORIGIN_COLOR.triangle.stage4),
  },
});

const rgba = (rgb: RGB, a = 1): RGBA => [rgb[0], rgb[1], rgb[2], a];
const rgbString = (rgb: RGB): string => `${rgb[0]},${rgb[1]},${rgb[2]}`;
const fillRgba = (count: number, rgb: RGB, a = 1): RGBA[] =>
  Array.from({ length: count }, () => rgba(rgb, a));
const fillTransparent = (count: number): RGBA[] =>
  Array.from({ length: count }, () => rgba(FX_COLOR.transparent, 0));

class GlowLayer {
  private canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext;
  private points: number[] = [];
  private viewW = 1;
  private viewH = 1;
  private dpr = 1;

  private program!: WebGLProgram;
  private buffer!: WebGLBuffer;
  private aPos = -1;
  private aSize = -1;
  private aColor = -1;
  private aSoftness = -1;
  private aIntensity = -1;
  private uResolution: WebGLUniformLocation | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) {
      throw new Error("WebGL is not available");
    }
    this.gl = gl;
    this.initGL();
  }

  private createShader(type: number, source: string): WebGLShader {
    const shader = this.gl.createShader(type);
    if (!shader) throw new Error("Failed to create shader");
    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);
    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      const msg = this.gl.getShaderInfoLog(shader) ?? "Shader compile failed";
      this.gl.deleteShader(shader);
      throw new Error(msg);
    }
    return shader;
  }

  private createProgram(vsSource: string, fsSource: string): WebGLProgram {
    const vs = this.createShader(this.gl.VERTEX_SHADER, vsSource);
    const fs = this.createShader(this.gl.FRAGMENT_SHADER, fsSource);

    const program = this.gl.createProgram();
    if (!program) throw new Error("Failed to create WebGL program");

    this.gl.attachShader(program, vs);
    this.gl.attachShader(program, fs);
    this.gl.linkProgram(program);

    this.gl.deleteShader(vs);
    this.gl.deleteShader(fs);

    if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
      const msg = this.gl.getProgramInfoLog(program) ?? "Program link failed";
      this.gl.deleteProgram(program);
      throw new Error(msg);
    }
    return program;
  }

  private initGL(): void {
    const vsSource = `
      attribute vec2 a_pos;
      attribute float a_size;
      attribute vec4 a_color;
      attribute float a_intensity;
      attribute float a_softness;
      uniform vec2 u_resolution;
      varying vec4 v_color;
      varying float v_intensity;
      varying float v_softness;
      void main() {
        vec2 clip = (a_pos / u_resolution) * 2.0 - 1.0;
        gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
        gl_PointSize = a_size;
        v_color = a_color;
        v_intensity = a_intensity;
        v_softness = a_softness;
      }
    `;

    const fsSource = `
      precision highp float;
      varying vec4 v_color;
      varying float v_intensity;
      varying float v_softness;
      void main() {
        vec2 uv = gl_PointCoord * 2.0 - 1.0;
        float r = length(uv);
        if (r > 1.0) discard;
        float s = max(0.2, v_softness);
        float sigma1 = mix(0.16, 0.42, clamp((s - 0.5) / 2.0, 0.0, 1.0));
        float sigma2 = sigma1 * 1.9;
        float g1 = exp(-(r * r) / (2.0 * sigma1 * sigma1));
        float g2 = exp(-(r * r) / (2.0 * sigma2 * sigma2));
        float halo = 0.62 * g1 + 0.38 * g2;
        halo = max(0.0, halo - 0.08);
        float alpha = halo * v_color.a * v_intensity;
        gl_FragColor = vec4(v_color.rgb, alpha);
      }
    `;

    this.program = this.createProgram(vsSource, fsSource);
    this.aPos = this.gl.getAttribLocation(this.program, "a_pos");
    this.aSize = this.gl.getAttribLocation(this.program, "a_size");
    this.aColor = this.gl.getAttribLocation(this.program, "a_color");
    this.aSoftness = this.gl.getAttribLocation(this.program, "a_softness");
    this.aIntensity = this.gl.getAttribLocation(this.program, "a_intensity");
    this.uResolution = this.gl.getUniformLocation(this.program, "u_resolution");

    const buffer = this.gl.createBuffer();
    if (!buffer) throw new Error("Failed to create WebGL buffer");
    this.buffer = buffer;

    this.gl.enable(this.gl.DEPTH_TEST);
    this.gl.enable(this.gl.BLEND);
    this.gl.depthMask(false);
    this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
  }

  resize(viewW: number, viewH: number, dpr: number): void {
    this.viewW = viewW;
    this.viewH = viewH;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.floor(viewW * dpr));
    this.canvas.height = Math.max(1, Math.floor(viewH * dpr));
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  beginFrame(): void {
    this.points.length = 0;
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  addPoint(x: number, y: number, radius: number, color: RGBA, intensity = 1, softness = 1): void {
    if (radius <= 0) return;
    if (!color || color[3] <= 0.0001) return;

    const sizePx = radius * 2 * this.dpr;
    this.points.push(
      x,
      y,
      sizePx,
      color[0] / 255,
      color[1] / 255,
      color[2] / 255,
      color[3],
      intensity,
      softness
    );
  }

  flush(): void {
    if (this.points.length === 0) return;

    const data = new Float32Array(this.points);
    this.gl.useProgram(this.program);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, data, this.gl.DYNAMIC_DRAW);

    const stride = 9 * 4;
    this.gl.enableVertexAttribArray(this.aPos);
    this.gl.vertexAttribPointer(this.aPos, 2, this.gl.FLOAT, false, stride, 0);

    this.gl.enableVertexAttribArray(this.aSize);
    this.gl.vertexAttribPointer(this.aSize, 1, this.gl.FLOAT, false, stride, 2 * 4);

    this.gl.enableVertexAttribArray(this.aColor);
    this.gl.vertexAttribPointer(this.aColor, 4, this.gl.FLOAT, false, stride, 3 * 4);

    this.gl.enableVertexAttribArray(this.aIntensity);
    this.gl.vertexAttribPointer(this.aIntensity, 1, this.gl.FLOAT, false, stride, 7 * 4);

    this.gl.enableVertexAttribArray(this.aSoftness);
    this.gl.vertexAttribPointer(this.aSoftness, 1, this.gl.FLOAT, false, stride, 8 * 4);

    this.gl.uniform2f(this.uResolution, this.viewW, this.viewH);
    this.gl.drawArrays(this.gl.POINTS, 0, data.length / 9);
  }
}

class MouseSparkEngine {
  private c: HTMLCanvasElement;

  private ctx: CanvasRenderingContext2D;
  private readonly glowCanvas: HTMLCanvasElement | null;
  private readonly glow: GlowLayer | null = null;

  private viewW = 1;
  private viewH = 1;

  private animationId = 0;
  private cleanupFns: Array<() => void> = [];

  color: string;
  scale: number;
  opacity: number;
  speed: number;
  maxTrail: number;
  centerGlowRadius = 300;
  borderGlowRadius = 30;
  centerGlowIntensity = 0.8;
  borderGlowIntensity = 0.45;
  centerGlowSoftness = 0;
  borderGlowSoftness = 0.9;
  borderGrowCwRate = 2;
  borderGrowCcwRate = 1;
  borderShrinkCwRate = 1;
  borderShrinkCcwRate = 3;
  trailGlowRadius = 40;
  trailGlowIntensity = 0.24;
  trailGlowSoftness = 6.9;
  trailGlowSpacing = 1;
  trailSideParticles: TrailSideParticle[] = [];
  lastTrailSideSpawnPos: { x: number; y: number } | null = null;
  trailTriMinSpawnDistance = 30;
  trailTriSpawnProbability = 0.9;
  trailTriMinCenterOffset = 10;
  trailTriMaxCenterOffset = 18;
  trailTriMaxRadialDistance = 30;
  trailTriNormalConeDeg = 120;
  borderGapRatioMin = 0;
  borderGapRatioMax = 1;
  effects: ClickEffect[] = [];
  trail: TrailPoint[] = [];
  isDown = false;
  lastPos: { x: number; y: number } | null = null;
  enableGlow = false;

  private tracks!: {
    centerColor: RGBA[];
    centerDiameter: number[];
    centerLightRadius: number[];
    pointDiameter: number[];
    pointLightRadius: number[];
    pointColor: RGBA[];
    borderAngle: number[];
    borderMaxWidth: number[];
    borderShrinkAngle: number[];
    maxBorderDistance: number[];
    scaleBaseRadius: number[];
    triaColorRef: RGBA[];
    triaPulseMode: string[];
    triaScaleRate: number[];
    triaDistance: number[];
    triaMaxAt7: number[];
    triaMinAt7: number[];
    triaOpacityMin: number[];
  };

  private FRAME_COUNT = 44;
  private FPS = 60;
  private DURATION_SEC = 44 / 60;
  private borderTipColor: RGBA = rgba(FX_COLOR.border.tip, 1);
  private borderCoreColor: RGBA = rgba(FX_COLOR.border.core, 1);
  private borderFinalColor: RGBA = rgba(FX_COLOR.border.final, 1);
  private borderPeakAngle = 360;
  private borderPeakFrame = 9;

  constructor(
    canvas: HTMLCanvasElement,
    glowCanvas: HTMLCanvasElement | null,
    opts: MouseSparkOptions = {}
  ) {
    this.c = canvas;
    this.glowCanvas = glowCanvas;

    const ctx = this.c.getContext("2d");
    if (!ctx) throw new Error("2D canvas context is not available");
    this.ctx = ctx;

    this.color = opts.color || rgbString(FX_COLOR.trail.main);
    this.scale = opts.scale || 1.5;
    this.opacity = opts.opacity || 1;
    this.speed = opts.speed || 1;
    this.maxTrail = opts.maxTrail || 16;
    this.enableGlow = Boolean(opts.enableGlow && glowCanvas);

    if (this.enableGlow && this.glowCanvas) {
      this.glow = new GlowLayer(this.glowCanvas);
    }

    this.initTracks();
    this.resize();
    this.bindEvents();
    this.loop = this.loop.bind(this);
    this.animationId = window.requestAnimationFrame(this.loop);
  }

  clamp(v: number, a: number, b: number): number {
    return Math.max(a, Math.min(b, v));
  }

  linearInterpolate(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }

  smoothstep01(t: number): number {
    t = this.clamp(t, 0, 1);
    return t * t * (3 - 2 * t);
  }

  easeOutCubic(t: number): number {
    t = this.clamp(t, 0, 1);
    return 1 - Math.pow(1 - t, 3);
  }

  alpha(v: number): number {
    return this.clamp(v, 0, 1) * this.opacity;
  }

  deg2rad(d: number): number {
    return (d * Math.PI) / 180;
  }

  rand(a: number, b: number): number {
    return a + Math.random() * (b - a);
  }

  normalize2D(x: number, y: number): { x: number; y: number } {
    const len = Math.hypot(x, y);
    if (len < 1e-6) return { x: 1, y: 0 };
    return { x: x / len, y: y / len };
  }

  rotate2D(x: number, y: number, rad: number): { x: number; y: number } {
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    return { x: x * c - y * s, y: x * s + y * c };
  }

  distance2D(a: { x: number; y: number }, b: { x: number; y: number }): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  computeMaxOutwardTravel(startOffset: number, maxRadial: number, deltaAbsRad: number): number {
    const c = Math.cos(deltaAbsRad);
    const s = Math.sin(deltaAbsRad);
    const disc = maxRadial * maxRadial - startOffset * startOffset * s * s;
    if (disc <= 0) return 0;
    return Math.max(0, -startOffset * c + Math.sqrt(disc));
  }

  rgbaToString(c: RGBA): string {
    return `rgba(${c[0]},${c[1]},${c[2]},${this.clamp(c[3], 0, 1)})`;
  }

  mixColor(a: RGBA, b: RGBA, t: number): RGBA {
    return [
      Math.round(this.linearInterpolate(a[0], b[0], t)),
      Math.round(this.linearInterpolate(a[1], b[1], t)),
      Math.round(this.linearInterpolate(a[2], b[2], t)),
      this.linearInterpolate(a[3], b[3], t),
    ];
  }

  rgbStringToRgba(value: string, alphaValue = 1): RGBA {
    const parts = String(value)
      .split(",")
      .map((v) => Number(v.trim()));
    if (parts.length < 3 || parts.some((v) => !Number.isFinite(v))) {
      return [255, 255, 255, alphaValue];
    }
    return [
      this.clamp(parts[0], 0, 255),
      this.clamp(parts[1], 0, 255),
      this.clamp(parts[2], 0, 255),
      alphaValue,
    ];
  }

  addTrailGlowSegment(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    headColor: RGBA,
    tailColor: RGBA,
    headAlpha: number,
    tailAlpha: number
  ): void {
    if (!this.glow) return;

    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) return;

    const step = Math.max(2, this.trailGlowSpacing);
    const count = Math.max(1, Math.ceil(len / step));

    for (let i = 0; i <= count; i++) {
      const u = i / count;
      const x = this.linearInterpolate(x0, x1, u);
      const y = this.linearInterpolate(y0, y1, u);
      const col = this.mixColor(headColor, tailColor, u);
      col[3] = this.linearInterpolate(headAlpha, tailAlpha, u);
      this.glow.addPoint(
        x,
        y,
        this.trailGlowRadius * this.scale,
        col,
        this.trailGlowIntensity,
        this.trailGlowSoftness
      );
    }
  }

  resolveNumericTrack(raw: Array<number | null>): number[] {
    const out = raw.map((v) => (v == null ? null : Number(v)));
    const first = out.findIndex((v) => v != null && Number.isFinite(v));
    if (first === -1) return raw.map(() => 0);

    for (let i = 0; i < first; i++) out[i] = out[first];

    let lastKnown = first;
    for (let i = first + 1; i < out.length; i++) {
      if (out[i] != null && Number.isFinite(out[i])) {
        const v0 = out[lastKnown] as number;
        const v1 = out[i] as number;
        const gap = i - lastKnown;
        for (let k = 1; k < gap; k++) {
          out[lastKnown + k] = this.linearInterpolate(v0, v1, k / gap);
        }
        lastKnown = i;
      }
    }

    for (let i = lastKnown + 1; i < out.length; i++) out[i] = out[lastKnown];
    return out as number[];
  }

  sampleNumeric(track: number[], framePos1: number): number {
    const pos = this.clamp(framePos1 - 1, 0, track.length - 1);
    const i0 = Math.floor(pos);
    const i1 = Math.min(track.length - 1, i0 + 1);
    const t = pos - i0;
    return this.linearInterpolate(track[i0], track[i1], t);
  }

  sampleColor(track: RGBA[], framePos1: number): RGBA {
    const pos = this.clamp(framePos1 - 1, 0, track.length - 1);
    const i0 = Math.floor(pos);
    const i1 = Math.min(track.length - 1, i0 + 1);
    const t = pos - i0;
    return this.mixColor(track[i0], track[i1], t);
  }

  sampleStep(track: string[], framePos1: number): string {
    const idx = this.clamp(Math.floor(framePos1 - 1 + 1e-6), 0, track.length - 1);
    return track[idx];
  }

  initTracks(): void {
    const N = 44;
    const fill = (count: number, value: number | string): Array<number | string> =>
      Array.from({ length: count }, () => value);

    const RAW = {
      centerColor: [
        rgba(FX_COLOR.center.stage1, 1),
        rgba(FX_COLOR.center.stage2, 0.9),
        rgba(FX_COLOR.center.stage3, 0.9),
        ...fillRgba(10, FX_COLOR.center.stage4, 0.5),
        ...fillTransparent(31),
      ],
      centerDiameter: [
        15,
        23.7,
        30.3,
        34.2,
        37,
        39.6,
        41.7,
        43.4,
        44.6,
        44.6,
        44.6,
        44.6,
        44.6,
        ...Array.from({ length: 31 }, () => 0),
      ],
      centerLightRadius: [
        ...Array.from({ length: 13 }, () => 35),
        ...Array.from({ length: 31 }, () => 0),
      ],
      pointDiameter: [
        0,
        0,
        1,
        ...Array.from({ length: 16 }, () => 2),
        ...Array.from({ length: 25 }, () => 0),
      ],
      pointLightRadius: [
        0,
        0,
        1,
        ...Array.from({ length: 16 }, () => 2.18),
        ...Array.from({ length: 25 }, () => 0),
      ],
      pointColor: [
        ...fillTransparent(2),
        rgba(FX_COLOR.point.main, 0.5),
        ...fillRgba(16, FX_COLOR.point.main, 0.5),
        ...fillTransparent(25),
      ],
      borderAngle: [
        0.0, 0.0, 12.98, 67.18, 116.7, 171.5, 228.1, 295.8, 360.0, 308.3, 269.6, 240.0, 219.1,
        200.96, 185.43, 167.99, 155.9, 143.6, 133.45, 123.1, 109.8, 99.0, 94.1, 87.0, 74.3, 68.0,
        64.2, 51.6, 46.5, 41.1, 36.0, 29.9, 21.5, 19.8, 13.0, 11.3, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 0.0,
      ],
      borderMaxWidth: Array.from({ length: N }, () => 2),
      borderShrinkAngle: Array.from({ length: N }, () => 20),
      maxBorderDistance: Array.from({ length: N }, () => 2.43),
      scaleBaseRadius: [
        0,
        0,
        30.3 / 2,
        32.5 / 2,
        34.8 / 2,
        null,
        null,
        null,
        42.4 / 2,
        42.8 / 2,
        null,
        null,
        null,
        48.6 / 2,
        null,
        null,
        null,
        null,
        52.4 / 2,
        null,
        null,
        null,
        null,
        55.2 / 2,
        null,
        null,
        null,
        null,
        56.2 / 2,
        null,
        null,
        null,
        null,
        56.6 / 2,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ] as Array<number | null>,
      triaColorRef: [
        ...fillRgba(9, FX_COLOR.triangle.stage1, 1),
        rgba(FX_COLOR.triangle.stage2, 1),
        rgba(FX_COLOR.triangle.stage3, 0.9),
        ...fillRgba(33, FX_COLOR.triangle.stage4, 0.8),
      ],
      triaPulseMode: [
        ...(fill(11, "None") as string[]),
        ...(fill(19, "Dynamic_Opacity") as string[]),
        ...(fill(4, "Transition") as string[]),
        ...(fill(10, "None") as string[]),
      ],
      triaScaleRate: [
        0.0, 0.09, 0.25, 0.45, 0.69, 0.91, 1.0, 0.99, 0.97, 0.97, 0.96, 0.91, 0.91, 0.89, 0.88,
        0.86, 0.85, 0.83, 0.82, 0.8, 0.78, 0.77, 0.73, 0.69, 0.64, 0.6, 0.56, 0.52, 0.48, 0.44, 0.4,
        0.35, 0.31, 0.28, 0.24, 0.21, 0.16, 0.11, 0.05, 0.0, 0.0, 0.0, 0.0, 0.0,
      ],
      triaDistance: [
        20.0, 20.45, 21.07, 21.24, 21.42, 21.78, 22.25, 22.71, 23.02, 23.44, 23.89, 24.26, 24.71,
        25.4, 25.86, 26.31, 26.71, 27.22, 27.69, 28.17, 28.71, 29.27, 29.62, 29.92, 30.4, 30.93,
        31.28, 31.71, 32.27, 32.78, 33.21, 33.75, 34.1, 34.54, 35.1, 35.46, 35.91, 36.3, 36.91,
        37.0, 37.0, 37.0, 37.0, 37.0,
      ],
      triaMaxAt7: Array.from({ length: N }, () => 14.357 / 2),
      triaMinAt7: Array.from({ length: N }, () => 9.48 / 2),
      triaOpacityMin: Array.from({ length: N }, () => 0.3),
    };

    this.FRAME_COUNT = N;
    this.FPS = 60;
    this.DURATION_SEC = N / this.FPS;

    this.tracks = {
      centerColor: RAW.centerColor,
      centerDiameter: this.resolveNumericTrack(RAW.centerDiameter),
      centerLightRadius: this.resolveNumericTrack(RAW.centerLightRadius),
      pointDiameter: this.resolveNumericTrack(RAW.pointDiameter),
      pointLightRadius: this.resolveNumericTrack(RAW.pointLightRadius),
      pointColor: RAW.pointColor,
      borderAngle: this.resolveNumericTrack(RAW.borderAngle),
      borderMaxWidth: this.resolveNumericTrack(RAW.borderMaxWidth),
      borderShrinkAngle: this.resolveNumericTrack(RAW.borderShrinkAngle),
      maxBorderDistance: this.resolveNumericTrack(RAW.maxBorderDistance),
      scaleBaseRadius: this.resolveNumericTrack(RAW.scaleBaseRadius),
      triaColorRef: RAW.triaColorRef,
      triaPulseMode: RAW.triaPulseMode.slice(),
      triaScaleRate: this.resolveNumericTrack(RAW.triaScaleRate),
      triaDistance: this.resolveNumericTrack(RAW.triaDistance),
      triaMaxAt7: this.resolveNumericTrack(RAW.triaMaxAt7),
      triaMinAt7: this.resolveNumericTrack(RAW.triaMinAt7),
      triaOpacityMin: this.resolveNumericTrack(RAW.triaOpacityMin),
    };

    this.borderTipColor = rgba(FX_COLOR.border.tip, 1);
    this.borderCoreColor = rgba(FX_COLOR.border.core, 1);
    this.borderFinalColor = rgba(FX_COLOR.border.final, 1);

    this.borderPeakAngle = Math.max(...this.tracks.borderAngle);
    this.borderPeakFrame = this.tracks.borderAngle.findIndex((v) => v === this.borderPeakAngle) + 1;
  }

  resize = (): void => {
    const dpr = window.devicePixelRatio || 1;
    this.viewW = window.innerWidth;
    this.viewH = window.innerHeight;
    this.c.width = this.viewW * dpr;
    this.c.height = this.viewH * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.glow?.resize(this.viewW, this.viewH, dpr);
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    this.isDown = true;
    this.lastPos = { x: e.clientX, y: e.clientY };
    this.spawnEffect(e.clientX, e.clientY, 1.0);
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.isDown && !window.effectiveAlwaysTrail) return;
    const p = { x: e.clientX, y: e.clientY };
    if (!this.lastPos) this.lastPos = p;

    const prev = { x: this.lastPos.x, y: this.lastPos.y };
    if (Math.hypot(p.x - prev.x, p.y - prev.y) > 2) {
      this.trail.push({ x: p.x, y: p.y, life: 1 });
      this.maybeSpawnTrailSideParticles(prev, p);
      this.lastPos = p;
      if (this.trail.length > this.maxTrail) this.trail.shift();
    }
  };

  private onMouseUp = (): void => {
    this.isDown = false;
  };

  bindEvents(): void {
    window.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mouseup", this.onMouseUp);
    this.cleanupFns.push(() => window.removeEventListener("mousedown", this.onMouseDown));
    this.cleanupFns.push(() => window.removeEventListener("mousemove", this.onMouseMove));
    this.cleanupFns.push(() => window.removeEventListener("mouseup", this.onMouseUp));
    window.addEventListener("resize", this.resize);
    this.cleanupFns.push(() => window.removeEventListener("resize", this.resize));
  }

  spawnEffect(x: number, y: number, strength = 1): void {
    const minSize = this.sampleNumeric(this.tracks.triaMinAt7, 7);
    const maxSize = this.sampleNumeric(this.tracks.triaMaxAt7, 7);
    const angles: number[] = [];
    const minSep = Math.PI / 5.5;

    while (angles.length < 4) {
      const a = Math.random() * Math.PI * 2;
      if (
        angles.every((v) => {
          let d = Math.abs(v - a);
          d = Math.min(d, Math.PI * 2 - d);
          return d > minSep;
        })
      ) {
        angles.push(a);
      }
    }

    const triData: TriangleParticle[] = Array.from({ length: 4 }, () => ({
      angle: angles.pop() ?? 0,
      flipY: Math.random() < 0.5 ? 1 : -1,
      peakSize: this.rand(minSize, maxSize) * strength,
      pulsePhase: Math.random() * Math.PI * 2,
      pulsePeriodFrames: this.rand(4.4 * 1.2, 5.8 * 1.2),
    }));

    this.effects.push({
      x,
      y,
      bornAt: performance.now(),
      strength,
      tris: triData,
      border: {
        innerAnchorAngle: Math.random() * Math.PI * 2,
        outerAnchorAngle: Math.random() * Math.PI * 2,
        gapRatio: this.rand(this.borderGapRatioMin, this.borderGapRatioMax),
      },
    });
  }

  maybeSpawnTrailSideParticles(
    prevPos: { x: number; y: number },
    currPos: { x: number; y: number }
  ): void {
    const mid = {
      x: this.linearInterpolate(prevPos.x, currPos.x, 0.5),
      y: this.linearInterpolate(prevPos.y, currPos.y, 0.5),
    };

    if (
      this.lastTrailSideSpawnPos &&
      this.distance2D(mid, this.lastTrailSideSpawnPos) < this.trailTriMinSpawnDistance
    ) {
      return;
    }
    if (Math.random() > this.trailTriSpawnProbability) return;
    this.spawnTrailSideParticleBurst(prevPos, currPos);
    this.lastTrailSideSpawnPos = mid;
  }

  spawnTrailSideParticleBurst(
    prevPos: { x: number; y: number },
    currPos: { x: number; y: number }
  ): void {
    const seg = { x: currPos.x - prevPos.x, y: currPos.y - prevPos.y };
    const tangent = this.normalize2D(seg.x, seg.y);
    const dice = Math.random() > 0.5 ? -1 : 1;
    const normal = { x: -tangent.y * dice, y: tangent.x * dice };

    const minSize = this.sampleNumeric(this.tracks.triaMinAt7, 7);
    const maxSize = this.sampleNumeric(this.tracks.triaMaxAt7, 7);
    const maxCenterOffset = Math.min(
      this.trailTriMaxCenterOffset,
      this.trailTriMaxRadialDistance - 1
    );
    if (maxCenterOffset <= this.trailTriMinCenterOffset) return;

    const coneHalfRad = this.deg2rad(this.trailTriNormalConeDeg * 0.5);
    const u = this.rand(0.2, 0.8);
    const base = {
      x: this.linearInterpolate(prevPos.x, currPos.x, u),
      y: this.linearInterpolate(prevPos.y, currPos.y, u),
    };

    const startOffset = this.rand(this.trailTriMinCenterOffset, maxCenterOffset);
    const spawnX = base.x + normal.x * startOffset;
    const spawnY = base.y + normal.y * startOffset;
    const delta = this.rand(-coneHalfRad, coneHalfRad);
    const moveDir = this.rotate2D(normal.x, normal.y, delta);
    const maxTravel = this.computeMaxOutwardTravel(
      startOffset,
      this.trailTriMaxRadialDistance,
      Math.abs(delta)
    );
    if (maxTravel < 2) return;

    const outwardTravel = this.rand(Math.max(2, maxTravel * 0.45), maxTravel);
    const endX = spawnX + moveDir.x * outwardTravel;
    const endY = spawnY + moveDir.y * outwardTravel;

    this.trailSideParticles.push({
      bornAt: performance.now(),
      x0: spawnX,
      y0: spawnY,
      x1: endX,
      y1: endY,
      peakSize: this.rand(minSize, maxSize),
      flipY: Math.random() < 0.5 ? 1 : -1,
      pulsePhase: Math.random() * Math.PI * 4,
      pulsePeriodFrames: this.rand(4.4 * 0.8, 5.8 * 0.8),
    });
  }

  renderTrailSideParticle(particle: TrailSideParticle, now: number): boolean {
    const elapsed = ((now - particle.bornAt) / 1000) * this.speed * 1.5;
    if (elapsed < 0) return false;
    if (elapsed > this.DURATION_SEC) return true;

    const lifeT = this.clamp(elapsed / this.DURATION_SEC, 0, 1);
    const framePos1 = 1 + lifeT * (this.FRAME_COUNT - 1);
    const triaColor = this.sampleColor(this.tracks.triaColorRef, framePos1);
    const triaMode = this.sampleStep(this.tracks.triaPulseMode, framePos1);
    const triaScaleRate = this.sampleNumeric(this.tracks.triaScaleRate, framePos1);
    const triaOpacityMin = this.sampleNumeric(this.tracks.triaOpacityMin, framePos1);

    const moveT = 1 - Math.pow(1 - lifeT, 3);
    const x = this.linearInterpolate(particle.x0, particle.x1, moveT);
    const y = this.linearInterpolate(particle.y0, particle.y1, moveT);
    const size = particle.peakSize * triaScaleRate;
    const alpha = this.computeTriangleAlpha(framePos1, particle, triaMode, triaOpacityMin);

    this.drawTriangle(x, y, size, triaColor, alpha, particle.flipY);
    return false;
  }

  drawGlowDisc(
    x: number,
    y: number,
    radius: number,
    color: RGBA,
    alphaMul = 1,
    intensity = 1
  ): void {
    if (!this.glow || radius <= 0) return;
    const c: RGBA = [color[0], color[1], color[2], color[3] * this.alpha(alphaMul)];
    if (c[3] <= 0.001) return;
    this.glow.addPoint(x, y, radius, c, intensity, this.centerGlowSoftness);
  }

  drawSolidDisc(x: number, y: number, diameter: number, color: RGBA, alphaMul = 1): void {
    const r = diameter * 0.5;
    if (r <= 0) return;
    const c: RGBA = [color[0], color[1], color[2], color[3] * this.alpha(alphaMul)];
    if (c[3] <= 0.001) return;
    this.ctx.fillStyle = this.rgbaToString(c);
    this.ctx.beginPath();
    this.ctx.arc(x, y, r, 0, Math.PI * 2);
    this.ctx.fill();
  }

  drawTrail(): void {
    for (let i = this.trail.length - 1; i >= 0; i--) {
      const t = this.trail[i];
      if (window.effectiveAlwaysTrail) {
        t.life -= 0.085 * this.speed * 0.55;
      } else {
        t.life -= (this.isDown ? 0.085 : 0.18) * this.speed * 0.55;
      }
      if (t.life <= 0) this.trail.splice(i, 1);
    }

    if (this.trail.length < 2) return;
    const n = this.trail.length;
    const trailBase = this.rgbStringToRgba(this.color, 1);
    const glowBase = this.rgbStringToRgba(this.color, 1);

    const sampleTrailColor = (u: number, alphaScale = 1): RGBA => {
      const fade = u <= 0.6 ? 1 : this.linearInterpolate(1, 0, (u - 0.6) / 0.4);
      return [trailBase[0], trailBase[1], trailBase[2], alphaScale * fade];
    };

    for (let i = 0; i < n - 1; i++) {
      const p0 = this.trail[i];
      const p1 = this.trail[i + 1];
      const a0 = this.easeOutCubic(p0.life);
      const a1 = this.easeOutCubic(p1.life);
      if (a0 <= 0.001 && a1 <= 0.001) continue;

      const u0 = 1 - i / (n - 1);
      const u1 = 1 - (i + 1) / (n - 1);
      const c0 = sampleTrailColor(u0, this.alpha(a0));
      const c1 = sampleTrailColor(u1, this.alpha(a1));
      const segGrad = this.ctx.createLinearGradient(p0.x, p0.y, p1.x, p1.y);
      segGrad.addColorStop(0, this.rgbaToString(c0));
      segGrad.addColorStop(1, this.rgbaToString(c1));
      this.ctx.strokeStyle = segGrad;
      this.ctx.lineWidth = (0.7 + 0.45 * Math.max(a0, a1)) * this.scale;
      this.ctx.beginPath();
      this.ctx.moveTo(p0.x, p0.y);
      this.ctx.lineTo(p1.x, p1.y);
      this.ctx.stroke();

      if (this.glow && this.trailGlowRadius > 0 && this.trailGlowIntensity > 0) {
        this.addTrailGlowSegment(
          p0.x,
          p0.y,
          p1.x,
          p1.y,
          glowBase,
          glowBase,
          this.alpha(a0) * 0.65,
          this.alpha(a1) * 0.65
        );
      }
    }
  }

  smoothstep(edge0: number, edge1: number, x: number): number {
    if (edge0 === edge1) return x < edge0 ? 0 : 1;
    const t = this.clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  computeBorderSideSpans(
    framePos1: number,
    totalSweepDeg: number
  ): { cwDeg: number; ccwDeg: number } {
    const growSum = this.borderGrowCwRate + this.borderGrowCcwRate;
    const peakCwDeg = this.borderPeakAngle * (this.borderGrowCwRate / growSum);
    const peakCcwDeg = this.borderPeakAngle - peakCwDeg;

    if (framePos1 <= this.borderPeakFrame) {
      return {
        cwDeg: totalSweepDeg * (this.borderGrowCwRate / growSum),
        ccwDeg: totalSweepDeg * (this.borderGrowCcwRate / growSum),
      };
    }

    const shrinkSum = this.borderShrinkCwRate + this.borderShrinkCcwRate;
    const totalLostDeg = Math.max(0, this.borderPeakAngle - totalSweepDeg);

    let cwLost = Math.min(peakCwDeg, totalLostDeg * (this.borderShrinkCwRate / shrinkSum));
    let ccwLost = Math.min(peakCcwDeg, totalLostDeg * (this.borderShrinkCcwRate / shrinkSum));
    let remainLost = totalLostDeg - cwLost - ccwLost;

    if (remainLost > 1e-6 && cwLost < peakCwDeg) {
      const extra = Math.min(remainLost, peakCwDeg - cwLost);
      cwLost += extra;
      remainLost -= extra;
    }
    if (remainLost > 1e-6 && ccwLost < peakCcwDeg) {
      const extra = Math.min(remainLost, peakCcwDeg - ccwLost);
      ccwLost += extra;
    }

    return {
      cwDeg: Math.max(0, peakCwDeg - cwLost),
      ccwDeg: Math.max(0, peakCcwDeg - ccwLost),
    };
  }

  getBorderSegmentColor(framePos1: number, u: number): RGBA {
    const bell = Math.sin(Math.PI * u);
    const baseColor = this.mixColor(
      this.borderTipColor,
      this.borderCoreColor,
      Math.pow(bell, 0.75)
    );
    if (framePos1 <= 13) return baseColor;

    const progress = this.smoothstep01((framePos1 - 13) / (this.FRAME_COUNT - 13));
    if (progress >= 0.985) return [...this.borderFinalColor] as RGBA;

    const edgeToCenter = Math.min(u, 1 - u) / 0.5;
    const band = 0.08;
    let edgeFrontBlend: number;
    if (edgeToCenter <= progress - band) {
      edgeFrontBlend = 1;
    } else if (edgeToCenter >= progress + band) {
      edgeFrontBlend = 0;
    } else {
      edgeFrontBlend = 1 - this.smoothstep(progress - band, progress + band, edgeToCenter);
    }

    return this.mixColor(baseColor, this.borderFinalColor, edgeFrontBlend);
  }

  drawMeteorArc(
    cx: number,
    cy: number,
    radius: number,
    anchorAngle: number,
    cwDeg: number,
    ccwDeg: number,
    maxWidth: number,
    shrinkDeg: number,
    framePos1: number
  ): [number, number] {
    if (radius <= 0 || maxWidth <= 0) return [0, 0];
    if (cwDeg <= 0 && ccwDeg <= 0) return [0, 0];

    const start = anchorAngle - this.deg2rad(ccwDeg);
    const end = anchorAngle + this.deg2rad(cwDeg);
    const total = Math.max(1e-4, end - start);
    const shrink = this.deg2rad(Math.max(0.001, shrinkDeg));
    const segCount = Math.max(28, Math.ceil((radius * total) / 6));

    this.ctx.lineCap = "round";
    this.ctx.lineJoin = "round";

    for (let i = 0; i < segCount; i++) {
      const u0 = i / segCount;
      const u1 = (i + 1) / segCount;
      const um = (u0 + u1) * 0.5;
      const a0 = start + total * u0;
      const a1 = start + total * u1;
      const am = start + total * um;
      const distFromStart = am - start;
      const distFromEnd = end - am;
      const edgeDist = Math.min(distFromStart, distFromEnd);
      const edgeFade = this.clamp(edgeDist / shrink, 0, 1);
      const bell = Math.sin(Math.PI * um);
      const width = maxWidth * edgeFade * (0.78 + 0.22 * bell);
      if (width <= 0.01) continue;

      const col = this.getBorderSegmentColor(framePos1, um);
      const alphaBoost =
        framePos1 <= 13
          ? 0.95
          : this.linearInterpolate(
              0.95,
              1.0,
              this.smoothstep01((framePos1 - 13) / (this.FRAME_COUNT - 13))
            );
      col[3] = this.alpha(alphaBoost);

      this.ctx.strokeStyle = this.rgbaToString(col);
      this.ctx.lineWidth = width * this.scale;
      this.ctx.beginPath();
      this.ctx.arc(cx, cy, radius, a0, a1);
      this.ctx.stroke();

      if (this.glow && this.borderGlowRadius > 0 && this.borderGlowIntensity > 0) {
        const px = cx + Math.cos(am) * radius;
        const py = cy + Math.sin(am) * radius;
        const t = i / (segCount - 1);
        const v = Math.sin(t * Math.PI) * Math.pow(total / Math.PI / 2, 0.25);
        this.glow.addPoint(
          px,
          py,
          this.borderGlowRadius * this.scale * (0.88 + 0.12 * bell) * v,
          col,
          this.borderGlowIntensity * (0.58 + 0.42 * bell) * v,
          this.borderGlowSoftness
        );
      }
    }

    return [start, end];
  }

  drawTriangle(
    x: number,
    y: number,
    size: number,
    color: RGBA,
    alphaMul: number,
    flipY: 1 | -1 = 1
  ): void {
    if (size <= 0.01) return;
    const c: RGBA = [color[0], color[1], color[2], color[3] * this.alpha(alphaMul)];
    if (c[3] <= 0.001) return;
    const r = size * this.scale;
    this.ctx.save();
    this.ctx.translate(x, y);
    this.ctx.scale(1, flipY);
    this.ctx.beginPath();
    this.ctx.moveTo(0, -r);
    this.ctx.lineTo(0.8660254 * r, 0.5 * r);
    this.ctx.lineTo(-0.8660254 * r, 0.5 * r);
    this.ctx.closePath();
    this.ctx.fillStyle = this.rgbaToString(c);
    this.ctx.fill();
    this.ctx.restore();
  }

  computeTriangleAlpha(
    framePos1: number,
    tri: {
      pulsePhase: number;
      pulsePeriodFrames: number;
    },
    pulseMode: string,
    opacityMin: number
  ): number {
    if (framePos1 >= 35) return 1;
    if (pulseMode === "Dynamic_Opacity" || pulseMode === "Transition") {
      const omega = (Math.PI * 2) / tri.pulsePeriodFrames;
      const pulse = 0.5 + 0.5 * Math.cos((framePos1 - 12) * omega + tri.pulsePhase);
      let alpha = this.linearInterpolate(opacityMin, 1, pulse);
      if (pulseMode === "Transition") {
        const u = this.smoothstep01((framePos1 - 31) / (34 - 31));
        alpha = this.linearInterpolate(alpha, 1, u);
      }
      return this.clamp(alpha, opacityMin, 1);
    }
    return 1;
  }

  renderEffect(effect: ClickEffect, now: number): boolean {
    const elapsed = ((now - effect.bornAt) / 1000) * this.speed;
    if (elapsed < 0) return false;
    if (elapsed > this.DURATION_SEC) return true;

    const t = this.clamp(elapsed / this.DURATION_SEC, 0, 1);
    const framePos1 = 1 + t * (this.FRAME_COUNT - 1);
    const centerColor = this.sampleColor(this.tracks.centerColor, framePos1);
    const centerDiameter =
      this.sampleNumeric(this.tracks.centerDiameter, framePos1) * effect.strength * this.scale;
    const pointColor = this.sampleColor(this.tracks.pointColor, framePos1);
    const pointDiameter =
      this.sampleNumeric(this.tracks.pointDiameter, framePos1) * effect.strength * this.scale;
    const borderAngle = this.sampleNumeric(this.tracks.borderAngle, framePos1);
    const borderWidth = this.sampleNumeric(this.tracks.borderMaxWidth, framePos1);
    const borderShrink = this.sampleNumeric(this.tracks.borderShrinkAngle, framePos1);
    const borderGapMax =
      this.sampleNumeric(this.tracks.maxBorderDistance, framePos1) * effect.strength * this.scale;
    const borderGap = borderGapMax * effect.border.gapRatio;
    const borderBaseRadius =
      this.sampleNumeric(this.tracks.scaleBaseRadius, framePos1) * effect.strength * this.scale;
    const { cwDeg, ccwDeg } = this.computeBorderSideSpans(framePos1, borderAngle);

    if ((cwDeg > 0.01 || ccwDeg > 0.01) && borderBaseRadius > 0.01) {
      const r0 = Math.max(0, borderBaseRadius - borderGap * 0.5);
      const r1 = borderBaseRadius + borderGap * 0.5;
      this.drawMeteorArc(
        effect.x,
        effect.y,
        r0,
        effect.border.innerAnchorAngle,
        cwDeg,
        ccwDeg,
        borderWidth,
        borderShrink,
        framePos1
      );
      this.drawMeteorArc(
        effect.x,
        effect.y,
        r1,
        effect.border.outerAnchorAngle,
        cwDeg,
        ccwDeg,
        borderWidth,
        borderShrink,
        framePos1
      );
    }

    const triaColor = this.sampleColor(this.tracks.triaColorRef, framePos1);
    const triaMode = this.sampleStep(this.tracks.triaPulseMode, framePos1);
    const triaScaleRate = this.sampleNumeric(this.tracks.triaScaleRate, framePos1);
    const triaDistance =
      this.sampleNumeric(this.tracks.triaDistance, framePos1) * effect.strength * this.scale;
    const triaOpacityMin = this.sampleNumeric(this.tracks.triaOpacityMin, framePos1);

    if (centerDiameter > 0.01) {
      this.drawGlowDisc(
        effect.x,
        effect.y,
        this.centerGlowRadius * effect.strength * this.scale,
        centerColor,
        1,
        this.centerGlowIntensity
      );
    }
    this.drawSolidDisc(effect.x, effect.y, centerDiameter, centerColor, 1);
    this.drawSolidDisc(effect.x, effect.y, pointDiameter, pointColor, 1);

    for (let i = 0; i < effect.tris.length; i++) {
      const tri = effect.tris[i];
      const px = effect.x + Math.cos(tri.angle) * triaDistance;
      const py = effect.y + Math.sin(tri.angle) * triaDistance;
      const size = tri.peakSize * triaScaleRate;
      const alpha = this.computeTriangleAlpha(framePos1, tri, triaMode, triaOpacityMin);
      this.drawTriangle(px, py, size, triaColor, alpha, tri.flipY);
    }

    return false;
  }

  loop(now: number): void {
    this.ctx.clearRect(0, 0, this.viewW, this.viewH);
    this.ctx.globalCompositeOperation = "source-over";
    this.glow?.beginFrame();

    this.drawTrail();

    for (let i = this.trailSideParticles.length - 1; i >= 0; i--) {
      const dead = this.renderTrailSideParticle(this.trailSideParticles[i], now);
      if (dead) this.trailSideParticles.splice(i, 1);
    }

    for (let i = this.effects.length - 1; i >= 0; i--) {
      const dead = this.renderEffect(this.effects[i], now);
      if (dead) this.effects.splice(i, 1);
    }

    this.glow?.flush();
    this.ctx.globalCompositeOperation = "source-over";
    this.animationId = window.requestAnimationFrame(this.loop);
  }

  installWindowBindings(): () => void {
    let lastBoomX = -1;
    let lastBoomY = -1;
    let lastBoomTime = 0;
    let lastMoveX = -1;
    let lastMoveY = -1;

    window.currentInputMode = "mouse";
    window.enableAlwaysTrailEffect = false;
    window.effectiveAlwaysTrail = false;

    window.setInputContext = (mode, alwaysTrailEnabled) => {
      window.currentInputMode = mode === "touch" ? "touch" : "mouse";
      window.enableAlwaysTrailEffect = Boolean(alwaysTrailEnabled);
      window.effectiveAlwaysTrail =
        window.currentInputMode === "mouse" && window.enableAlwaysTrailEffect;
    };

    window.externalBoom = (percentX, percentY) => {
      const now = Date.now();
      if (percentX === lastBoomX && percentY === lastBoomY && now - lastBoomTime < 25) return;
      lastBoomX = percentX;
      lastBoomY = percentY;
      lastBoomTime = now;
      const cx = percentX * window.innerWidth;
      const cy = percentY * window.innerHeight;
      window.dispatchEvent(
        new MouseEvent("mousedown", { clientX: cx, clientY: cy, bubbles: true })
      );
    };

    window.externalMove = (percentX, percentY) => {
      if (percentX === lastMoveX && percentY === lastMoveY) return;
      lastMoveX = percentX;
      lastMoveY = percentY;
      const cx = percentX * window.innerWidth;
      const cy = percentY * window.innerHeight;
      window.dispatchEvent(
        new MouseEvent("mousemove", { clientX: cx, clientY: cy, bubbles: true })
      );
    };

    window.externalUp = () => {
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    };

    window.updateColor = (value) => {
      this.color = value;
    };

    window.updateEffectSettings = (scale, opacity, speed) => {
      this.scale = Math.max(0.5, Math.min(3, Number(scale) || 1.5));
      this.opacity = Math.max(0.1, Math.min(1, Number(opacity) || 1));
      this.speed = Math.max(0.2, Math.min(3, Number(speed) || 1));
    };

    window.updateBorderBehavior = (
      growCW,
      growCCW,
      shrinkCW,
      shrinkCCW,
      gapRatioMin,
      gapRatioMax
    ) => {
      if (Number.isFinite(growCW) && growCW > 0) this.borderGrowCwRate = growCW;
      if (Number.isFinite(growCCW) && growCCW > 0) this.borderGrowCcwRate = growCCW;
      if (Number.isFinite(shrinkCW) && shrinkCW > 0) this.borderShrinkCwRate = shrinkCW;
      if (Number.isFinite(shrinkCCW) && shrinkCCW > 0) this.borderShrinkCcwRate = shrinkCCW;
      if (Number.isFinite(gapRatioMin))
        this.borderGapRatioMin = Math.max(0, Math.min(1, gapRatioMin));
      if (Number.isFinite(gapRatioMax))
        this.borderGapRatioMax = Math.max(0, Math.min(1, gapRatioMax));
      if (this.borderGapRatioMin > this.borderGapRatioMax) {
        const t = this.borderGapRatioMin;
        this.borderGapRatioMin = this.borderGapRatioMax;
        this.borderGapRatioMax = t;
      }
    };

    window.updateGlowSoftness = (centerSoftness, borderSoftness) => {
      if (Number.isFinite(centerSoftness) && centerSoftness >= 0.2)
        this.centerGlowSoftness = centerSoftness;
      if (Number.isFinite(borderSoftness) && borderSoftness >= 0.2)
        this.borderGlowSoftness = borderSoftness;
    };

    window.updateGlowSettings = (
      centerGlowRadius,
      borderGlowRadius,
      centerGlowIntensity,
      borderGlowIntensity
    ) => {
      if (Number.isFinite(centerGlowRadius) && centerGlowRadius >= 0)
        this.centerGlowRadius = centerGlowRadius;
      if (Number.isFinite(borderGlowRadius) && borderGlowRadius >= 0)
        this.borderGlowRadius = borderGlowRadius;
      if (Number.isFinite(centerGlowIntensity) && centerGlowIntensity >= 0)
        this.centerGlowIntensity = centerGlowIntensity;
      if (Number.isFinite(borderGlowIntensity) && borderGlowIntensity >= 0)
        this.borderGlowIntensity = borderGlowIntensity;
    };

    window.updateTrailGlow = (radius, intensity, softness, spacing) => {
      if (Number.isFinite(radius) && radius >= 0) this.trailGlowRadius = radius;
      if (Number.isFinite(intensity) && intensity >= 0) this.trailGlowIntensity = intensity;
      if (Number.isFinite(softness) && softness >= 0.2) this.trailGlowSoftness = softness;
      if (Number.isFinite(spacing) && spacing >= 1) this.trailGlowSpacing = spacing;
    };

    window.updateTrailTriangleBehavior = (
      minSpawnDistance,
      spawnProbability,
      minCenterOffset,
      maxCenterOffset,
      maxRadialDistance,
      normalConeDeg
    ) => {
      if (Number.isFinite(minSpawnDistance) && minSpawnDistance >= 0)
        this.trailTriMinSpawnDistance = minSpawnDistance;
      if (Number.isFinite(spawnProbability))
        this.trailTriSpawnProbability = this.clamp(spawnProbability, 0, 1);
      if (Number.isFinite(minCenterOffset) && minCenterOffset >= 0)
        this.trailTriMinCenterOffset = minCenterOffset;
      if (Number.isFinite(maxCenterOffset) && maxCenterOffset >= 0)
        this.trailTriMaxCenterOffset = maxCenterOffset;
      if (Number.isFinite(maxRadialDistance) && maxRadialDistance >= 0)
        this.trailTriMaxRadialDistance = maxRadialDistance;
      if (Number.isFinite(normalConeDeg) && normalConeDeg > 0)
        this.trailTriNormalConeDeg = normalConeDeg;
    };

    window.setInputContext("mouse", false);

    return () => {
      delete window.setInputContext;
      delete window.externalBoom;
      delete window.externalMove;
      delete window.externalUp;
      delete window.updateColor;
      delete window.updateEffectSettings;
      delete window.updateBorderBehavior;
      delete window.updateGlowSoftness;
      delete window.updateGlowSettings;
      delete window.updateTrailGlow;
      delete window.updateTrailTriangleBehavior;
    };
  }

  destroy(): void {
    window.cancelAnimationFrame(this.animationId);
    for (const fn of this.cleanupFns) fn();
    this.cleanupFns = [];
  }
}

export default function BAComet({ className, enableGlow = false }: BACometProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const glowCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<MouseSparkEngine | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const engine = new MouseSparkEngine(canvas, glowCanvasRef.current, {
      enableGlow,
    });
    engineRef.current = engine;

    const uninstall = engine.installWindowBindings();

    return () => {
      uninstall();
      engine.destroy();
      engineRef.current = null;
    };
  }, [enableGlow]);

  return (
    <div
      className={`fixed inset-0 overflow-hidden pointer-events-none z-999999 ${className ?? ""}`}
    >
      <canvas
        ref={glowCanvasRef}
        className={`absolute inset-0 h-full w-full ${enableGlow ? "block" : "hidden"}`}
      />
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  );
}
