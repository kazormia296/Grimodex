import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type CSSProperties,
} from "react";
import type {
  PaperShaderElement,
  ShaderMount,
  ShaderMountUniforms,
} from "@paper-design/shaders";
import {
  ZEN_MULTIPASS_DOWNSAMPLE_FRAGMENT,
  ZEN_MULTIPASS_FULLSCREEN_VERTEX,
  ZEN_MULTIPASS_GAUSSIAN_FRAGMENT,
  buildZenGaussianKernel,
  resolveZenMultipassBlurPlan,
} from "./zenBlurResearchPipeline";
import {
  ZEN_DUAL_KAWASE_DOWNSAMPLE_FRAGMENT,
  ZEN_DUAL_KAWASE_UPSAMPLE_FRAGMENT,
  resolveZenDualKawasePlan,
  type ZenDualKawasePlan,
} from "./zenDualKawase";
import {
  DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS,
  type ZenBlurResearchOptions,
} from "./zenBlurResearchConfig";
import {
  collectZenWebGlMetadata,
  type ZenWebGlMetadata,
} from "./zenWebGlDiagnostics";
import { createZenShaderFrameCadence } from "./zenShaderAnimation";
import {
  createZenGpuTimerBackend,
  ZenGpuTimerSampler,
  type ZenGpuBenchmarkReport,
  type ZenGpuTimingMode,
  type ZenGpuTimerBackend,
  type ZenGpuTimerSnapshot,
  type ZenGpuTimingStatus,
  type ZenGpuPassTimesMs,
} from "./zenGpuTimerSampler";

const ZEN_INTERMEDIATE_TEXTURE_UNIT_COUNT = 2;
const EMPTY_ZEN_MIPMAPS: readonly string[] = [];
const IDLE_ZEN_GPU_TIMING: Readonly<ZenGpuTimerSnapshot> = {
  gpuTimeMs: null,
  gpuPassTimesMs: null,
  gpuTimingStatus: "idle",
  gpuTimingSampleCount: 0,
  gpuTimingSampleDrawCount: null,
};
const EMPTY_ZEN_GPU_BENCHMARK: Readonly<ZenGpuBenchmarkReport> = {
  samples: [],
  summary: null,
};
const EMPTY_ZEN_WEB_GL_METADATA: Readonly<ZenWebGlMetadata> = {
  vendor: null,
  renderer: null,
  unmaskedVendor: null,
  unmaskedRenderer: null,
  version: null,
  shadingLanguageVersion: null,
  maxTextureSize: null,
  maxTextureImageUnits: null,
  userAgent: null,
  platform: null,
};

const PAPER_VERTEX_SHADER = `#version 300 es
precision mediump float;
layout(location = 0) in vec4 a_position;
uniform vec2 u_paperResolution;
uniform float u_paperPixelRatio;
uniform float u_imageAspectRatio;
uniform float u_originX;
uniform float u_originY;
uniform float u_worldWidth;
uniform float u_worldHeight;
uniform float u_fit;
uniform float u_scale;
uniform float u_rotation;
uniform float u_offsetX;
uniform float u_offsetY;
out vec2 v_objectUV;
out vec2 v_objectBoxSize;
out vec2 v_responsiveUV;
out vec2 v_responsiveBoxGivenSize;
out vec2 v_patternUV;
out vec2 v_patternBoxSize;
out vec2 v_imageUV;
vec3 getBoxSize(float boxRatio, vec2 givenBoxSize) {
  vec2 box = vec2(0.0);
  box.x = boxRatio * min(givenBoxSize.x / boxRatio, givenBoxSize.y);
  float noFitBoxWidth = box.x;
  if (u_fit == 1.0) {
    box.x = boxRatio * min(u_paperResolution.x / boxRatio, u_paperResolution.y);
  } else if (u_fit == 2.0) {
    box.x = boxRatio * max(u_paperResolution.x / boxRatio, u_paperResolution.y);
  }
  box.y = box.x / boxRatio;
  return vec3(box, noFitBoxWidth);
}
void main() {
  gl_Position = a_position;
  vec2 uv = gl_Position.xy * 0.5;
  vec2 boxOrigin = vec2(0.5 - u_originX, u_originY - 0.5);
  vec2 givenBoxSize = vec2(u_worldWidth, u_worldHeight);
  givenBoxSize = max(givenBoxSize, vec2(1.0)) * u_paperPixelRatio;
  float rotation = u_rotation * 3.14159265358979323846 / 180.0;
  mat2 graphicRotation = mat2(
    cos(rotation),
    sin(rotation),
    -sin(rotation),
    cos(rotation)
  );
  vec2 graphicOffset = vec2(-u_offsetX, u_offsetY);

  float fixedRatio = 1.0;
  vec2 fixedRatioBoxGivenSize = vec2(
    u_worldWidth == 0.0 ? u_paperResolution.x : givenBoxSize.x,
    u_worldHeight == 0.0 ? u_paperResolution.y : givenBoxSize.y
  );
  v_objectBoxSize = getBoxSize(fixedRatio, fixedRatioBoxGivenSize).xy;
  vec2 objectWorldScale = u_paperResolution.xy / v_objectBoxSize;
  v_objectUV = uv;
  v_objectUV *= objectWorldScale;
  v_objectUV += boxOrigin * (objectWorldScale - 1.0);
  v_objectUV += graphicOffset;
  v_objectUV /= u_scale;
  v_objectUV = graphicRotation * v_objectUV;

  v_responsiveBoxGivenSize = vec2(
    u_worldWidth == 0.0 ? u_paperResolution.x : givenBoxSize.x,
    u_worldHeight == 0.0 ? u_paperResolution.y : givenBoxSize.y
  );
  float responsiveRatio =
    v_responsiveBoxGivenSize.x / v_responsiveBoxGivenSize.y;
  vec2 responsiveBoxSize =
    getBoxSize(responsiveRatio, v_responsiveBoxGivenSize).xy;
  vec2 responsiveBoxScale = u_paperResolution.xy / responsiveBoxSize;
  v_responsiveUV = uv;
  v_responsiveUV *= responsiveBoxScale;
  v_responsiveUV += boxOrigin * (responsiveBoxScale - 1.0);
  v_responsiveUV += graphicOffset;
  v_responsiveUV /= u_scale;
  v_responsiveUV.x *= responsiveRatio;
  v_responsiveUV = graphicRotation * v_responsiveUV;
  v_responsiveUV.x /= responsiveRatio;

  vec2 patternBoxGivenSize = vec2(
    u_worldWidth == 0.0 ? u_paperResolution.x : givenBoxSize.x,
    u_worldHeight == 0.0 ? u_paperResolution.y : givenBoxSize.y
  );
  float patternBoxRatio = patternBoxGivenSize.x / patternBoxGivenSize.y;
  vec3 boxSizeData = getBoxSize(patternBoxRatio, patternBoxGivenSize);
  v_patternBoxSize = boxSizeData.xy;
  float patternBoxNoFitBoxWidth = boxSizeData.z;
  vec2 patternBoxScale = u_paperResolution.xy / v_patternBoxSize;
  v_patternUV = uv;
  v_patternUV += graphicOffset / patternBoxScale;
  v_patternUV += boxOrigin;
  v_patternUV -= boxOrigin / patternBoxScale;
  v_patternUV *= u_paperResolution.xy;
  v_patternUV /= u_paperPixelRatio;
  if (u_fit > 0.0) {
    v_patternUV *= patternBoxNoFitBoxWidth / v_patternBoxSize.x;
  }
  v_patternUV /= u_scale;
  v_patternUV = graphicRotation * v_patternUV;
  v_patternUV += boxOrigin / patternBoxScale;
  v_patternUV -= boxOrigin;
  v_patternUV *= 0.01;

  vec2 imageBoxSize;
  if (u_fit == 1.0) {
    imageBoxSize.x =
      min(u_paperResolution.x / u_imageAspectRatio, u_paperResolution.y) *
      u_imageAspectRatio;
  } else if (u_fit == 2.0) {
    imageBoxSize.x =
      max(u_paperResolution.x / u_imageAspectRatio, u_paperResolution.y) *
      u_imageAspectRatio;
  } else {
    imageBoxSize.x = min(10.0, 10.0 / u_imageAspectRatio * u_imageAspectRatio);
  }
  imageBoxSize.y = imageBoxSize.x / u_imageAspectRatio;
  vec2 imageBoxScale = u_paperResolution.xy / imageBoxSize;
  v_imageUV = uv;
  v_imageUV *= imageBoxScale;
  v_imageUV += boxOrigin * (imageBoxScale - 1.0);
  v_imageUV += graphicOffset;
  v_imageUV /= u_scale;
  v_imageUV.x *= u_imageAspectRatio;
  v_imageUV = graphicRotation * v_imageUV;
  v_imageUV.x /= u_imageAspectRatio;
  v_imageUV += 0.5;
  v_imageUV.y = 1.0 - v_imageUV.y;
}`;

interface RenderTarget {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
  format: RenderTargetFormat;
}

interface RenderTargetFormat {
  internalFormat: number;
  format: number;
  type: number;
  minFilter: number;
  magFilter: number;
  precision: "rgba16f" | "rgba8";
}

interface ProgramBundle {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
}

