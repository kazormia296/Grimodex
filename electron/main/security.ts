/**
 * セキュリティポリシー（設計書 §5.1）。
 *
 * - will-navigate は trusted renderer の同一 origin リロードだけ許可
 *   （production の app://bundle と dev URL — dragDropEnabled:false 相当の
 *   ファイルドロップ航行防止を兼ねる）
 * - setWindowOpenHandler は deny（http/https のみ scheme 検証後 shell.openExternal）
 * - permission は trusted renderer の notification / clipboard write のみ許可
 */
import { session, shell } from "electron";
import type { App } from "electron";

import { APP_BUNDLE_HOST, APP_PROTOCOL_SCHEME } from "./protocol.js";

const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);
const ALLOWED_RENDERER_PERMISSIONS = new Set([
  "notifications",
  "clipboard-sanitized-write",
]);

let assertExternalEgressAllowed: () => void = () => {
  throw new Error("D2A_EGRESS_DENIED: startup gate unavailable");
};

/** Main startup supplies the Native-backed D2a URL publication gate. */
export function setExternalEgressGate(
  assertion: (() => void) | null | undefined,
): void {
  assertExternalEgressAllowed =
    assertion ??
    (() => {
      throw new Error("D2A_EGRESS_DENIED: startup gate unavailable");
    });
}

/** dev サーバー URL と同一 origin か（リロード / HMR フルリロード用の例外）。 */
export function isAllowedNavigation(url: string): boolean {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  try {
    const parsed = new URL(url);
    if (!rendererUrl) {
      return (
        parsed.protocol === `${APP_PROTOCOL_SCHEME}:` &&
        parsed.host === APP_BUNDLE_HOST &&
        parsed.username === "" &&
        parsed.password === "" &&
        parsed.pathname === "/index.html"
      );
    }
    return parsed.origin === new URL(rendererUrl).origin;
  } catch {
    return false;
  }
}

/** Clipboard / notification を要求できる first-party renderer URL か。 */
export function isTrustedRendererUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol === `${APP_PROTOCOL_SCHEME}:` &&
      parsed.host === APP_BUNDLE_HOST
    ) {
      return true;
    }

    const rendererUrl = process.env.ELECTRON_RENDERER_URL;
    if (!rendererUrl) return false;
    const renderer = new URL(rendererUrl);
    return parsed.origin !== "null" && parsed.origin === renderer.origin;
  } catch {
    return false;
  }
}

/** request/check handler 共通の deny-by-default permission 判定。 */
export function isAllowedRendererPermission(options: {
  permission: string;
  requestingUrl: string;
  isMainFrame: boolean;
  topLevelUrl?: string | null;
}): boolean {
  if (!options.isMainFrame) return false;
  if (!ALLOWED_RENDERER_PERMISSIONS.has(options.permission)) return false;
  if (!isTrustedRendererUrl(options.requestingUrl)) return false;
  if (
    options.topLevelUrl != null &&
    !isTrustedRendererUrl(options.topLevelUrl)
  ) {
    return false;
  }
  return true;
}

function openExternalIfAllowed(url: string): void {
  try {
    assertExternalEgressAllowed?.();
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
    (webContents, permission, callback, details) => {
      const request = details as {
        requestingUrl?: unknown;
        isMainFrame?: unknown;
      };
      callback(
        isAllowedRendererPermission({
          permission,
          requestingUrl:
            typeof request.requestingUrl === "string"
              ? request.requestingUrl
              : "",
          isMainFrame: request.isMainFrame === true,
          topLevelUrl: webContents.getURL(),
        }),
      );
    },
  );
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) =>
      isAllowedRendererPermission({
        permission,
        requestingUrl: details.requestingUrl ?? requestingOrigin,
        isMainFrame: details.isMainFrame,
        topLevelUrl: webContents?.getURL(),
      }),
  );
}
