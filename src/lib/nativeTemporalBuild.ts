/**
 * renderer の build で `temporal-polyfill` を標準の Temporal の shim に置き換えるか
 * （vite.config.ts の alias の条件）。
 *
 * - 置き換えるのは Electron 向けの desktop の build だけ。Electron の Chromium は標準の Temporal を持つ。
 * - Web Editor は利用者の browser で動くので polyfill のまま。
 * - 凍結中の Tauri shell は同じ `dist/` を WebView で読むので polyfill のまま。Tauri の CLI は
 *   beforeBuildCommand に `TAURI_ENV_PLATFORM` を立てる。
 * - dev server は byte の対象外なので置き換えない。
 */
export function shouldAliasNativeTemporal(input: {
  command: "build" | "serve";
  mode: string;
  tauriPlatform: string | undefined;
}): boolean {
  return (
    input.command === "build" &&
    input.mode !== "web-editor" &&
    !input.tauriPlatform
  );
}
