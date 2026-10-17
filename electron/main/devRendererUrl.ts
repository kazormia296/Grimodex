/**
 * dev server の URL（起動の env `ELECTRON_RENDERER_URL`）の唯一の読み口
 * （K3/2「renderer の隔離」(e)。DA-1）。
 *
 * この env は `electron/scripts/dev.mjs` が dev server のために設定する。env が
 * 設定されていると、window はその origin を preload 付き・CSP なしの trusted
 * renderer として読み込む。packaged build（`app.isPackaged`）では env を無視し、
 * 常に production の `app://bundle` を使う。window の読込（windows.ts）、
 * will-navigate の許可と trusted の判定（security.ts）、app protocol の登録
 * （index.ts）はすべてここを通す。非 packaged の dev server と journey の起動は
 * 変えない。
 */
import { app } from "electron";

export interface DevRendererUrlInput {
  isPackaged: boolean;
  env: Readonly<Record<string, string | undefined>>;
}

export function resolveDevRendererUrl(
  input: DevRendererUrlInput,
): string | undefined {
  if (input.isPackaged) return undefined;
  const value = input.env.ELECTRON_RENDERER_URL;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * packaged か。`app.isPackaged` が真偽値として読めないときは packaged として
 * 扱う（env を無視する側に倒す）。
 */
function isPackagedApp(): boolean {
  try {
    const value: unknown = app.isPackaged;
    return typeof value === "boolean" ? value : true;
  } catch {
    return true;
  }
}

/** この process の dev server の URL。packaged build では常に undefined。 */
export function getDevRendererUrl(): string | undefined {
  return resolveDevRendererUrl({
    isPackaged: isPackagedApp(),
    env: process.env,
  });
}
