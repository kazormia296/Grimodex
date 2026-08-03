const OZONE_PLATFORM_SWITCH = "ozone-platform";
const WEBGPU_ADAPTER_SWITCH = "use-webgpu-adapter";
const WAYLAND_SESSION_TYPE = "wayland";
const OPENGL_ES_WEBGPU_ADAPTER = "opengles";

export interface LinuxGraphicsPolicyOptions {
  platform: NodeJS.Platform;
  ozonePlatform: string | undefined;
  xdgSessionType: string | undefined;
  hasWebGpuAdapterOverride: boolean;
}

export type LinuxGraphicsPolicy =
  | {
      webGpuAdapter: typeof OPENGL_ES_WEBGPU_ADAPTER;
    }
  | undefined;

function normalizeToken(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase();
}

/**
 * Resolve the narrow Linux startup override needed by native Wayland.
 *
 * Chromium cannot combine its Wayland surface factory with the Vulkan WebGPU
 * adapter. Keep native Wayland and hardware acceleration enabled, but select
 * OpenGL ES for WebGPU unless the user already chose an adapter explicitly.
 */
export function resolveLinuxGraphicsPolicy(
  options: LinuxGraphicsPolicyOptions,
): LinuxGraphicsPolicy {
  if (options.platform !== "linux" || options.hasWebGpuAdapterOverride) {
    return undefined;
  }

  const ozonePlatform = normalizeToken(options.ozonePlatform);
  const xdgSessionType = normalizeToken(options.xdgSessionType);
  const usesNativeWayland =
    ozonePlatform === WAYLAND_SESSION_TYPE ||
    ((ozonePlatform === undefined || ozonePlatform === "auto") &&
      xdgSessionType === WAYLAND_SESSION_TYPE);

  return usesNativeWayland
    ? { webGpuAdapter: OPENGL_ES_WEBGPU_ADAPTER }
    : undefined;
}

export interface ElectronCommandLineController {
  hasSwitch(name: string): boolean;
  getSwitchValue(name: string): string;
  appendSwitch(name: string, value?: string): void;
}

export interface LinuxGraphicsApp {
  commandLine: ElectronCommandLineController;
}

export interface ConfigureLinuxGraphicsOptions {
  platform?: NodeJS.Platform;
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Apply the policy before Electron becomes ready so Chromium receives the
 * adapter selection during GPU-process initialization.
 */
export function configureLinuxGraphics(
  app: LinuxGraphicsApp,
  options: ConfigureLinuxGraphicsOptions = {},
): void {
  const { commandLine } = app;
  const hasOzonePlatformOverride = commandLine.hasSwitch(OZONE_PLATFORM_SWITCH);
  const policy = resolveLinuxGraphicsPolicy({
    platform: options.platform ?? process.platform,
    ozonePlatform: hasOzonePlatformOverride
      ? commandLine.getSwitchValue(OZONE_PLATFORM_SWITCH)
      : undefined,
    xdgSessionType: (options.env ?? process.env).XDG_SESSION_TYPE,
    hasWebGpuAdapterOverride: commandLine.hasSwitch(WEBGPU_ADAPTER_SWITCH),
  });

  if (policy) {
    commandLine.appendSwitch(WEBGPU_ADAPTER_SWITCH, policy.webGpuAdapter);
  }
}
