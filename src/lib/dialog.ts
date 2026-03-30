const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function openFolderDialog(): Promise<string | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const result = await open({ directory: true, multiple: false });
    return typeof result === "string" ? result : null;
  }
  // Browser fallback: prompt for a path string
  const path = window.prompt("ワークスペースのパスを入力してください:");
  return path || null;
}
