import {
  forwardRef,
  useEffect,
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
  ZEN_MULTIPASS_BLUR_FRAGMENT,
  ZEN_MULTIPASS_BLUR_SCALE,
  ZEN_MULTIPASS_FULLSCREEN_VERTEX,
} from "./zenMultipassPipeline";

const PAPER_VERTEX_SHADER = `#version 300 es
precision mediump float;
layout(location = 0) in vec4 a_position;
uniform vec2 u_resolution;
uniform float u_pixelRatio;
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
    box.x = boxRatio * min(u_resolution.x / boxRatio, u_resolution.y);
  } else if (u_fit == 2.0) {
    box.x = boxRatio * max(u_resolution.x / boxRatio, u_resolution.y);
  }
  box.y = box.x / boxRatio;
  return vec3(box, noFitBoxWidth);
}
void main() {
  gl_Position = a_position;
  vec2 uv = gl_Position.xy * 0.5;
  vec2 boxOrigin = vec2(0.5 - u_originX, u_originY - 0.5);
  vec2 givenBoxSize = vec2(u_worldWidth, u_worldHeight);
  givenBoxSize = max(givenBoxSize, vec2(1.0)) * u_pixelRatio;
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
    u_worldWidth == 0.0 ? u_resolution.x : givenBoxSize.x,
    u_worldHeight == 0.0 ? u_resolution.y : givenBoxSize.y
  );
  v_objectBoxSize = getBoxSize(fixedRatio, fixedRatioBoxGivenSize).xy;
  vec2 objectWorldScale = u_resolution.xy / v_objectBoxSize;
  v_objectUV = uv;
  v_objectUV *= objectWorldScale;
  v_objectUV += boxOrigin * (objectWorldScale - 1.0);
  v_objectUV += graphicOffset;
  v_objectUV /= u_scale;
  v_objectUV = graphicRotation * v_objectUV;

  v_responsiveBoxGivenSize = vec2(
    u_worldWidth == 0.0 ? u_resolution.x : givenBoxSize.x,
    u_worldHeight == 0.0 ? u_resolution.y : givenBoxSize.y
  );
  float responsiveRatio =
    v_responsiveBoxGivenSize.x / v_responsiveBoxGivenSize.y;
  vec2 responsiveBoxSize =
    getBoxSize(responsiveRatio, v_responsiveBoxGivenSize).xy;
  vec2 responsiveBoxScale = u_resolution.xy / responsiveBoxSize;
  v_responsiveUV = uv;
  v_responsiveUV *= responsiveBoxScale;
  v_responsiveUV += boxOrigin * (responsiveBoxScale - 1.0);
  v_responsiveUV += graphicOffset;
  v_responsiveUV /= u_scale;
  v_responsiveUV.x *= responsiveRatio;
  v_responsiveUV = graphicRotation * v_responsiveUV;
  v_responsiveUV.x /= responsiveRatio;

  vec2 patternBoxGivenSize = vec2(
    u_worldWidth == 0.0 ? u_resolution.x : givenBoxSize.x,
    u_worldHeight == 0.0 ? u_resolution.y : givenBoxSize.y
  );
  float patternBoxRatio = patternBoxGivenSize.x / patternBoxGivenSize.y;
  vec3 boxSizeData = getBoxSize(patternBoxRatio, patternBoxGivenSize);
  v_patternBoxSize = boxSizeData.xy;
  float patternBoxNoFitBoxWidth = boxSizeData.z;
  vec2 patternBoxScale = u_resolution.xy / v_patternBoxSize;
  v_patternUV = uv;
  v_patternUV += graphicOffset / patternBoxScale;
  v_patternUV += boxOrigin;
  v_patternUV -= boxOrigin / patternBoxScale;
  v_patternUV *= u_resolution.xy;
  v_patternUV /= u_pixelRatio;
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
      min(u_resolution.x / u_imageAspectRatio, u_resolution.y) *
      u_imageAspectRatio;
  } else if (u_fit == 2.0) {
    imageBoxSize.x =
      max(u_resolution.x / u_imageAspectRatio, u_resolution.y) *
      u_imageAspectRatio;
  } else {
    imageBoxSize.x = min(10.0, 10.0 / u_imageAspectRatio * u_imageAspectRatio);
  }
  imageBoxSize.y = imageBoxSize.x / u_imageAspectRatio;
  vec2 imageBoxScale = u_resolution.xy / imageBoxSize;
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
}

interface ProgramBundle {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
}

export interface ZenMultipassCanvasProps {
  sceneFragment: string;
  sceneUniforms: ShaderMountUniforms;
  compositeFragment: string;
  compositeUniforms: ShaderMountUniforms;
  mipmaps?: readonly string[];
  minPixelRatio: number;
  maxPixelCount: number;
  webGlContextAttributes?: WebGLContextAttributes;
  speed?: number;
  className?: string;
  style?: CSSProperties;
  "data-paper-shader": string;
  "data-zen-glass-compositor"?: string;
}

function isImage(value: unknown): value is HTMLImageElement {
  return (
    typeof HTMLImageElement !== "undefined" &&
    value instanceof HTMLImageElement
  );
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to allocate WebGL shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "Unknown shader compile error";
    gl.deleteShader(shader);
    throw new Error(log);
  }
  return shader;
}

function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new Error("Unable to allocate WebGL program");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "Unknown shader link error";
    gl.deleteProgram(program);
    throw new Error(log);
  }
  return program;
}

function createProgramBundle(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): ProgramBundle {
  const program = createProgram(gl, vertexSource, fragmentSource);
  const vao = gl.createVertexArray();
  const buffer = gl.createBuffer();
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
}

class ZenMultipassRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly sceneProgram: ProgramBundle;
  private readonly blurProgram: ProgramBundle;
  private readonly compositeProgram: ProgramBundle;
  private readonly sceneTarget: RenderTarget;
  private readonly blurHorizontalTarget: RenderTarget;
  private readonly blurVerticalTarget: RenderTarget;
  private readonly imageTextures = new Map<
    string,
    { image: HTMLImageElement; texture: WebGLTexture; unit: number }
  >();
  private readonly resizeObserver: ResizeObserver | null;
  private sceneUniforms: ShaderMountUniforms;
  private compositeUniforms: ShaderMountUniforms;
  private mipmaps: readonly string[];
  private frame = 0;
  private renderScale = 1;
  private drawCount = 0;
  private rafId: number | null = null;
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
  ) {
    const gl = canvas.getContext("webgl2", contextAttributes);
    if (!gl) throw new Error("WebGL2 is unavailable for Zen multipass rendering");
    this.gl = gl;
    this.sceneUniforms = sceneUniforms;
    this.compositeUniforms = compositeUniforms;
    this.mipmaps = mipmaps;
    this.sceneProgram = createProgramBundle(
      gl,
      PAPER_VERTEX_SHADER,
      sceneFragment,
    );
    this.blurProgram = createProgramBundle(
      gl,
      ZEN_MULTIPASS_FULLSCREEN_VERTEX,
      ZEN_MULTIPASS_BLUR_FRAGMENT,
    );
    this.compositeProgram = createProgramBundle(
      gl,
      ZEN_MULTIPASS_FULLSCREEN_VERTEX,
      compositeFragment,
    );
    this.sceneTarget = this.createTarget();
    this.blurHorizontalTarget = this.createTarget();
    this.blurVerticalTarget = this.createTarget();
    gl.disable(gl.BLEND);

    this.resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => this.resize());
    this.resizeObserver?.observe(host);
    host.ownerDocument.defaultView?.addEventListener("resize", this.resize);
    this.resize();
  }

  private readonly requestFrame = (callback: FrameRequestCallback) => {
    const view = this.host.ownerDocument.defaultView;
    return view?.requestAnimationFrame(callback) ?? requestAnimationFrame(callback);
  };

  private readonly cancelFrame = (handle: number) => {
    const view = this.host.ownerDocument.defaultView;
    if (view) view.cancelAnimationFrame(handle);
    else cancelAnimationFrame(handle);
  };

  private createTarget(): RenderTarget {
    const framebuffer = this.gl.createFramebuffer();
    const texture = this.gl.createTexture();
    if (!framebuffer || !texture) {
      throw new Error("Unable to allocate Zen multipass render target");
    }
    return { framebuffer, texture, width: 0, height: 0 };
  }

  private allocateTarget(target: RenderTarget, width: number, height: number) {
    if (target.width === width && target.height === height) return;
    const gl = this.gl;
    target.width = width;
    target.height = height;
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
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
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error("Zen multipass framebuffer is incomplete");
    }
  }

  private readonly resize = () => {
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
    this.renderScale = width / rect.width;
    if (this.canvas.width === width && this.canvas.height === height) {
      this.requestDraw();
      return;
    }
    this.canvas.width = width;
    this.canvas.height = height;
    this.allocateTarget(this.sceneTarget, width, height);
    const blurWidth = Math.max(
      1,
      Math.ceil(width * ZEN_MULTIPASS_BLUR_SCALE),
    );
    const blurHeight = Math.max(
      1,
      Math.ceil(height * ZEN_MULTIPASS_BLUR_SCALE),
    );
    this.allocateTarget(this.blurHorizontalTarget, blurWidth, blurHeight);
    this.allocateTarget(this.blurVerticalTarget, blurWidth, blurHeight);
    this.requestDraw();
  };

  private requestDraw() {
    if (this.disposed || this.rafId !== null) return;
    this.rafId = this.requestFrame(() => {
      this.rafId = null;
      this.draw();
    });
  }

  private setImageUniform(
    program: WebGLProgram,
    name: string,
    image: HTMLImageElement,
  ) {
    const gl = this.gl;
    let stored = this.imageTextures.get(name);
    if (!stored || stored.image !== image) {
      if (stored) gl.deleteTexture(stored.texture);
      const texture = gl.createTexture();
      if (!texture) return;
      stored = {
        image,
        texture,
        unit: stored?.unit ?? this.imageTextures.size,
      };
      this.imageTextures.set(name, stored);
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
    const location = gl.getUniformLocation(program, name);
    if (location !== null) gl.uniform1i(location, stored.unit);
    const aspectLocation = gl.getUniformLocation(program, `${name}AspectRatio`);
    if (aspectLocation !== null) {
      gl.uniform1f(aspectLocation, image.naturalWidth / image.naturalHeight);
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
    const location = gl.getUniformLocation(program, name);
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

  private applyUniforms(
    program: WebGLProgram,
    uniforms: ShaderMountUniforms,
  ) {
    for (const [name, value] of Object.entries(uniforms)) {
      this.setUniform(program, name, value);
    }
  }

  private useBundle(bundle: ProgramBundle) {
    this.gl.useProgram(bundle.program);
    this.gl.bindVertexArray(bundle.vao);
  }

  private drawScene() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneTarget.framebuffer);
    gl.viewport(0, 0, this.sceneTarget.width, this.sceneTarget.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.useBundle(this.sceneProgram);
    const resolution = gl.getUniformLocation(
      this.sceneProgram.program,
      "u_resolution",
    );
    if (resolution !== null) {
      gl.uniform2f(resolution, this.sceneTarget.width, this.sceneTarget.height);
    }
    const pixelRatio = gl.getUniformLocation(
      this.sceneProgram.program,
      "u_pixelRatio",
    );
    if (pixelRatio !== null) gl.uniform1f(pixelRatio, this.renderScale);
    const time = gl.getUniformLocation(this.sceneProgram.program, "u_time");
    if (time !== null) gl.uniform1f(time, this.frame * 0.001);
    this.applyUniforms(this.sceneProgram.program, this.sceneUniforms);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private drawBlurPass(
    source: WebGLTexture,
    target: RenderTarget,
    directionX: number,
    directionY: number,
  ) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    this.useBundle(this.blurProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source);
    gl.uniform1i(
      gl.getUniformLocation(this.blurProgram.program, "u_sourceTexture"),
      0,
    );
    gl.uniform2f(
      gl.getUniformLocation(this.blurProgram.program, "u_blurDirection"),
      directionX,
      directionY,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private drawComposite(blurredTexture: WebGLTexture) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.useBundle(this.compositeProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTarget.texture);
    gl.uniform1i(
      gl.getUniformLocation(this.compositeProgram.program, "u_sceneTexture"),
      0,
    );
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, blurredTexture);
    gl.uniform1i(
      gl.getUniformLocation(
        this.compositeProgram.program,
        "u_blurredTexture",
      ),
      1,
    );
    gl.uniform2f(
      gl.getUniformLocation(this.compositeProgram.program, "u_resolution"),
      this.canvas.width,
      this.canvas.height,
    );
    gl.uniform1f(
      gl.getUniformLocation(this.compositeProgram.program, "u_pixelRatio"),
      this.renderScale,
    );
    this.applyUniforms(this.compositeProgram.program, this.compositeUniforms);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
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
    this.drawScene();
    const blurRadius = Number(this.compositeUniforms.u_zenGlassBlur ?? 0);
    let blurredTexture = this.sceneTarget.texture;
    if (blurRadius > 0.00001) {
      const blurStep = Math.max(0.5, (blurRadius * this.renderScale) / 4);
      this.drawBlurPass(
        this.sceneTarget.texture,
        this.blurHorizontalTarget,
        blurStep / this.sceneTarget.width,
        0,
      );
      this.drawBlurPass(
        this.blurHorizontalTarget.texture,
        this.blurVerticalTarget,
        0,
        blurStep / this.sceneTarget.height,
      );
      blurredTexture = this.blurVerticalTarget.texture;
    }
    this.drawComposite(blurredTexture);
    this.drawCount += 1;
  }

  setFrame = (frame: number) => {
    this.frame = Number.isFinite(frame) ? frame : 0;
    this.requestDraw();
  };

  setUniforms(
    sceneUniforms: ShaderMountUniforms,
    compositeUniforms: ShaderMountUniforms,
    mipmaps: readonly string[],
  ) {
    this.sceneUniforms = sceneUniforms;
    this.compositeUniforms = compositeUniforms;
    this.mipmaps = mipmaps;
    this.requestDraw();
  }

  getPerformanceStats = () => ({
    drawCount: this.drawCount,
    gpuTimeMs: null,
    isStaticFrameReady:
      this.drawCount > 0 &&
      this.canvas.width > 0 &&
      this.canvas.height > 0 &&
      this.rafId === null,
  });

  resetPerformanceStats = () => {
    this.drawCount = 0;
  };

  dispose() {
    this.disposed = true;
    if (this.rafId !== null) this.cancelFrame(this.rafId);
    this.resizeObserver?.disconnect();
    this.host.ownerDocument.defaultView?.removeEventListener(
      "resize",
      this.resize,
    );
    const gl = this.gl;
    for (const stored of this.imageTextures.values()) {
      gl.deleteTexture(stored.texture);
    }
    for (const target of [
      this.sceneTarget,
      this.blurHorizontalTarget,
      this.blurVerticalTarget,
    ]) {
      gl.deleteFramebuffer(target.framebuffer);
      gl.deleteTexture(target.texture);
    }
    for (const bundle of [
      this.sceneProgram,
      this.blurProgram,
      this.compositeProgram,
    ]) {
      gl.deleteBuffer(bundle.buffer);
      gl.deleteVertexArray(bundle.vao);
      gl.deleteProgram(bundle.program);
    }
  }
}

export const ZenMultipassCanvas = forwardRef<
  PaperShaderElement,
  ZenMultipassCanvasProps
>(function ZenMultipassCanvas(
  {
    sceneFragment,
    sceneUniforms,
    compositeFragment,
    compositeUniforms,
    mipmaps = [],
    minPixelRatio,
    maxPixelCount,
    webGlContextAttributes,
    speed: _speed,
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

  useImperativeHandle(
    forwardedRef,
    () => hostRef.current as unknown as PaperShaderElement,
    [],
  );

  useLayoutEffect(() => {
    const host = hostRef.current as unknown as PaperShaderElement | null;
    const canvas = canvasRef.current;
    if (!host || !canvas) return undefined;
    try {
      const renderer = new ZenMultipassRenderer(
        host,
        canvas,
        sceneFragment,
        sceneUniforms,
        compositeFragment,
        compositeUniforms,
        mipmaps,
        minPixelRatio,
        maxPixelCount,
        webGlContextAttributes,
      );
      rendererRef.current = renderer;
      host.paperShaderMount = {
        setFrame: renderer.setFrame,
        getPerformanceStats: renderer.getPerformanceStats,
        resetPerformanceStats: renderer.resetPerformanceStats,
      } as unknown as ShaderMount;
      return () => {
        renderer.dispose();
        rendererRef.current = null;
        delete host.paperShaderMount;
      };
    } catch (error) {
      console.error("[zen-shader] multipass renderer failed", error);
      host.dispatchEvent(
        new Event("webglcontextlost", { bubbles: true, cancelable: true }),
      );
      return undefined;
    }
  }, [
    compositeFragment,
    maxPixelCount,
    minPixelRatio,
    sceneFragment,
    webGlContextAttributes,
  ]);

  useEffect(() => {
    rendererRef.current?.setUniforms(
      sceneUniforms,
      compositeUniforms,
      mipmaps,
    );
  }, [compositeUniforms, mipmaps, sceneUniforms]);

  return (
    <div
      ref={hostRef}
      data-paper-shader={paperShader}
      data-zen-glass-compositor={ownsGlass}
      className={className}
      style={style}
      aria-hidden="true"
    >
      <canvas className="absolute inset-0 h-full w-full" />
    </div>
  );
});
