/**
 * セキュリティポリシー（設計書 §5.1）。
 *
 * - will-navigate 全拒否（dev URL の同一 origin リロードのみ許可 —
 *   dragDropEnabled:false 相当のファイルドロップ航行防止を兼ねる）
 * - setWindowOpenHandler は deny（http/https のみ scheme 検証後 shell.openExternal）
 * - permission request は notification のみ許可
 */
import { session, shell } from "electron";
import type { App } from "electron";

const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);

/** dev サーバー URL と同一 origin か（リロード / HMR フルリロード用の例外）。 */
export function isAllowedNavigation(url: string): boolean {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (!rendererUrl) return false;
  try {
    return new URL(url).origin === new URL(rendererUrl).origin;
  } catch {
    return false;
  }
}

function openExternalIfAllowed(url: string): void {
  try {
    if (ALLOWED_EXTERNAL_PROTOCOLS.has(new URL(url).protocol)) {
      void shell.openExternal(url);
    }
  } catch {
    // 不正な URL は黙って破棄する
  }
}

/** app ready 前に呼ぶ。全 webContents に航行ガードを敷く。 */
export function registerSecurityHandlers(app: App): void {
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-navigate", (event, url) => {
      if (isAllowedNavigation(url)) return;
      event.preventDefault();
    });
    contents.setWindowOpenHandler(({ url }) => {
      openExternalIfAllowed(url);
      return { action: "deny" };
    });
  });
}

/** app ready 後に呼ぶ（session アクセスは ready 後のみ）。 */
export function applySessionPermissionPolicy(): void {
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      callback(permission === "notifications");
    },
  );
}
