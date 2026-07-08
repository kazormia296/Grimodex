export interface ReleaseNotesPaths {
  primary: string;
  fallback?: string;
}

function jaPath(version: string): string {
  return `RELEASE_NOTES/v${version}.ja.md`;
}

function enPath(version: string): string {
  return `RELEASE_NOTES/v${version}.en.md`;
}

/** UI 言語に応じた primary / fallback パスを返す（存在確認は呼び出し側）。 */
export function resolveReleaseNotesPath(
  version: string,
  uiLanguage: string,
): ReleaseNotesPaths {
  if (uiLanguage.startsWith("en")) {
    return { primary: enPath(version), fallback: jaPath(version) };
  }
  return { primary: jaPath(version) };
}

/** 自動表示ゲート用: ja ファイルのパス。 */
export function jaReleaseNotesPath(version: string): string {
  return jaPath(version);
}
