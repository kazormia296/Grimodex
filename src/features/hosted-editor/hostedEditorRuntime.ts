import type { WebEditorBrowserRuntime } from "@/lib/browserRuntime";

let activeHostedEditorRuntime: WebEditorBrowserRuntime | null = null;

/** Installs the browser runtime created before React mounts. */
export function installHostedEditorRuntime(
  runtime: WebEditorBrowserRuntime,
): void {
  activeHostedEditorRuntime = runtime;
}

/** Returns null in native shells and before browser bootstrap completes. */
export function getHostedEditorRuntime(): WebEditorBrowserRuntime | null {
  return activeHostedEditorRuntime;
}