export interface ZenBlurResearchCanvasProps {
  sceneFragment: string;
  sceneUniforms: ShaderMountUniforms;
  compositeFragment: string;
  compositeUniforms: ShaderMountUniforms;
  mipmaps?: readonly string[];
  minPixelRatio: number;
  maxPixelCount: number;
  webGlContextAttributes?: WebGLContextAttributes;
  blurTargetPrecision?: "auto" | "rgba8";
  researchOptions?: ZenBlurResearchOptions;
  speed?: number;
  className?: string;
  style?: CSSProperties;
  "data-paper-shader": string;
  "data-zen-glass-compositor"?: string;
}

interface ZenMultipassFaultInjection {
  initialBlurTargetPrecision?: "rgba16f" | "rgba8";
  failInitializationAfterSetup?: boolean;
  onInitializationRollback?: () => void;
  animationFrameDriver?: {
    request: (callback: FrameRequestCallback) => number;
    cancel: (handle: number) => void;
  };
  shouldFailSceneTargetAllocation?: (attempt: {
    width: number;
    height: number;
  }) => boolean;
  shouldFailBlurTargetAllocation?: (attempt: {
    precision: "rgba16f" | "rgba8";
    width: number;
    height: number;
  }) => boolean;
  onStaticUniformsApplied?: (pass: "scene" | "composite") => void;
  createGpuTimerBackend?: (
    gl: WebGL2RenderingContext,
  ) => ZenGpuTimerBackend | null;
}

type ZenMultipassTestGlobal = typeof globalThis & {
  __grimodexZenMultipassFaultInjection?: ZenMultipassFaultInjection | null;
};

export interface ZenMultipassPerformanceStats {
  drawCount: number;
  drawCallCount: number;
  backend: ZenBlurResearchOptions["backend"];
  gpuTimeMs: number | null;
  gpuPassTimesMs: ZenGpuPassTimesMs | null;
  gpuTimingStatus: ZenGpuTimingStatus;
  gpuTimingSampleCount: number;
  gpuTimingSampleDrawCount: number | null;
  isStaticFrameReady: boolean;
  blurFormat: "rgba16f" | "rgba8";
  blurTargetAFormat: "rgba16f" | "rgba8";
  blurTargetBFormat: "rgba16f" | "rgba8";
  sceneTargetWidth: number;
  sceneTargetHeight: number;
  blurTargetWidth: number;
  blurTargetHeight: number;
  gaussianPairCount: number;
  kawaseDownsamplePassCount: number;
  kawaseUpsamplePassCount: number;
  blurTargetLevels: ZenBlurTargetLevelStats[];
  intermediateTextureBytes: number;
  blurTargetReallocationCount: number;
  cpuSubmitTimeMs: number | null;
  cpuSubmitSampleCount: number;
  cpuSubmitSummary: ZenTimingPercentiles | null;
  displayNoise: ZenBlurResearchOptions["displayNoise"];
  rgba8Dither: ZenBlurResearchOptions["rgba8Dither"];
}

export interface ZenBlurTargetLevelStats {
  level: number;
  width: number;
  height: number;
  format: "rgba16f" | "rgba8";
  bytes: number;
}

export interface ZenTimingPercentiles {
  p50: number;
  p95: number;
  p99: number;
}

export interface ZenCpuSubmitSample {
  drawCount: number;
  drawCallCount: number;
  cpuSubmitTimeMs: number;
}

export interface ZenMultipassPerformanceReport {
  schemaVersion: 1;
  capturedAtEpochMs: number;
  backend: ZenBlurResearchOptions["backend"];
  gpuTimingMode: ZenGpuTimingMode;
  researchOptions: ZenBlurResearchOptions;
  gpuMetadata: ZenWebGlMetadata;
  performanceStats: ZenMultipassPerformanceStats;
  gpuBenchmark: ReturnType<ZenGpuTimerSampler["getBenchmarkReport"]>;
  cpuSubmit: {
    samples: ZenCpuSubmitSample[];
    summary: ZenTimingPercentiles | null;
  };
}

export function _setZenMultipassFaultInjectionForTests(
  injection: ZenMultipassFaultInjection | null,
) {
  if (import.meta.env.MODE !== "test") {
    throw new Error(
      "Zen multipass fault injection is available only in test mode",
    );
  }
  (globalThis as ZenMultipassTestGlobal).__grimodexZenMultipassFaultInjection =
    injection;
}

function getZenMultipassFaultInjectionForTests() {
  if (import.meta.env.MODE !== "test") return null;
  return (
    (globalThis as ZenMultipassTestGlobal)
      .__grimodexZenMultipassFaultInjection ?? null
  );
}

function createRgba8TargetFormat(
  gl: WebGL2RenderingContext,
): RenderTargetFormat {
  return {
    internalFormat: gl.RGBA8,
    format: gl.RGBA,
    type: gl.UNSIGNED_BYTE,
    minFilter: gl.LINEAR,
    magFilter: gl.LINEAR,
    precision: "rgba8",
  };
}

function createRgba16fTargetFormat(
  gl: WebGL2RenderingContext,
): RenderTargetFormat {
  return {
    internalFormat: gl.RGBA16F,
    format: gl.RGBA,
    type: gl.HALF_FLOAT,
    minFilter: gl.LINEAR,
    magFilter: gl.LINEAR,
    precision: "rgba16f",
  };
}

function enableFloatColorBufferExtensions(gl: WebGL2RenderingContext) {
  gl.getExtension("EXT_color_buffer_float");
  gl.getExtension("EXT_color_buffer_half_float");
}

function resolveBlurTargetFormat(
  gl: WebGL2RenderingContext,
  precision: "auto" | "rgba8",
): RenderTargetFormat {
  const fallback = createRgba8TargetFormat(gl);
  if (precision === "rgba8") return fallback;

  // Extension availability alone is not enough: verify that this exact
  // allocation can be attached to a complete framebuffer on the active GPU.
  enableFloatColorBufferExtensions(gl);
  let texture: WebGLTexture | null = null;
  let framebuffer: WebGLFramebuffer | null = null;
  let complete: boolean;
  try {
    texture = gl.createTexture();
    framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) return fallback;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA16F,
      1,
      1,
      0,
      gl.RGBA,
      gl.HALF_FLOAT,
      null,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    complete =
      gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE &&
      gl.getError() === gl.NO_ERROR;
  } catch {
    complete = false;
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    if (framebuffer) gl.deleteFramebuffer(framebuffer);
    if (texture) gl.deleteTexture(texture);
  }

  return complete ? createRgba16fTargetFormat(gl) : fallback;
}

function renderTargetBytes(target: RenderTarget) {
  const bytesPerPixel = target.format.precision === "rgba16f" ? 8 : 4;
  return target.width * target.height * bytesPerPixel;
}

function nearestRankPercentile(values: readonly number[], percentile: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)] ?? 0;
}

function timingPercentiles(
  values: readonly number[],
): ZenTimingPercentiles | null {
  if (values.length === 0) return null;
  return {
    p50: nearestRankPercentile(values, 0.5),
    p95: nearestRankPercentile(values, 0.95),
    p99: nearestRankPercentile(values, 0.99),
  };
}

function numericUniformArray(value: unknown): number[] {
  if (value instanceof Float32Array) return Array.from(value);
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    Array.isArray(entry)
      ? entry.filter((item): item is number => typeof item === "number")
      : typeof entry === "number"
        ? [entry]
        : [],
  );
}

function rectHasArea(values: readonly number[], offset = 0) {
  const left = values[offset];
  const bottom = values[offset + 1];
  const right = values[offset + 2];
  const top = values[offset + 3];
  return (
    Number.isFinite(left) &&
    Number.isFinite(bottom) &&
    Number.isFinite(right) &&
    Number.isFinite(top) &&
    (right ?? 0) > (left ?? 0) &&
    (top ?? 0) > (bottom ?? 0)
  );
}

function hasActiveGlassSurface(uniforms: ShaderMountUniforms) {
  if (Number(uniforms.u_zenGlassEnabled ?? 0) < 0.5) return false;
  if (rectHasArea(numericUniformArray(uniforms.u_zenGlassRect))) return true;

  const count = Math.max(
    0,
    Math.floor(Number(uniforms.u_zenUiSurfaceCount ?? 0)),
  );
  if (count === 0) return false;
  const rects = numericUniformArray(uniforms["u_zenUiSurfaceRects[0]"]);
  const params = numericUniformArray(uniforms["u_zenUiSurfaceParams[0]"]);
  if (rects.length < count * 4 || params.length < count * 4) return true;
  for (let index = 0; index < count; index += 1) {
    if (params[index * 4 + 1]! >= 0.5 && rectHasArea(rects, index * 4)) {
      return true;
    }
  }
  return false;
}

function isImage(value: unknown): value is HTMLImageElement {
  if (!value || typeof value !== "object") return false;
  const image = value as HTMLImageElement;
  const ImageConstructor = image.ownerDocument?.defaultView?.HTMLImageElement;
  return ImageConstructor
    ? image instanceof ImageConstructor
    : typeof image.complete === "boolean" &&
        typeof image.naturalWidth === "number" &&
        typeof image.naturalHeight === "number";
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to allocate WebGL shader");
  try {
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) ?? "Unknown shader compile error";
      throw new Error(log);
    }
    return shader;
  } catch (error) {
    gl.deleteShader(shader);
    throw error;
  }
}

function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  let fragment: WebGLShader | null = null;
  let program: WebGLProgram | null = null;
  try {
    fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    program = gl.createProgram();
    if (!program) throw new Error("Unable to allocate WebGL program");
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? "Unknown shader link error";
      throw new Error(log);
    }
    return program;
  } catch (error) {
    if (program) gl.deleteProgram(program);
    throw error;
  } finally {
    gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
  }
}

