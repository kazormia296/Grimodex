import i18next from "@/lib/i18n";

/** Check at call time, not module-load time, to avoid race with Tauri bridge injection. */
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function openFolderDialog(): Promise<string | null> {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const result = await open({ directory: true, multiple: false });
    return typeof result === "string" ? result : null;
  }
  // Browser fallback: prompt for a path string
  const path = window.prompt(i18next.t("dialog.workspacePathPrompt"));
  return path || null;
}
