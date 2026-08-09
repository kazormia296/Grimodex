interface WebGlDebugRendererInfo {
  readonly UNMASKED_VENDOR_WEBGL: number;
  readonly UNMASKED_RENDERER_WEBGL: number;
}

export interface ZenWebGlRuntimeIdentity {
  readonly userAgent?: unknown;
  readonly platform?: unknown;
}

export interface ZenWebGlMetadata {
  vendor: string | null;
  renderer: string | null;
  unmaskedVendor: string | null;
  unmaskedRenderer: string | null;
  version: string | null;
  shadingLanguageVersion: string | null;
  maxTextureSize: number | null;
  maxTextureImageUnits: number | null;
  userAgent: string | null;
  platform: string | null;
}

function readParameter(gl: WebGL2RenderingContext, parameter: number): unknown {
  try {
    return gl.getParameter(parameter);
  } catch {
    return null;
  }
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function runtimeString(
  runtime: ZenWebGlRuntimeIdentity | null | undefined,
  key: "userAgent" | "platform",
) {
  if (!runtime) return null;
  try {
    return stringValue(runtime[key]);
  } catch {
    return null;
  }
}

function debugRendererInfo(gl: WebGL2RenderingContext) {
  try {
    const extension = gl.getExtension(
      "WEBGL_debug_renderer_info",
    ) as WebGlDebugRendererInfo | null;
    if (
      !extension ||
      typeof extension.UNMASKED_VENDOR_WEBGL !== "number" ||
      typeof extension.UNMASKED_RENDERER_WEBGL !== "number"
    ) {
      return null;
    }
    return extension;
  } catch {
    return null;
  }
}

export function collectZenWebGlMetadata(
  gl: WebGL2RenderingContext,
  runtime?: ZenWebGlRuntimeIdentity | null,
): ZenWebGlMetadata {
  const debugInfo = debugRendererInfo(gl);
  return {
    vendor: stringValue(readParameter(gl, gl.VENDOR)),
    renderer: stringValue(readParameter(gl, gl.RENDERER)),
    unmaskedVendor: debugInfo
      ? stringValue(readParameter(gl, debugInfo.UNMASKED_VENDOR_WEBGL))
      : null,
    unmaskedRenderer: debugInfo
      ? stringValue(readParameter(gl, debugInfo.UNMASKED_RENDERER_WEBGL))
      : null,
    version: stringValue(readParameter(gl, gl.VERSION)),
    shadingLanguageVersion: stringValue(
      readParameter(gl, gl.SHADING_LANGUAGE_VERSION),
    ),
    maxTextureSize: finiteNumber(readParameter(gl, gl.MAX_TEXTURE_SIZE)),
    maxTextureImageUnits: finiteNumber(
      readParameter(gl, gl.MAX_TEXTURE_IMAGE_UNITS),
    ),
    userAgent: runtimeString(runtime, "userAgent"),
    platform: runtimeString(runtime, "platform"),
  };
}
