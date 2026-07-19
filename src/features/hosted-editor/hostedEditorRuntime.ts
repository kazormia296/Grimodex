import type { HostedBrowserRuntime } from "@/lib/browserRuntime";

let activeHostedEditorRuntime: HostedBrowserRuntime | null = null;

/** Installs the browser runtime created before React mounts. */
export function installHostedEditorRuntime(
  runtime: HostedBrowserRuntime,
): void {
  activeHostedEditorRuntime = runtime;
}

/** Returns null in native shells and before browser bootstrap completes. */
export function getHostedEditorRuntime(): HostedBrowserRuntime | null {
  return activeHostedEditorRuntime;
}
