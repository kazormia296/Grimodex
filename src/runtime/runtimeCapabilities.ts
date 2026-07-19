import type { RuntimeTarget } from "./runtimeTarget";

export interface RuntimeCapabilities {
  nativeFilesystem: boolean;
  documentPicker: boolean;
  genericProjectTransfer: boolean;
  shareSheet: boolean;
  secureSecretStore: boolean;
  localDatabase: boolean;
  localAi: boolean;
  /** Direct browser transport configured by the user (Local LLM / BYOK). */
  browserDirectAi: boolean;
  externalMount: boolean;
  mcpServer: boolean;
  multiWindow: boolean;
  customIme: boolean;
}

const ELECTRON_CAPABILITIES: RuntimeCapabilities = {
  nativeFilesystem: true,
  documentPicker: true,
  genericProjectTransfer: true,
  shareSheet: true,
  secureSecretStore: true,
  localDatabase: true,
  localAi: true,
  browserDirectAi: false,
  externalMount: true,
  mcpServer: true,
  multiWindow: true,
  customIme: true,
};

const WEB_CAPABILITIES: RuntimeCapabilities = {
  nativeFilesystem: false,
  documentPicker: true,
  genericProjectTransfer: false,
  shareSheet: true,
  secureSecretStore: false,
  localDatabase: true,
  localAi: false,
  browserDirectAi: true,
  externalMount: false,
  mcpServer: false,
  multiWindow: false,
  customIme: false,
};

const MOBILE_NATIVE_CAPABILITIES: RuntimeCapabilities = {
  nativeFilesystem: false,
  documentPicker: true,
  genericProjectTransfer: false,
  shareSheet: true,
  secureSecretStore: true,
  localDatabase: true,
  localAi: false,
  browserDirectAi: false,
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
