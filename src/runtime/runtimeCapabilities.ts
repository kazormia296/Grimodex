import type { RuntimeTarget } from "./runtimeTarget";

export interface RuntimeCapabilities {
  nativeFilesystem: boolean;
  documentPicker: boolean;
  shareSheet: boolean;
  secureSecretStore: boolean;
  localDatabase: boolean;
  localAi: boolean;
  hostedAi: boolean;
  externalMount: boolean;
  mcpServer: boolean;
  multiWindow: boolean;
  customIme: boolean;
}

const ELECTRON_CAPABILITIES: RuntimeCapabilities = {
  nativeFilesystem: true,
  documentPicker: true,
  shareSheet: true,
  secureSecretStore: true,
  localDatabase: true,
  localAi: true,
  hostedAi: true,
  externalMount: true,
  mcpServer: true,
  multiWindow: true,
  customIme: true,
};

const WEB_CAPABILITIES: RuntimeCapabilities = {
  nativeFilesystem: false,
  documentPicker: true,
  shareSheet: true,
  secureSecretStore: false,
  localDatabase: true,
  localAi: false,
  hostedAi: true,
  externalMount: false,
  mcpServer: false,
  multiWindow: false,
  customIme: false,
};

const MOBILE_NATIVE_CAPABILITIES: RuntimeCapabilities = {
  nativeFilesystem: false,
  documentPicker: true,
  shareSheet: true,
  secureSecretStore: true,
  localDatabase: true,
  localAi: false,
  hostedAi: true,
  externalMount: false,
  mcpServer: false,
  multiWindow: false,
  customIme: false,
};

const PRESETS: Record<RuntimeTarget, RuntimeCapabilities> = {
  electron: ELECTRON_CAPABILITIES,
  web: WEB_CAPABILITIES,
  "mobile-native": MOBILE_NATIVE_CAPABILITIES,
};

export function resolveRuntimeCapabilities(
  target: RuntimeTarget,
): RuntimeCapabilities {
  return { ...PRESETS[target] };
}

export function supportsRuntimeCapability(
  target: RuntimeTarget,
  capability: keyof RuntimeCapabilities,
): boolean {
  return PRESETS[target][capability];
}
