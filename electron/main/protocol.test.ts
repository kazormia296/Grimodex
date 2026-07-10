/**
 * app:// プロトコルの単体テスト（設計書 §8 S8。vitest node 環境 + electron モック）。
 *
 * - CSP が「tauri.conf.json の csp から `ipc: http://ipc.localhost` を除去した版」
 *   である導出関係を gate する（どちらかを変えたらもう片方も変える契約）
 * - resolveAppRequestPath の traversal 遮断 / host・scheme 検証
 * - createAppProtocolHandler の 200/404/405 + Content-Type + CSP ヘッダ
 * - PROD_INDEX_URL と windowChrome.buildPanelUrl（prod 分岐）の整合
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn(),
  },
}));

import {
  APP_CONTENT_SECURITY_POLICY,
  APP_BUNDLE_HOST,
  APP_PROTOCOL_SCHEME,
  contentTypeForPath,
  createAppProtocolHandler,
  PROD_INDEX_URL,
  resolveAppRequestPath,
} from "./protocol.js";
import { buildPanelUrl } from "./windowChrome.js";

const distRoot = mkdtempSync(path.join(os.tmpdir(), "grim-protocol-"));
writeFileSync(path.join(distRoot, "index.html"), "<!doctype html><p>ok</p>");
mkdirSync(path.join(distRoot, "assets"));
writeFileSync(path.join(distRoot, "assets", "app.js"), "console.log(1);");
writeFileSync(path.join(distRoot, "TERMS_ja.md"), "# terms");

afterAll(() => {
  rmSync(distRoot, { recursive: true, force: true });
});

describe("APP_CONTENT_SECURITY_POLICY（§8 S8: 現行 CSP からの導出）", () => {
  it("tauri.conf.json の csp から `ipc: http://ipc.localhost` を除去した版と一致する", () => {
    const conf = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("../../src-tauri/tauri.conf.json", import.meta.url),
        ),
        "utf8",
      ),
    ) as { app: { security: { csp: string } } };
    const derived = conf.app.security.csp.replace(
      " ipc: http://ipc.localhost",
      "",
    );
    expect(derived).not.toBe(conf.app.security.csp); // 除去対象が実在すること
    expect(APP_CONTENT_SECURITY_POLICY).toBe(derived);
  });

  it("Tauri IPC 専用の許可が残っていない", () => {
    expect(APP_CONTENT_SECURITY_POLICY).not.toContain("ipc:");
    expect(APP_CONTENT_SECURITY_POLICY).not.toContain("http://ipc.localhost");
  });
});

describe("PROD_INDEX_URL", () => {
  it("buildPanelUrl の prod 分岐と同一オリジン + 同一ドキュメント", () => {
    expect(PROD_INDEX_URL).toBe("app://bundle/index.html");
    expect(buildPanelUrl(undefined, "panel-chat")).toBe(
      `${PROD_INDEX_URL}?window=panel&panel=chat`,
    );
  });
});

describe("resolveAppRequestPath", () => {
  it("ルートと /index.html を index.html へ解決する", () => {
    expect(resolveAppRequestPath("app://bundle/", distRoot)).toBe(
      path.join(distRoot, "index.html"),
    );
    expect(resolveAppRequestPath("app://bundle/index.html", distRoot)).toBe(
      path.join(distRoot, "index.html"),
    );
  });

  it("query を無視して資産パスへ解決する（パネル窓 URL）", () => {
    expect(
      resolveAppRequestPath(
        "app://bundle/index.html?window=panel&panel=codex",
        distRoot,
      ),
    ).toBe(path.join(distRoot, "index.html"));
    expect(resolveAppRequestPath("app://bundle/assets/app.js", distRoot)).toBe(
      path.join(distRoot, "assets", "app.js"),
    );
  });

  it("app: 以外のスキーム / bundle 以外のホストは null", () => {
    expect(resolveAppRequestPath("file:///etc/passwd", distRoot)).toBeNull();
    expect(resolveAppRequestPath("app://other/index.html", distRoot)).toBeNull();
    expect(resolveAppRequestPath("not a url", distRoot)).toBeNull();
  });

  it("percent-encode された traversal が distRoot 外へ出られない", () => {
    // WHATWG URL パーサは %2e%2e もドットセグメントとして正規化し、pathname は
    // 常にルート起点になる（→ distRoot 内へクランプ）。仮に将来のパーサが
    // 正規化しなくなっても、decode 後のセグメント列挙検査（.. / \\ / NUL）が
    // null に落とす。どちらの経路でも distRoot 外は返らないことを gate する。
    const r = resolveAppRequestPath(
      "app://bundle/%2e%2e/%2e%2e/etc/passwd",
      distRoot,
    );
    expect(r === null || r.startsWith(distRoot + path.sep)).toBe(true);
    expect(r).not.toBe("/etc/passwd");
    expect(
      resolveAppRequestPath("app://bundle/a/%2e%2e%5cwin", distRoot),
    ).toBeNull();
    expect(
      resolveAppRequestPath("app://bundle/a%00.html", distRoot),
    ).toBeNull();
  });

  it("URL パーサが生の .. を正規化しても distRoot 内に留まる", () => {
    const resolved = resolveAppRequestPath(
      "app://bundle/assets/../index.html",
      distRoot,
    );
    // URL 正規化で /index.html になる（distRoot 外へは出ない）
    expect(resolved).toBe(path.join(distRoot, "index.html"));
  });
});

describe("contentTypeForPath", () => {
  it("代表拡張子を写像し、未知は octet-stream", () => {
    expect(contentTypeForPath("/x/index.html")).toContain("text/html");
    expect(contentTypeForPath("/x/a.js")).toContain("text/javascript");
    expect(contentTypeForPath("/x/a.css")).toContain("text/css");
    expect(contentTypeForPath("/x/a.wasm")).toBe("application/wasm");
    expect(contentTypeForPath("/x/a.woff2")).toBe("font/woff2");
    expect(contentTypeForPath("/x/a.WOFF2")).toBe("font/woff2");
    expect(contentTypeForPath("/x/a.unknownext")).toBe(
      "application/octet-stream",
    );
  });
});

describe("createAppProtocolHandler", () => {
  const handler = createAppProtocolHandler(distRoot);

  it("index.html: 200 + text/html + CSP ヘッダ", async () => {
    const res = await handler(new Request("app://bundle/index.html"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Content-Security-Policy")).toBe(
      APP_CONTENT_SECURITY_POLICY,
    );
    expect(await res.text()).toContain("ok");
  });

  it("資産: 200 + 対応 Content-Type、CSP は付けない", async () => {
    const res = await handler(new Request("app://bundle/assets/app.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/javascript");
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("public 由来の md も配信できる（リリースノート / 規約の fetch 先）", async () => {
    const res = await handler(new Request("app://bundle/TERMS_ja.md"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
  });

  it("存在しないファイル / ディレクトリ / traversal は 404", async () => {
    expect((await handler(new Request("app://bundle/nope.js"))).status).toBe(
      404,
    );
    expect((await handler(new Request("app://bundle/assets"))).status).toBe(
      404,
    );
    expect(
      (await handler(new Request("app://bundle/%2e%2e/secret"))).status,
    ).toBe(404);
  });

  it("GET 以外は 405", async () => {
    const res = await handler(
      new Request("app://bundle/index.html", { method: "POST" }),
    );
    expect(res.status).toBe(405);
  });
});

describe("スキーム定数", () => {
  it("app://bundle 固定（renderer 供給 URL を受けない前提の一部）", () => {
    expect(APP_PROTOCOL_SCHEME).toBe("app");
    expect(APP_BUNDLE_HOST).toBe("bundle");
  });
});
