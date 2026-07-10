/**
 * 本番ロード用 `app://` プロトコル（設計書 §2 / §8 S8）。
 *
 * - `app://bundle/<path>` を `dist/`（vite build 成果物）から配信する。
 *   URL は main しか組み立てない（windows.ts / windowChrome.buildPanelUrl）。
 * - Content-Security-Policy は **現行 tauri.conf.json の csp から
 *   `ipc: http://ipc.localhost` を除去した版**を HTML ドキュメントに付ける
 *   （protocol.test.ts が tauri.conf.json との導出関係を gate する）。
 * - 純関数部（resolveAppRequestPath / contentTypeForPath /
 *   createAppProtocolHandler）は electron 実行時 API に依存せず、
 *   vitest node 環境（vitest.electron.config.ts）で単体テストする。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { protocol } from "electron";

export const APP_PROTOCOL_SCHEME = "app";
export const APP_BUNDLE_HOST = "bundle";

/** メイン窓の本番ロード URL（パネル窓は windowChrome.buildPanelUrl が組む）。 */
export const PROD_INDEX_URL = `${APP_PROTOCOL_SCHEME}://${APP_BUNDLE_HOST}/index.html`;

/**
 * tauri.conf.json の csp から connect-src の `ipc: http://ipc.localhost`
 * （Tauri IPC 専用の許可）を除去した版（§8 S8）。それ以外のディレクティブは
 * Tauri ビルドと完全同一に保つ — 乖離すると「Tauri では動くのに Electron で
 * 動かない」資産ロード差が生まれるため、protocol.test.ts で導出関係を検査する。
 */
export const APP_CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "font-src 'self' data:; connect-src 'self'; object-src 'none'; " +
  "base-uri 'self'; form-action 'self'";

/** 拡張子 → Content-Type（dist/ に現れる資産 + 予備）。 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".pdf": "application/pdf",
};

export function contentTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * `app://bundle/...` リクエスト URL を distRoot 配下の絶対ファイルパスへ解決する。
 * 解決できない / 許可しない場合は null（呼び出し側で 404）:
 * - app: 以外のスキーム / bundle 以外のホスト
 * - percent-decode 後に `..` `.` セグメント・バックスラッシュ・NUL を含む
 *   （URL パーサは生の `..` を正規化するが、`%2e%2e` はデコードまで残るため
 *   セグメント単位の列挙検査で distRoot 外への traversal を遮断する）
 *
 * ルート（`/` またはセグメントなし）は index.html に解決する。
 * SPA だがクライアントルーティングは query のみ（?window=panel&…）のため、
 * それ以外のパスへの HTML フォールバックは持たない。
 */
export function resolveAppRequestPath(
  requestUrl: string,
  distRoot: string,
): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_PROTOCOL_SCHEME}:`) return null;
  if (url.hostname !== APP_BUNDLE_HOST) return null;

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }

  const segments = pathname.split("/").filter((s) => s.length > 0);
  if (
    segments.some(
      (s) => s === ".." || s === "." || s.includes("\\") || s.includes("\0"),
    )
  ) {
    return null;
  }
  const root = path.resolve(distRoot);
  if (segments.length === 0) return path.join(root, "index.html");
  return path.join(root, ...segments);
}

/**
 * `protocol.handle` に渡すハンドラ（fetch 互換の Request → Response）。
 * electron に依存しないので単体テストはこれを直接呼ぶ。
 * - GET 以外は 405
 * - 解決不能 / 読めない（存在しない・ディレクトリ）は 404
 * - HTML には Content-Security-Policy を付ける（ドキュメント単位で効く層）
 */
export function createAppProtocolHandler(
  distRoot: string,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== "GET") {
      return new Response("method not allowed", { status: 405 });
    }
    const filePath = resolveAppRequestPath(request.url, distRoot);
    if (!filePath) {
      return new Response("not found", { status: 404 });
    }
    let body: Uint8Array;
    try {
      body = await readFile(filePath);
    } catch {
      return new Response("not found", { status: 404 });
    }
    const contentType = contentTypeForPath(filePath);
    const headers: Record<string, string> = { "Content-Type": contentType };
    if (contentType.startsWith("text/html")) {
      headers["Content-Security-Policy"] = APP_CONTENT_SECURITY_POLICY;
    }
    return new Response(body, { status: 200, headers });
  };
}

/**
 * `app://` を standard/secure スキームとして登録する。
 * **app ready 前に 1 回だけ**呼ぶこと（Electron の制約）。standard 指定で
 * 相対パス資産（/assets/…）の URL 解決と localStorage 等のオリジン扱いが
 * http(s) 同等になる。
 */
export function registerAppProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_PROTOCOL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
  ]);
}

/** app ready 後に呼ぶ。dist/（vite build 成果物）を app://bundle/ で配信する。 */
export function registerAppProtocolHandler(distRoot: string): void {
  protocol.handle(APP_PROTOCOL_SCHEME, createAppProtocolHandler(distRoot));
}
