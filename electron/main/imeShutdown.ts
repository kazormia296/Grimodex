import type { NapiBackendLike } from "../shared/ipcContract.js";

/**
 * Renderer pagehide cannot be awaited. The native shutdown primitive is
 * deliberately synchronous so Electron cannot exit while state.json still
 * points at a project.
 */
export function deactivateImeAtShutdown(
  backend: Pick<NapiBackendLike, "imeExportDeactivateOnExit"> | null,
): void {
  if (!backend) return;
  try {
    backend.imeExportDeactivateOnExit();
  } catch (error) {
    console.warn("[ime] failed to deactivate during shutdown", error);
  }
}

interface ImeShutdownApp {
  on(event: "will-quit", listener: () => void): unknown;
}

/** Register after-renderer shutdown cleanup at Electron's final quit boundary. */
export function registerImeShutdown(
  app: ImeShutdownApp,
  getBackend: () => Pick<NapiBackendLike, "imeExportDeactivateOnExit"> | null,
): void {
  app.on("will-quit", () => deactivateImeAtShutdown(getBackend()));
}