function createProgramBundle(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): ProgramBundle {
  const program = createProgram(gl, vertexSource, fragmentSource);
  let vao: WebGLVertexArrayObject | null = null;
  let buffer: WebGLBuffer | null = null;
  try {
    vao = gl.createVertexArray();
    buffer = gl.createBuffer();
    if (!vao || !buffer) throw new Error("Unable to allocate WebGL geometry");
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const position = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return { program, vao, buffer };
  } catch (error) {
    if (buffer) gl.deleteBuffer(buffer);
    if (vao) gl.deleteVertexArray(vao);
    gl.deleteProgram(program);
    throw error;
  }
}

function deleteProgramBundle(
  gl: WebGL2RenderingContext,
  bundle: ProgramBundle,
) {
  gl.deleteBuffer(bundle.buffer);
  gl.deleteVertexArray(bundle.vao);
  gl.deleteProgram(bundle.program);
}

function createRenderTarget(
  gl: WebGL2RenderingContext,
  format: RenderTargetFormat,
): RenderTarget {
  let framebuffer: WebGLFramebuffer | null = null;
  let texture: WebGLTexture | null = null;
  try {
    framebuffer = gl.createFramebuffer();
    texture = gl.createTexture();
    if (!framebuffer || !texture) {
      throw new Error("Unable to allocate Zen multipass render target");
    }
    return { framebuffer, texture, width: 0, height: 0, format };
  } catch (error) {
    if (framebuffer) gl.deleteFramebuffer(framebuffer);
    if (texture) gl.deleteTexture(texture);
    throw error;
  }
}

function deleteRenderTarget(gl: WebGL2RenderingContext, target: RenderTarget) {
  gl.deleteFramebuffer(target.framebuffer);
  gl.deleteTexture(target.texture);
}

interface RendererResources {
  sceneProgram: ProgramBundle;
  downsampleProgram: ProgramBundle;
  gaussianProgram: ProgramBundle;
  kawaseDownsampleProgram: ProgramBundle | null;
  kawaseUpsampleProgram: ProgramBundle | null;
  compositeProgram: ProgramBundle;
  sceneTarget: RenderTarget;
  blurTargetA: RenderTarget;
  blurTargetB: RenderTarget;
  kawaseTargets: RenderTarget[];
}

function deleteRendererResources(
  gl: WebGL2RenderingContext,
  resources: RendererResources,
) {
  for (const target of [
    resources.sceneTarget,
    resources.blurTargetA,
    resources.blurTargetB,
    ...resources.kawaseTargets,
  ]) {
    deleteRenderTarget(gl, target);
  }
  for (const bundle of [
    resources.sceneProgram,
    resources.downsampleProgram,
    resources.gaussianProgram,
    resources.kawaseDownsampleProgram,
    resources.kawaseUpsampleProgram,
    resources.compositeProgram,
  ]) {
    if (bundle) deleteProgramBundle(gl, bundle);
  }
}

function createRendererResources(
  gl: WebGL2RenderingContext,
  sceneFragment: string,
  compositeFragment: string,
  sceneTargetFormat: RenderTargetFormat,
  blurTargetFormat: RenderTargetFormat,
  researchOptions: ZenBlurResearchOptions,
): RendererResources {
  const bundles: ProgramBundle[] = [];
  const targets: RenderTarget[] = [];
  try {
    const sceneProgram = createProgramBundle(
      gl,
      PAPER_VERTEX_SHADER,
      sceneFragment,
    );
    bundles.push(sceneProgram);
    const downsampleProgram = createProgramBundle(
      gl,
      ZEN_MULTIPASS_FULLSCREEN_VERTEX,
      ZEN_MULTIPASS_DOWNSAMPLE_FRAGMENT,
    );
    bundles.push(downsampleProgram);
    const gaussianProgram = createProgramBundle(
      gl,
      ZEN_MULTIPASS_FULLSCREEN_VERTEX,
      ZEN_MULTIPASS_GAUSSIAN_FRAGMENT,
    );
    bundles.push(gaussianProgram);
    const usesDualKawase = researchOptions.backend !== "gaussian-current";
    const kawaseDownsampleProgram = usesDualKawase
      ? createProgramBundle(
          gl,
          ZEN_MULTIPASS_FULLSCREEN_VERTEX,
          ZEN_DUAL_KAWASE_DOWNSAMPLE_FRAGMENT,
        )
      : null;
    if (kawaseDownsampleProgram) bundles.push(kawaseDownsampleProgram);
    const kawaseUpsampleProgram = usesDualKawase
      ? createProgramBundle(
          gl,
          ZEN_MULTIPASS_FULLSCREEN_VERTEX,
          ZEN_DUAL_KAWASE_UPSAMPLE_FRAGMENT,
        )
      : null;
    if (kawaseUpsampleProgram) bundles.push(kawaseUpsampleProgram);
    const compositeProgram = createProgramBundle(
      gl,
      ZEN_MULTIPASS_FULLSCREEN_VERTEX,
      compositeFragment,
    );
    bundles.push(compositeProgram);

    const sceneTarget = createRenderTarget(gl, sceneTargetFormat);
    targets.push(sceneTarget);
    const blurTargetA = createRenderTarget(gl, blurTargetFormat);
    targets.push(blurTargetA);
    const blurTargetB = createRenderTarget(gl, blurTargetFormat);
    targets.push(blurTargetB);
    const kawaseTargets = usesDualKawase
      ? Array.from({ length: researchOptions.dualKawase.passes + 1 }, () => {
          const target = createRenderTarget(gl, blurTargetFormat);
          targets.push(target);
          return target;
        })
      : [];
    return {
      sceneProgram,
      downsampleProgram,
      gaussianProgram,
      kawaseDownsampleProgram,
      kawaseUpsampleProgram,
      compositeProgram,
      sceneTarget,
      blurTargetA,
      blurTargetB,
      kawaseTargets,
    };
  } catch (error) {
    for (const target of targets.reverse()) deleteRenderTarget(gl, target);
    for (const bundle of bundles.reverse()) deleteProgramBundle(gl, bundle);
    throw error;
  }
}

class ZenMultipassRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly sceneProgram: ProgramBundle;
  private readonly downsampleProgram: ProgramBundle;
  private readonly gaussianProgram: ProgramBundle;
  private readonly kawaseDownsampleProgram: ProgramBundle | null;
  private readonly kawaseUpsampleProgram: ProgramBundle | null;
  private readonly compositeProgram: ProgramBundle;
  private readonly sceneTarget: RenderTarget;
  private readonly blurTargetA: RenderTarget;
  private readonly blurTargetB: RenderTarget;
  private readonly kawaseTargets: RenderTarget[];
  private blurTargetFormat: RenderTargetFormat;
  private readonly uniformLocations = new WeakMap<
    WebGLProgram,
    Map<string, WebGLUniformLocation | null>
  >();
  private readonly imageTextures = new Map<
    WebGLProgram,
    Map<
      string,
      { image: HTMLImageElement; texture: WebGLTexture; unit: number }
    >
  >();
  private readonly resizeObserver: ResizeObserver | null;
  private sceneUniforms: ShaderMountUniforms;
  private compositeUniforms: ShaderMountUniforms;
  private mipmaps: readonly string[];
  private frame = 0;
  private renderScale = 1;
  private cssWidth = 0;
  private cssHeight = 0;
  private drawCount = 0;
  private drawCallCount = 0;
  private rafId: number | null = null;
  private needsDraw = false;
  private dirtyScene = true;
  private dirtyBlur = true;
  private dirtyComposite = true;
  private dirtySceneUniforms = true;
  private dirtyCompositeUniforms = true;
  private animationSpeed = 0;
  private lastAnimationTimestamp: number | null = null;
  private readonly animationCadence = createZenShaderFrameCadence();
  private blurredTexture: WebGLTexture;
  private blurPlanKey = "";
  private activeBlurPlan: ReturnType<typeof resolveZenMultipassBlurPlan> = null;
  private activeKawasePlan: ZenDualKawasePlan | null = null;
  private gaussianPairCount = 0;
  private blurTargetReallocationCount = 0;
  private cpuSubmitSamples: ZenCpuSubmitSample[] | null = null;
  private cpuSubmitTimeMs: number | null = null;
  private hasRenderedFrame = false;
  private activeGlassSurface = false;
  private readonly faultInjection = getZenMultipassFaultInjectionForTests();
  private readonly gpuTimerSampler: ZenGpuTimerSampler | null;
  private readonly gpuMetadata: ZenWebGlMetadata | null;
  private failed = false;
  private disposed = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    sceneFragment: string,
    sceneUniforms: ShaderMountUniforms,
    compositeFragment: string,
    compositeUniforms: ShaderMountUniforms,
    mipmaps: readonly string[],
    private readonly minPixelRatio: number,
    private readonly maxPixelCount: number,
    contextAttributes?: WebGLContextAttributes,
    private readonly onFatalError: (error: unknown) => void = () => undefined,
    blurTargetPrecision: "auto" | "rgba8" = "auto",
    private readonly researchOptions: ZenBlurResearchOptions = DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS,
  ) {
    this.researchOptions = {
      ...researchOptions,
      gpuTiming: {
        ...researchOptions.gpuTiming,
        measurementMode: researchOptions.gpuTiming.measurementMode ?? "off",
      },
    };
    const gl = canvas.getContext("webgl2", contextAttributes);
    if (!gl)
      throw new Error("WebGL2 is unavailable for Zen multipass rendering");
    this.gl = gl;
    const gpuTimingEnabled =
      this.researchOptions.gpuTiming.measurementMode !== "off";
    if (gpuTimingEnabled) {
      let gpuTimerBackend: ZenGpuTimerBackend | null = null;
      try {
        gpuTimerBackend = this.faultInjection?.createGpuTimerBackend
          ? this.faultInjection.createGpuTimerBackend(gl)
          : createZenGpuTimerBackend(gl);
      } catch {
        // GPU timing is diagnostic only and must never prevent rendering.
      }
      this.gpuTimerSampler = new ZenGpuTimerSampler(
        gpuTimerBackend,
        this.researchOptions.gpuTiming,
      );
      this.gpuMetadata = collectZenWebGlMetadata(
        gl,
        canvas.ownerDocument.defaultView?.navigator,
      );
      this.cpuSubmitSamples = [];
    } else {
      this.gpuTimerSampler = null;
      this.gpuMetadata = null;
    }
    const sceneTargetFormat = createRgba8TargetFormat(gl);
    const initialBlurTargetPrecision =
      this.faultInjection?.initialBlurTargetPrecision;
    if (initialBlurTargetPrecision === "rgba16f") {
      enableFloatColorBufferExtensions(gl);
    }
    this.blurTargetFormat =
      initialBlurTargetPrecision === "rgba16f"
        ? createRgba16fTargetFormat(gl)
        : initialBlurTargetPrecision === "rgba8"
          ? createRgba8TargetFormat(gl)
          : resolveBlurTargetFormat(gl, blurTargetPrecision);
    this.sceneUniforms = sceneUniforms;
    this.compositeUniforms = compositeUniforms;
    this.activeGlassSurface = hasActiveGlassSurface(compositeUniforms);
    this.mipmaps = mipmaps;
    const resources = createRendererResources(
      gl,
      sceneFragment,
      compositeFragment,
      sceneTargetFormat,
      this.blurTargetFormat,
      this.researchOptions,
    );
    this.sceneProgram = resources.sceneProgram;
    this.downsampleProgram = resources.downsampleProgram;
    this.gaussianProgram = resources.gaussianProgram;
    this.kawaseDownsampleProgram = resources.kawaseDownsampleProgram;
    this.kawaseUpsampleProgram = resources.kawaseUpsampleProgram;
    this.compositeProgram = resources.compositeProgram;
    this.sceneTarget = resources.sceneTarget;
    this.blurTargetA = resources.blurTargetA;
    this.blurTargetB = resources.blurTargetB;
    this.kawaseTargets = resources.kawaseTargets;
    this.blurredTexture = this.sceneTarget.texture;
    try {
      this.resizeObserver =
        typeof ResizeObserver === "undefined"
          ? null
          : new ResizeObserver(() => this.resize());
    } catch (error) {
      deleteRendererResources(gl, resources);
      this.faultInjection?.onInitializationRollback?.();
      throw error;
    }

    try {
      gl.disable(gl.BLEND);

      this.useBundle(this.downsampleProgram);
      gl.uniform1i(
        this.uniformLocation(this.downsampleProgram.program, "u_sourceTexture"),
        0,
      );
      this.useBundle(this.gaussianProgram);
      gl.uniform1i(
        this.uniformLocation(this.gaussianProgram.program, "u_sourceTexture"),
        0,
      );
      for (const program of [
        this.kawaseDownsampleProgram,
        this.kawaseUpsampleProgram,
      ]) {
        if (!program) continue;
        this.useBundle(program);
        gl.uniform1i(
          this.uniformLocation(program.program, "u_sourceTexture"),
          0,
        );
      }
      this.useBundle(this.compositeProgram);
      gl.uniform1i(
        this.uniformLocation(this.compositeProgram.program, "u_sceneTexture"),
        0,
      );
      gl.uniform1i(
        this.uniformLocation(this.compositeProgram.program, "u_blurredTexture"),
        1,
      );

      this.resizeObserver?.observe(host);
      host.ownerDocument.defaultView?.addEventListener("resize", this.resize);
      this.resizeTargets();
      if (this.faultInjection?.failInitializationAfterSetup) {
        throw new Error("Injected Zen multipass initialization failure");
      }
    } catch (error) {
      this.dispose();
      this.faultInjection?.onInitializationRollback?.();
      throw error;
    }
  }

  private readonly requestFrame = (callback: FrameRequestCallback) => {
    const injectedDriver = this.faultInjection?.animationFrameDriver;
    if (injectedDriver) return injectedDriver.request(callback);
    const view = this.host.ownerDocument.defaultView;
    return (
      view?.requestAnimationFrame(callback) ?? requestAnimationFrame(callback)
    );
  };

  private readonly cancelFrame = (handle: number) => {
    const injectedDriver = this.faultInjection?.animationFrameDriver;
    if (injectedDriver) {
      injectedDriver.cancel(handle);
      return;
    }
    const view = this.host.ownerDocument.defaultView;
    if (view) view.cancelAnimationFrame(handle);
    else cancelAnimationFrame(handle);
  };

  private uniformLocation(program: WebGLProgram, name: string) {
    let locations = this.uniformLocations.get(program);
    if (!locations) {
      locations = new Map();
      this.uniformLocations.set(program, locations);
    }
    if (locations.has(name)) return locations.get(name) ?? null;
    const location = this.gl.getUniformLocation(program, name);
    locations.set(name, location);
    return location;
  }

  private clearGlErrors() {
    for (let index = 0; index < 16; index += 1) {
      if (this.gl.getError() === this.gl.NO_ERROR) return;
    }
  }

  private allocateTarget(target: RenderTarget, width: number, height: number) {
    if (target.width === width && target.height === height) return true;
    const gl = this.gl;
    this.clearGlErrors();
    try {
      // Internal targets own units 0/1. Never let allocation overwrite an
      // image uniform that remains bound on unit 2 or above between frames.
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, target.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MIN_FILTER,
        target.format.minFilter,
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MAG_FILTER,
        target.format.magFilter,
      );
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        target.format.internalFormat,
        width,
        height,
        0,
        target.format.format,
        target.format.type,
        null,
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        target.texture,
        0,
      );
      const complete =
        gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE &&
        gl.getError() === gl.NO_ERROR;
      if (!complete) {
        target.width = 0;
        target.height = 0;
        return false;
      }
      target.width = width;
      target.height = height;
      return true;
    } catch {
      target.width = 0;
      target.height = 0;
      return false;
    }
  }

  private allocateBlurTarget(
    target: RenderTarget,
    width: number,
    height: number,
  ) {
    if (target.width === width && target.height === height) return true;
    if (
      this.faultInjection?.shouldFailBlurTargetAllocation?.({
        precision: target.format.precision,
        width,
        height,
      })
    ) {
      target.width = 0;
      target.height = 0;
      return false;
    }
    return this.allocateTarget(target, width, height);
  }

  private allocateSceneTarget(width: number, height: number) {
    if (
      (this.sceneTarget.width !== width ||
        this.sceneTarget.height !== height) &&
      this.faultInjection?.shouldFailSceneTargetAllocation?.({ width, height })
    ) {
      this.sceneTarget.width = 0;
      this.sceneTarget.height = 0;
      return false;
    }
    return this.allocateTarget(this.sceneTarget, width, height);
  }

  private allocateBlurTargetSet(
    targets: readonly RenderTarget[],
    dimensions: readonly { width: number; height: number }[],
  ) {
    const requiresAllocation = targets.some((target, index) => {
      const size = dimensions[index];
      return (
        !size || target.width !== size.width || target.height !== size.height
      );
    });
    if (!requiresAllocation) return;
    const reallocatesExistingTargets = targets.some(
      (target) => target.width > 0 && target.height > 0,
    );
    const allocateAll = () => {
      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index];
        const size = dimensions[index];
        if (!target || !size) return false;
        if (!this.allocateBlurTarget(target, size.width, size.height)) {
          return false;
        }
      }
      return true;
    };
    if (allocateAll()) {
      if (reallocatesExistingTargets) this.blurTargetReallocationCount += 1;
      return;
    }
    const largest = dimensions[0] ?? { width: 0, height: 0 };
    if (this.blurTargetFormat.precision === "rgba8") {
      throw new Error(
        `Unable to allocate Zen multipass blur targets at ${largest.width}x${largest.height}: RGBA8 allocation failed`,
      );
    }

    // A format can pass a small capability probe yet fail at the requested
    // dimensions. Downgrade both ping-pong targets together so passes never
    // mix precisions, then retry the real allocation once.
    this.blurTargetFormat = createRgba8TargetFormat(this.gl);
    for (const target of [
      this.blurTargetA,
      this.blurTargetB,
      ...this.kawaseTargets,
    ]) {
      target.format = this.blurTargetFormat;
      target.width = 0;
      target.height = 0;
    }
    if (!allocateAll()) {
      throw new Error(
        `Unable to allocate Zen multipass blur targets at ${largest.width}x${largest.height}: RGBA16F and RGBA8 allocations failed`,
      );
    }
    if (reallocatesExistingTargets) this.blurTargetReallocationCount += 1;
  }

  private allocateBlurTargets(width: number, height: number) {
    this.allocateBlurTargetSet(
      [this.blurTargetA, this.blurTargetB],
      [
        { width, height },
        { width, height },
      ],
    );
  }

  private allocateKawaseTargets(plan: ZenDualKawasePlan) {
    this.allocateBlurTargetSet(this.kawaseTargets, plan.levels);
  }

  private resizeTargets() {
    if (this.disposed) return;
    const rect = this.host.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const view = this.host.ownerDocument.defaultView;
    const devicePixelRatio = Math.max(1, view?.devicePixelRatio ?? 1);
    const targetScale = Math.max(devicePixelRatio, this.minPixelRatio);
    const targetWidth = Math.max(1, Math.round(rect.width * targetScale));
    const targetHeight = Math.max(1, Math.round(rect.height * targetScale));
    const budgetScale = Math.min(
      1,
      Math.sqrt(this.maxPixelCount / (targetWidth * targetHeight)),
    );
    const width = Math.max(1, Math.round(targetWidth * budgetScale));
    const height = Math.max(1, Math.round(targetHeight * budgetScale));
    const nextRenderScale = width / rect.width;
    const renderScaleChanged = this.renderScale !== nextRenderScale;
    const cssSizeChanged =
      this.cssWidth !== rect.width || this.cssHeight !== rect.height;
    this.renderScale = nextRenderScale;
    this.cssWidth = rect.width;
    this.cssHeight = rect.height;
    const targetReady =
      this.sceneTarget.width === width && this.sceneTarget.height === height;
    if (
      this.canvas.width === width &&
      this.canvas.height === height &&
      targetReady &&
      !renderScaleChanged &&
      !cssSizeChanged
    ) {
      return;
    }
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    if (!this.allocateSceneTarget(width, height)) {
      throw new Error("Unable to allocate Zen multipass scene target");
    }
    this.blurPlanKey = "";
    this.invalidateScene();
  }

  private readonly resize = () => {
    if (this.disposed || this.failed) return;
    try {
      this.resizeTargets();
    } catch (error) {
      this.fail(error);
    }
  };

  private fail(error: unknown) {
    if (this.disposed || this.failed) return;
    this.failed = true;
    this.gpuTimerSampler?.dispose();
    this.animationSpeed = 0;
    this.lastAnimationTimestamp = null;
    this.animationCadence.reset();
    this.needsDraw = false;
    if (this.rafId !== null) {
      this.cancelFrame(this.rafId);
      this.rafId = null;
    }
    this.onFatalError(error);
  }

  private scheduleFrame() {
    if (this.disposed || this.failed || this.rafId !== null) return;
    this.rafId = this.requestFrame(this.flushFrame);
  }

  private readonly flushFrame = (timestamp: number) => {
    this.rafId = null;
    if (this.disposed || this.failed) return;

    try {
      if (this.animationSpeed > 0) {
        if (this.lastAnimationTimestamp !== null) {
          const elapsed = Math.max(0, timestamp - this.lastAnimationTimestamp);
          this.frame += elapsed * this.animationSpeed;
          if (this.animationCadence.advance(elapsed)) {
            this.dirtyScene = true;
            this.dirtyBlur = true;
            this.dirtyComposite = true;
            this.needsDraw = true;
          }
        }
        this.lastAnimationTimestamp = timestamp;
      }

      if (this.needsDraw) {
        this.needsDraw = false;
        this.draw();
      }

      if (this.animationSpeed > 0) this.scheduleFrame();
    } catch (error) {
      this.fail(error);
    }
  };

  private requestDraw() {
    this.needsDraw = true;
    this.scheduleFrame();
  }

  private invalidateScene() {
    this.dirtyScene = true;
    this.dirtyBlur = true;
    this.dirtyComposite = true;
    this.requestDraw();
  }

  private invalidateBlur() {
    this.dirtyBlur = true;
    this.dirtyComposite = true;
    this.requestDraw();
  }

  private invalidateComposite() {
    this.dirtyComposite = true;
    this.requestDraw();
  }

  private setImageUniform(
    program: WebGLProgram,
    name: string,
    image: HTMLImageElement,
  ) {
    const gl = this.gl;
    const location = this.uniformLocation(program, name);
    const aspectLocation = this.uniformLocation(program, `${name}AspectRatio`);
    if (location === null) {
      if (aspectLocation !== null) {
        gl.uniform1f(aspectLocation, image.naturalWidth / image.naturalHeight);
      }
      return;
    }
    let programTextures = this.imageTextures.get(program);
    if (!programTextures) {
      programTextures = new Map();
      this.imageTextures.set(program, programTextures);
    }
    let stored = programTextures.get(name);
    if (!stored || stored.image !== image) {
      const texture = gl.createTexture();
      if (!texture) return;
      if (stored) gl.deleteTexture(stored.texture);
      const unit =
        stored?.unit ??
        ZEN_INTERMEDIATE_TEXTURE_UNIT_COUNT + programTextures.size;
      const maxCombinedTextureUnits = Number(
        gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
      );
      if (unit >= maxCombinedTextureUnits) {
        gl.deleteTexture(texture);
        throw new Error("Zen multipass image texture unit limit exceeded");
      }
      stored = {
        image,
        texture,
        unit,
      };
      programTextures.set(name, stored);
      gl.activeTexture(gl.TEXTURE0 + stored.unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        image,
      );
      if (this.mipmaps.includes(name)) {
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(
          gl.TEXTURE_2D,
          gl.TEXTURE_MIN_FILTER,
          gl.LINEAR_MIPMAP_LINEAR,
        );
      }
    }
    gl.activeTexture(gl.TEXTURE0 + stored.unit);
    gl.bindTexture(gl.TEXTURE_2D, stored.texture);
    gl.uniform1i(location, stored.unit);
    if (aspectLocation !== null) {
      gl.uniform1f(aspectLocation, image.naturalWidth / image.naturalHeight);
    }
  }

  private bindImageTextures(program: WebGLProgram) {
    const programTextures = this.imageTextures.get(program);
    if (!programTextures) return;
    for (const stored of programTextures.values()) {
      this.gl.activeTexture(this.gl.TEXTURE0 + stored.unit);
      this.gl.bindTexture(this.gl.TEXTURE_2D, stored.texture);
    }
  }

  private setUniform(
    program: WebGLProgram,
    name: string,
    value: ShaderMountUniforms[string],
  ) {
    if (value === undefined) return;
    if (isImage(value)) {
      this.setImageUniform(program, name, value);
      return;
    }
    const gl = this.gl;
    const location = this.uniformLocation(program, name);
    if (location === null) return;
    if (value instanceof Float32Array) {
      gl.uniform4fv(location, value);
      return;
    }
    if (Array.isArray(value)) {
      const nested = Array.isArray(value[0]);
      const childLength = nested ? (value[0] as number[]).length : value.length;
      const flat = (nested ? value.flat() : value) as number[];
      if (childLength === 2) gl.uniform2fv(location, flat);
      else if (childLength === 3) gl.uniform3fv(location, flat);
      else if (childLength === 4) gl.uniform4fv(location, flat);
      else if (childLength === 9) gl.uniformMatrix3fv(location, false, flat);
      else if (childLength === 16) gl.uniformMatrix4fv(location, false, flat);
      return;
    }
    if (typeof value === "boolean") {
      gl.uniform1i(location, value ? 1 : 0);
    } else if (typeof value === "number") {
      gl.uniform1f(location, value);
    }
  }

  private applyUniforms(program: WebGLProgram, uniforms: ShaderMountUniforms) {
    for (const [name, value] of Object.entries(uniforms)) {
      this.setUniform(program, name, value);
    }
  }

  private useBundle(bundle: ProgramBundle) {
    this.gl.useProgram(bundle.program);
    this.gl.bindVertexArray(bundle.vao);
  }

  private unbindIntermediateTextures() {
    for (let unit = 0; unit < ZEN_INTERMEDIATE_TEXTURE_UNIT_COUNT; unit += 1) {
      this.gl.activeTexture(this.gl.TEXTURE0 + unit);
      this.gl.bindTexture(this.gl.TEXTURE_2D, null);
    }
  }

  private drawScene() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneTarget.framebuffer);
    gl.viewport(0, 0, this.sceneTarget.width, this.sceneTarget.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.useBundle(this.sceneProgram);
    this.unbindIntermediateTextures();
    if (this.dirtySceneUniforms) {
      this.applyUniforms(this.sceneProgram.program, this.sceneUniforms);
      this.dirtySceneUniforms = false;
      this.faultInjection?.onStaticUniformsApplied?.("scene");
    }
    this.bindImageTextures(this.sceneProgram.program);
    for (const name of ["u_paperResolution", "u_resolution"]) {
      const resolution = this.uniformLocation(this.sceneProgram.program, name);
      if (resolution !== null) {
        gl.uniform2f(
          resolution,
          this.sceneTarget.width,
          this.sceneTarget.height,
        );
      }
    }
    for (const name of ["u_paperPixelRatio", "u_pixelRatio"]) {
      const pixelRatio = this.uniformLocation(this.sceneProgram.program, name);
      if (pixelRatio !== null) gl.uniform1f(pixelRatio, this.renderScale);
    }
    const time = this.uniformLocation(this.sceneProgram.program, "u_time");
    if (time !== null) gl.uniform1f(time, this.frame * 0.001);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.drawCallCount += 1;
  }

  private prepareBlurPlan(blurRadius: number, activeGlass: boolean) {
    const key = activeGlass
      ? [
          this.researchOptions.backend,
          blurRadius,
          this.renderScale,
          this.cssWidth,
          this.cssHeight,
          this.researchOptions.dualKawase.passes,
          this.researchOptions.dualKawase.offset,
        ].join(":")
      : "inactive";
    if (key === this.blurPlanKey) {
      return this.activeBlurPlan !== null || this.activeKawasePlan !== null;
    }
    this.blurPlanKey = "";
    this.activeBlurPlan = null;
    this.activeKawasePlan = null;
    const gaussianPlan = activeGlass
      ? resolveZenMultipassBlurPlan(
          blurRadius,
          this.renderScale,
          this.cssWidth,
          this.cssHeight,
        )
      : null;
    this.gaussianPairCount = 0;
    if (!gaussianPlan) {
      this.blurPlanKey = key;
      return false;
    }

    if (this.researchOptions.backend !== "gaussian-current") {
      const kawasePlan = resolveZenDualKawasePlan({
        backend: this.researchOptions.backend,
        sceneWidth: this.sceneTarget.width,
        sceneHeight: this.sceneTarget.height,
        baseWidth:
          this.researchOptions.backend === "dual-kawase-planned"
            ? gaussianPlan.targetWidth
            : undefined,
        baseHeight:
          this.researchOptions.backend === "dual-kawase-planned"
            ? gaussianPlan.targetHeight
            : undefined,
        passes: this.researchOptions.dualKawase.passes,
        offset: this.researchOptions.dualKawase.offset,
        textureFormat: this.blurTargetFormat.precision,
      });
      if (!kawasePlan) {
        this.blurPlanKey = key;
        return false;
      }
      this.allocateKawaseTargets(kawasePlan);

      if (kawasePlan.requiresPrefilter) {
        const gl = this.gl;
        this.useBundle(this.downsampleProgram);
        gl.uniform2f(
          this.uniformLocation(
            this.downsampleProgram.program,
            "u_sourceTexelSize",
          ),
          1 / this.sceneTarget.width,
          1 / this.sceneTarget.height,
        );
        gl.uniform2f(
          this.uniformLocation(
            this.downsampleProgram.program,
            "u_sourceToTargetScale",
          ),
          this.sceneTarget.width / kawasePlan.baseWidth,
          this.sceneTarget.height / kawasePlan.baseHeight,
        );
      }
      this.blurPlanKey = key;
      this.activeBlurPlan = gaussianPlan;
      this.activeKawasePlan = kawasePlan;
      return true;
    }

    this.allocateBlurTargets(
      gaussianPlan.targetWidth,
      gaussianPlan.targetHeight,
    );
    const kernel = buildZenGaussianKernel(
      gaussianPlan.kernelSigmaInTargetPixels,
    );
    this.gaussianPairCount = kernel.pairCount;

    const gl = this.gl;
    this.useBundle(this.gaussianProgram);
    gl.uniform1f(
      this.uniformLocation(this.gaussianProgram.program, "u_centerWeight"),
      kernel.centerWeight,
    );
    gl.uniform1fv(
      this.uniformLocation(this.gaussianProgram.program, "u_pairOffsets[0]"),
      kernel.pairOffsets,
    );
    gl.uniform1fv(
      this.uniformLocation(this.gaussianProgram.program, "u_pairWeights[0]"),
      kernel.pairWeights,
    );
    gl.uniform1i(
      this.uniformLocation(this.gaussianProgram.program, "u_pairCount"),
      kernel.pairCount,
    );

    if (gaussianPlan.requiresDownsample) {
      this.useBundle(this.downsampleProgram);
      gl.uniform2f(
        this.uniformLocation(
          this.downsampleProgram.program,
          "u_sourceTexelSize",
        ),
        1 / this.sceneTarget.width,
        1 / this.sceneTarget.height,
      );
      gl.uniform2f(
        this.uniformLocation(
          this.downsampleProgram.program,
          "u_sourceToTargetScale",
        ),
        this.sceneTarget.width / gaussianPlan.targetWidth,
        this.sceneTarget.height / gaussianPlan.targetHeight,
      );
    }
    this.blurPlanKey = key;
    this.activeBlurPlan = gaussianPlan;
    return true;
  }

  private applyQuantizationDither(program: WebGLProgram, passSeed: number) {
    const gl = this.gl;
    const strength =
      this.blurTargetFormat.precision === "rgba8"
        ? this.researchOptions.rgba8Dither.strength
        : 0;
    gl.uniform1f(
      this.uniformLocation(program, "u_quantizationDitherStrength"),
      strength,
    );
    gl.uniform1f(
      this.uniformLocation(program, "u_quantizationDitherSeed"),
      this.researchOptions.rgba8Dither.seed + passSeed,
    );
  }

  private drawDownsamplePass(source: WebGLTexture, target: RenderTarget) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    this.useBundle(this.downsampleProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source);
    this.applyQuantizationDither(this.downsampleProgram.program, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.drawCallCount += 1;
  }

  private drawGaussianPass(
    source: WebGLTexture,
    target: RenderTarget,
    directionX: number,
    directionY: number,
  ) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    this.useBundle(this.gaussianProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source);
    gl.uniform2f(
      this.uniformLocation(this.gaussianProgram.program, "u_blurDirection"),
      directionX,
      directionY,
    );
    this.applyQuantizationDither(
      this.gaussianProgram.program,
      directionX === 0 ? 3 : 2,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.drawCallCount += 1;
  }

  private drawKawasePass(
    program: ProgramBundle,
    source: WebGLTexture,
    sourceWidth: number,
    sourceHeight: number,
    target: RenderTarget,
    passSeed: number,
  ) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    this.useBundle(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source);
    gl.uniform2f(
      this.uniformLocation(program.program, "u_sourceTexelSize"),
      1 / sourceWidth,
      1 / sourceHeight,
    );
    gl.uniform1f(
      this.uniformLocation(program.program, "u_offset"),
      this.researchOptions.dualKawase.offset,
    );
    this.applyQuantizationDither(program.program, passSeed);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.drawCallCount += 1;
  }

  private drawComposite(blurredTexture: WebGLTexture) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    // The canonical Composite shader writes an opaque value for every pixel.
    // Clearing the default framebuffer would duplicate a full-screen write.
    this.useBundle(this.compositeProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTarget.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, blurredTexture);
    gl.uniform2f(
      this.uniformLocation(this.compositeProgram.program, "u_resolution"),
      this.canvas.width,
      this.canvas.height,
    );
    gl.uniform1f(
      this.uniformLocation(this.compositeProgram.program, "u_pixelRatio"),
      this.renderScale,
    );
    if (this.dirtyCompositeUniforms) {
      this.applyUniforms(this.compositeProgram.program, this.compositeUniforms);
      this.dirtyCompositeUniforms = false;
      this.faultInjection?.onStaticUniformsApplied?.("composite");
    }
    const displayNoise = this.researchOptions.displayNoise;
    gl.uniform1f(
      this.uniformLocation(
        this.compositeProgram.program,
        "u_zenGlassNoiseStrength",
      ),
      displayNoise.mode === "procedural-white" ? displayNoise.strength : 0,
    );
    gl.uniform1f(
      this.uniformLocation(
        this.compositeProgram.program,
        "u_zenGlassNoiseSeed",
      ),
      displayNoise.seed,
    );
    this.bindImageTextures(this.compositeProgram.program);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.drawCallCount += 1;
  }

  private drawBlurPipeline(timingFrame: boolean) {
    const gpuTimerSampler = this.gpuTimerSampler;
    const blurRadius = Number(this.compositeUniforms.u_zenGlassBlur ?? 0);
    const hasBlurPlan = this.prepareBlurPlan(
      blurRadius,
      this.activeGlassSurface,
    );
    this.blurredTexture = this.sceneTarget.texture;
    const kawasePlan = this.activeKawasePlan;
    if (hasBlurPlan && kawasePlan) {
      const downsampleProgram = this.kawaseDownsampleProgram;
      const upsampleProgram = this.kawaseUpsampleProgram;
      if (!downsampleProgram || !upsampleProgram) {
        throw new Error("Dual Kawase programs are unavailable");
      }

      if (kawasePlan.requiresPrefilter) {
        const baseTarget = this.kawaseTargets[0];
        if (!baseTarget)
          throw new Error("Dual Kawase base target is unavailable");
        const drawPrefilter = () =>
          this.drawDownsamplePass(this.sceneTarget.texture, baseTarget);
        if (timingFrame && gpuTimerSampler) {
          gpuTimerSampler.measure("downsample", drawPrefilter);
        } else {
          drawPrefilter();
        }
      }

      for (
        let levelIndex = 1;
        levelIndex <= kawasePlan.passes;
        levelIndex += 1
      ) {
        const target = this.kawaseTargets[levelIndex];
        const sourceTarget = this.kawaseTargets[levelIndex - 1];
        if (!target || !sourceTarget) {
          throw new Error("Dual Kawase downsample target is unavailable");
        }
        const sourceTexture =
          levelIndex === 1 && !kawasePlan.requiresPrefilter
            ? this.sceneTarget.texture
            : sourceTarget.texture;
        const sourceWidth =
          levelIndex === 1 && !kawasePlan.requiresPrefilter
            ? this.sceneTarget.width
            : sourceTarget.width;
        const sourceHeight =
          levelIndex === 1 && !kawasePlan.requiresPrefilter
            ? this.sceneTarget.height
            : sourceTarget.height;
        const drawKawaseDown = () =>
          this.drawKawasePass(
            downsampleProgram,
            sourceTexture,
            sourceWidth,
            sourceHeight,
            target,
            10 + levelIndex,
          );
        if (timingFrame && gpuTimerSampler) {
          gpuTimerSampler.measure("kawaseDown", drawKawaseDown);
        } else {
          drawKawaseDown();
        }
      }

      for (
        let levelIndex = kawasePlan.passes - 1;
        levelIndex >= 0;
        levelIndex -= 1
      ) {
        const sourceTarget = this.kawaseTargets[levelIndex + 1];
        const target = this.kawaseTargets[levelIndex];
        if (!sourceTarget || !target) {
          throw new Error("Dual Kawase upsample target is unavailable");
        }
        const drawKawaseUp = () =>
          this.drawKawasePass(
            upsampleProgram,
            sourceTarget.texture,
            sourceTarget.width,
            sourceTarget.height,
            target,
            20 + levelIndex,
          );
        if (timingFrame && gpuTimerSampler) {
          gpuTimerSampler.measure("kawaseUp", drawKawaseUp);
        } else {
          drawKawaseUp();
        }
      }
      const baseTarget = this.kawaseTargets[0];
      if (!baseTarget)
        throw new Error("Dual Kawase output target is unavailable");
      this.blurredTexture = baseTarget.texture;
    } else if (hasBlurPlan && this.activeBlurPlan) {
      const plan = this.activeBlurPlan;
      let horizontalSource = this.sceneTarget.texture;
      let horizontalTarget = this.blurTargetA;
      let verticalTarget = this.blurTargetB;
      if (plan.requiresDownsample) {
        if (timingFrame && gpuTimerSampler) {
          gpuTimerSampler.measure("downsample", () =>
            this.drawDownsamplePass(this.sceneTarget.texture, this.blurTargetA),
          );
        } else {
          this.drawDownsamplePass(this.sceneTarget.texture, this.blurTargetA);
        }
        horizontalSource = this.blurTargetA.texture;
        horizontalTarget = this.blurTargetB;
        verticalTarget = this.blurTargetA;
      }
      if (timingFrame && gpuTimerSampler) {
        gpuTimerSampler.measure("gaussianHorizontal", () =>
          this.drawGaussianPass(
            horizontalSource,
            horizontalTarget,
            1 / plan.targetWidth,
            0,
          ),
        );
        gpuTimerSampler.measure("gaussianVertical", () =>
          this.drawGaussianPass(
            horizontalTarget.texture,
            verticalTarget,
            0,
            1 / plan.targetHeight,
          ),
        );
      } else {
        this.drawGaussianPass(
          horizontalSource,
          horizontalTarget,
          1 / plan.targetWidth,
          0,
        );
        this.drawGaussianPass(
          horizontalTarget.texture,
          verticalTarget,
          0,
          1 / plan.targetHeight,
        );
      }
      this.blurredTexture = verticalTarget.texture;
    }
  }

  private drawDirtyWork(timingFrame: boolean): boolean {
    const gpuTimerSampler = this.gpuTimerSampler;
    let rendered = false;
    if (this.dirtyScene) {
      if (timingFrame && gpuTimerSampler) {
        gpuTimerSampler.measure("scene", () => this.drawScene());
      } else {
        this.drawScene();
      }
      this.dirtyScene = false;
      this.dirtyBlur = true;
      this.dirtyComposite = true;
      rendered = true;
    }

    if (this.dirtyBlur) {
      const drawBlur = () => this.drawBlurPipeline(timingFrame);
      if (timingFrame && gpuTimerSampler) {
        gpuTimerSampler.measureScope("blur", drawBlur);
      } else {
        drawBlur();
      }
      this.dirtyBlur = false;
      this.dirtyComposite = true;
      rendered = true;
    }

    if (this.dirtyComposite) {
      if (timingFrame && gpuTimerSampler) {
        gpuTimerSampler.measure("composite", () =>
          this.drawComposite(this.blurredTexture),
        );
      } else {
        this.drawComposite(this.blurredTexture);
      }
      this.dirtyComposite = false;
      rendered = true;
    }
    return rendered;
  }

  private draw() {
    if (
      this.disposed ||
      this.canvas.width <= 0 ||
      this.canvas.height <= 0 ||
      this.sceneTarget.width <= 0
    ) {
      return;
    }
    const hasDirtyWork =
      this.dirtyScene || this.dirtyBlur || this.dirtyComposite;
    const gpuTimerSampler = this.gpuTimerSampler;
    const cpuSubmitSamples = this.cpuSubmitSamples;
    const viewPerformance = cpuSubmitSamples
      ? this.host.ownerDocument.defaultView?.performance
      : undefined;
    const submitStartedAt =
      hasDirtyWork && cpuSubmitSamples
        ? (viewPerformance?.now() ?? Date.now())
        : null;
    const submitDrawCallStart = cpuSubmitSamples ? this.drawCallCount : 0;
    let rendered = false;
    let timingFrame = false;
    if (hasDirtyWork && gpuTimerSampler) {
      // beginFrame polls any prior batch before deciding whether to sample.
      timingFrame = gpuTimerSampler.beginFrame(this.drawCount + 1);
    } else {
      gpuTimerSampler?.poll();
    }

    try {
      const drawDirtyWork = () => {
        rendered = this.drawDirtyWork(timingFrame);
      };
      if (timingFrame && gpuTimerSampler) {
        gpuTimerSampler.measureScope("frame", drawDirtyWork);
      } else {
        drawDirtyWork();
      }
    } finally {
      if (timingFrame) gpuTimerSampler?.endFrame();
    }

    if (rendered) {
      this.drawCount += 1;
      this.hasRenderedFrame = true;
      if (cpuSubmitSamples) {
        const submittedAt = viewPerformance?.now() ?? Date.now();
        const cpuSubmitTimeMs = Math.max(
          0,
          submittedAt - (submitStartedAt ?? submittedAt),
        );
        const sample = {
          drawCount: this.drawCount,
          drawCallCount: this.drawCallCount - submitDrawCallStart,
          cpuSubmitTimeMs,
        } satisfies ZenCpuSubmitSample;
        this.cpuSubmitTimeMs = cpuSubmitTimeMs;
        cpuSubmitSamples.push(sample);
        if (
          cpuSubmitSamples.length >
          this.researchOptions.gpuTiming.maxRecordedSamples
        ) {
          cpuSubmitSamples.splice(
            0,
            cpuSubmitSamples.length -
              this.researchOptions.gpuTiming.maxRecordedSamples,
          );
        }
      }
    }
  }

  setFrame = (frame: number) => {
    this.frame = Number.isFinite(frame) ? frame : 0;
    this.invalidateScene();
  };

  setSpeed = (speed: number) => {
    const nextSpeed = Number.isFinite(speed) ? Math.max(0, speed) : 0;
    if (nextSpeed === this.animationSpeed) return;
    this.animationSpeed = nextSpeed;
    this.lastAnimationTimestamp = null;
    this.animationCadence.reset();
    if (nextSpeed > 0) this.scheduleFrame();
  };

  setSceneUniforms(
    sceneUniforms: ShaderMountUniforms,
    mipmaps: readonly string[],
  ) {
    this.sceneUniforms = sceneUniforms;
    this.mipmaps = mipmaps;
    this.dirtySceneUniforms = true;
    this.invalidateScene();
  }

  setCompositeUniforms(compositeUniforms: ShaderMountUniforms) {
    const previousBlur = Number(this.compositeUniforms.u_zenGlassBlur ?? 0);
    const nextBlur = Number(compositeUniforms.u_zenGlassBlur ?? 0);
    const previousActiveGlass = this.activeGlassSurface;
    const nextActiveGlass = hasActiveGlassSurface(compositeUniforms);
    this.compositeUniforms = compositeUniforms;
    this.dirtyCompositeUniforms = true;
    this.activeGlassSurface = nextActiveGlass;
    if (previousBlur !== nextBlur || previousActiveGlass !== nextActiveGlass) {
      this.invalidateBlur();
    } else {
      this.invalidateComposite();
    }
  }

  getPerformanceStats = (): ZenMultipassPerformanceStats => {
    this.gpuTimerSampler?.poll();
    const gpuTiming =
      this.gpuTimerSampler?.getSnapshot() ?? IDLE_ZEN_GPU_TIMING;
    const kawaseLevels = this.kawaseTargets.filter(
      (target) => target.width > 0 && target.height > 0,
    );
    const blurTargets =
      this.researchOptions.backend !== "gaussian-current"
        ? kawaseLevels
        : [this.blurTargetA, this.blurTargetB].filter(
            (target) => target.width > 0 && target.height > 0,
          );
    const blurTargetLevels = blurTargets.map((target, level) => ({
      level,
      width: target.width,
      height: target.height,
      format: target.format.precision,
      bytes: renderTargetBytes(target),
    }));
    const blurBase = blurTargets[0];
    const cpuSubmitSummary = this.cpuSubmitSamples
      ? timingPercentiles(
          this.cpuSubmitSamples.map(({ cpuSubmitTimeMs }) => cpuSubmitTimeMs),
        )
      : null;
    return {
      drawCount: this.drawCount,
      drawCallCount: this.drawCallCount,
      backend: this.researchOptions.backend,
      ...gpuTiming,
      isStaticFrameReady:
        this.hasRenderedFrame &&
        !this.dirtyScene &&
        !this.dirtyBlur &&
        !this.dirtyComposite &&
        !this.failed &&
        this.canvas.width > 0 &&
        this.canvas.height > 0,
      blurFormat: this.blurTargetFormat.precision,
      blurTargetAFormat: this.blurTargetA.format.precision,
      blurTargetBFormat: this.blurTargetB.format.precision,
      sceneTargetWidth: this.sceneTarget.width,
      sceneTargetHeight: this.sceneTarget.height,
      blurTargetWidth: blurBase?.width ?? 0,
      blurTargetHeight: blurBase?.height ?? 0,
      gaussianPairCount: this.gaussianPairCount,
      kawaseDownsamplePassCount:
        this.activeKawasePlan?.downsamplePassCount ?? 0,
      kawaseUpsamplePassCount: this.activeKawasePlan?.upsamplePassCount ?? 0,
      blurTargetLevels,
      intermediateTextureBytes: blurTargetLevels.reduce(
        (total, level) => total + level.bytes,
        0,
      ),
      blurTargetReallocationCount: this.blurTargetReallocationCount,
      cpuSubmitTimeMs: this.cpuSubmitTimeMs,
      cpuSubmitSampleCount: this.cpuSubmitSamples?.length ?? 0,
      cpuSubmitSummary,
      displayNoise: { ...this.researchOptions.displayNoise },
      rgba8Dither: { ...this.researchOptions.rgba8Dither },
    };
  };

  getPerformanceReport = (): ZenMultipassPerformanceReport => ({
    schemaVersion: 1,
    capturedAtEpochMs: Date.now(),
    backend: this.researchOptions.backend,
    gpuTimingMode: this.researchOptions.gpuTiming.measurementMode ?? "off",
    researchOptions: {
      ...this.researchOptions,
      dualKawase: { ...this.researchOptions.dualKawase },
      displayNoise: { ...this.researchOptions.displayNoise },
      rgba8Dither: { ...this.researchOptions.rgba8Dither },
      gpuTiming: { ...this.researchOptions.gpuTiming },
    },
    gpuMetadata: {
      ...(this.gpuMetadata ?? EMPTY_ZEN_WEB_GL_METADATA),
    },
    performanceStats: this.getPerformanceStats(),
    gpuBenchmark:
      this.gpuTimerSampler?.getBenchmarkReport() ?? EMPTY_ZEN_GPU_BENCHMARK,
    cpuSubmit: {
      samples: this.cpuSubmitSamples?.map((sample) => ({ ...sample })) ?? [],
      summary: this.cpuSubmitSamples
        ? timingPercentiles(
            this.cpuSubmitSamples.map(({ cpuSubmitTimeMs }) => cpuSubmitTimeMs),
          )
        : null,
    },
  });

  getCurrentFrame = () => this.frame;

  resetPerformanceStats = () => {
    this.drawCount = 0;
    this.drawCallCount = 0;
    this.blurTargetReallocationCount = 0;
    if (this.cpuSubmitSamples) this.cpuSubmitSamples = [];
    this.cpuSubmitTimeMs = null;
    this.gpuTimerSampler?.reset();
  };

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.gpuTimerSampler?.dispose();
    this.animationSpeed = 0;
    this.lastAnimationTimestamp = null;
    this.animationCadence.reset();
    this.needsDraw = false;
    if (this.rafId !== null) {
      this.cancelFrame(this.rafId);
      this.rafId = null;
    }
    this.resizeObserver?.disconnect();
    this.host.ownerDocument.defaultView?.removeEventListener(
      "resize",
      this.resize,
    );
    const gl = this.gl;
    for (const programTextures of this.imageTextures.values()) {
      for (const stored of programTextures.values()) {
        gl.deleteTexture(stored.texture);
      }
    }
    this.imageTextures.clear();
    deleteRendererResources(gl, {
      sceneProgram: this.sceneProgram,
      downsampleProgram: this.downsampleProgram,
      gaussianProgram: this.gaussianProgram,
      kawaseDownsampleProgram: this.kawaseDownsampleProgram,
      kawaseUpsampleProgram: this.kawaseUpsampleProgram,
      compositeProgram: this.compositeProgram,
      sceneTarget: this.sceneTarget,
      blurTargetA: this.blurTargetA,
      blurTargetB: this.blurTargetB,
      kawaseTargets: this.kawaseTargets,
    });
  }
}

