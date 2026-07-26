import {
  resolveReleaseNotesPath,
  jaReleaseNotesPath,
} from "./resolveReleaseNotesPath";

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
