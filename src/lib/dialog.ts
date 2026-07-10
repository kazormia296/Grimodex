import i18next from "@/lib/i18n";
import { electronBridge, isElectron } from "@/lib/shell";
import { isTauri } from "@/lib/tauri";

export async function openFolderDialog(): Promise<string | null> {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const result = await open({ directory: true, multiple: false });
    return typeof result === "string" ? result : null;
  }
  if (isElectron()) {
    // main プロセスのネイティブフォルダピッカ（キャンセルは null）。
    return electronBridge().dialog.openFolder();
  }
  // Browser fallback: prompt for a path string
  const path = window.prompt(i18next.t("dialog.workspacePathPrompt"));
  return path || null;
}