export const ZenBlurResearchCanvas = forwardRef<
  PaperShaderElement,
  ZenBlurResearchCanvasProps
>(function ZenBlurResearchCanvas(
  {
    sceneFragment,
    sceneUniforms,
    compositeFragment,
    compositeUniforms,
    mipmaps = EMPTY_ZEN_MIPMAPS,
    minPixelRatio,
    maxPixelCount,
    webGlContextAttributes,
    blurTargetPrecision = "auto",
    researchOptions = DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS,
    speed = 0,
    className,
    style,
    "data-paper-shader": paperShader,
    "data-zen-glass-compositor": ownsGlass,
  },
  forwardedRef,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ZenMultipassRenderer | null>(null);
  const failureLoggedRef = useRef(false);
  const failureTimerRef = useRef<number | null>(null);
  const setupGenerationRef = useRef(0);
  const latestRendererInputsRef = useRef({
    sceneUniforms,
    compositeUniforms,
    mipmaps,
    speed,
  });
  latestRendererInputsRef.current = {
    sceneUniforms,
    compositeUniforms,
    mipmaps,
    speed,
  };

  useImperativeHandle(
    forwardedRef,
    () => hostRef.current as unknown as PaperShaderElement,
    [],
  );

  useLayoutEffect(() => {
    const host = hostRef.current as unknown as PaperShaderElement | null;
    const canvas = canvasRef.current;
    if (!host || !canvas) return undefined;
    const view = host.ownerDocument.defaultView;
    const setupGeneration = setupGenerationRef.current + 1;
    setupGenerationRef.current = setupGeneration;
    if (failureTimerRef.current !== null) {
      view?.clearTimeout(failureTimerRef.current);
      failureTimerRef.current = null;
    }
    let failureReported = false;
    const cancelFailureTimer = () => {
      if (failureTimerRef.current === null) return;
      view?.clearTimeout(failureTimerRef.current);
      failureTimerRef.current = null;
    };
    const reportFailure = (error: unknown) => {
      if (setupGenerationRef.current !== setupGeneration || failureReported) {
        return;
      }
      failureReported = true;
      if (!failureLoggedRef.current) {
        failureLoggedRef.current = true;
        console.error("[zen-shader] multipass renderer failed", error);
      }
      let timerId: number | null = null;
      timerId =
        view?.setTimeout(() => {
          if (failureTimerRef.current === timerId) {
            failureTimerRef.current = null;
          }
          if (setupGenerationRef.current !== setupGeneration) return;
          if (!host.isConnected) return;
          const EventConstructor = view.Event;
          host.dispatchEvent(
            new EventConstructor("webglcontextlost", {
              bubbles: true,
              cancelable: true,
            }),
          );
        }, 0) ?? null;
      failureTimerRef.current = timerId;
    };
    try {
      const latestInputs = latestRendererInputsRef.current;
      const renderer = new ZenMultipassRenderer(
        host,
        canvas,
        sceneFragment,
        latestInputs.sceneUniforms,
        compositeFragment,
        latestInputs.compositeUniforms,
        latestInputs.mipmaps,
        minPixelRatio,
        maxPixelCount,
        webGlContextAttributes,
        reportFailure,
        blurTargetPrecision,
        researchOptions,
      );
      failureLoggedRef.current = false;
      renderer.setSpeed(latestInputs.speed);
      rendererRef.current = renderer;
      host.paperShaderMount = {
        setFrame: renderer.setFrame,
        setSpeed: renderer.setSpeed,
        getCurrentFrame: renderer.getCurrentFrame,
        getPerformanceStats: renderer.getPerformanceStats,
        getPerformanceReport: renderer.getPerformanceReport,
        resetPerformanceStats: renderer.resetPerformanceStats,
      } as unknown as ShaderMount;
      return () => {
        cancelFailureTimer();
        renderer.dispose();
        rendererRef.current = null;
        delete host.paperShaderMount;
      };
    } catch (error) {
      reportFailure(error);
      return cancelFailureTimer;
    }
  }, [
    compositeFragment,
    blurTargetPrecision,
    maxPixelCount,
    minPixelRatio,
    researchOptions,
    sceneFragment,
    webGlContextAttributes,
  ]);

  useLayoutEffect(() => {
    rendererRef.current?.setSceneUniforms(sceneUniforms, mipmaps);
  }, [mipmaps, sceneUniforms]);

  useLayoutEffect(() => {
    rendererRef.current?.setCompositeUniforms(compositeUniforms);
  }, [compositeUniforms]);

  useLayoutEffect(() => {
    rendererRef.current?.setSpeed(speed);
  }, [speed]);

  return (
    <div
      ref={hostRef}
      data-paper-shader={paperShader}
      data-zen-glass-compositor={ownsGlass}
      className={className}
      style={{
        // Paper Shaders injects a global [data-paper-shader] rule that
        // makes its canvas z-index: -1. This custom renderer must own
        // its stacking contract instead of inheriting that DOM contract.
        position: "absolute",
        inset: 0,
        isolation: "isolate",
        overflow: "hidden",
        ...style,
      }}
      aria-hidden="true"
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        style={{
          contain: "strict",
          display: "block",
          position: "absolute",
          inset: 0,
          zIndex: 0,
          width: "100%",
          height: "100%",
        }}
      />
    </div>
  );
});
