import {
  resolveReleaseNotesPath,
  jaReleaseNotesPath,
} from "./resolveReleaseNotesPath";
import { EULA_VERSION } from "@/features/legal/constants";
import type { GlobalSettings } from "@/features/workspace/store";
import { isNewer } from "./semver";
import { useReleaseNotesStore } from "./releaseNotesStore";

export interface ReleaseNotesContent {
  src: string;
  isFallback: boolean;
}

async function fileExists(src: string): Promise<boolean> {
  try {
    const res = await fetch(`/${src}`);
    return res.ok;
  } catch {
    return false;
  }
}

/** 自動表示ゲート: ja ファイルが存在するか。 */
export async function hasJaReleaseNotes(version: string): Promise<boolean> {
  return fileExists(jaReleaseNotesPath(version));
}

/** primary → fallback の順で最初に存在するリリースノートを返す。 */
export async function fetchReleaseNotes(
  version: string,
  uiLanguage: string,
): Promise<ReleaseNotesContent | null> {
  const { primary, fallback } = resolveReleaseNotesPath(version, uiLanguage);
  if (await fileExists(primary)) {
    return { src: primary, isFallback: false };
  }
  if (fallback != null && (await fileExists(fallback))) {
    return { src: fallback, isFallback: true };
  }
  return null;
}



export interface ReleaseNotesGateOptions {
  globalSettings: GlobalSettings | null;
  updateGlobalSettings: (patch: Partial<GlobalSettings>) => Promise<boolean>;
  uiLanguage: string;
  isCancelled: () => boolean;
}

export async function evaluateReleaseNotesGate(opts: ReleaseNotesGateOptions): Promise<void> {
  const { globalSettings, updateGlobalSettings, uiLanguage, isCancelled } = opts;
  if (globalSettings == null) return;
  if (globalSettings.acceptedEulaVersion !== EULA_VERSION) return;
  if (isCancelled()) return;
  const verMod = await import("@tauri-apps/api/app");
  let current: string;
  try { current = await verMod.getVersion(); } catch { return; }
  const store = useReleaseNotesStore.getState();
  if (store.isOpen && store.mode === "auto" && store.version === current) return;
  const lastSeen = globalSettings.lastSeenReleaseNotesVersion;
  const persist = () => updateGlobalSettings({ lastSeenReleaseNotesVersion: current });
  if (lastSeen == null || lastSeen === "") { await persist(); return; }
  if (!isNewer(current, lastSeen)) return;
  if (!(await hasJaReleaseNotes(current))) { await persist(); return; }
  const content = await fetchReleaseNotes(current, uiLanguage);
  if (isCancelled()) return;
  if (content == null) { await persist(); return; }
  useReleaseNotesStore.getState().openAuto({ version: current, src: content.src, isFallback: content.isFallback });
}
