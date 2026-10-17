/**
 * app:// プロトコルの単体テスト（設計書 §8 S8。vitest node 環境 + electron モック）。
 *
 * - Electron CSP のscheme / directive allowlistをgateする
 * - resolveAppRequestPath の traversal 遮断 / host・scheme 検証
 * - createAppProtocolHandler の 200/404/405 + Content-Type + CSP ヘッダ
 * - PROD_INDEX_URL と windowChrome.buildPanelUrl（prod 分岐）の整合
 */
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
// content type ごとの CSP（K3/2「renderer の隔離」(f)）を固定するための資産。
const ASSET_FIXTURES: Record<string, string> = {
  "assets/forceLayout.worker.js": "self.onmessage = () => {};",
  "assets/data.json": "{}",
  "assets/pixel.png": "png",
  "assets/module.wasm": "wasm",
  "assets/style.css": "a{}",
  "assets/icon.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
  "assets/notes.txt": "text",
  "assets/readme.md": "# md",
  "assets/app.js.map": "{}",
  "assets/data.unknownext": "bin",
  "assets/noext": "bin",
  "page.html": "<!doctype html><p>other page</p>",
};
for (const [relPath, content] of Object.entries(ASSET_FIXTURES)) {
  writeFileSync(path.join(distRoot, ...relPath.split("/")), content);
}

afterAll(() => {
  rmSync(distRoot, { recursive: true, force: true });
});

describe("APP_CONTENT_SECURITY_POLICY（Electron production正本）", () => {
  it("local assetだけを許可し、危険なobject/外部接続/Tauri IPCを拒否する", () => {
    expect(APP_CONTENT_SECURITY_POLICY).toContain("default-src 'self'");
    expect(APP_CONTENT_SECURITY_POLICY).toContain(
      "script-src 'self' 'wasm-unsafe-eval'",
    );
    expect(APP_CONTENT_SECURITY_POLICY).toContain("connect-src 'self'");
    expect(APP_CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(APP_CONTENT_SECURITY_POLICY).toContain("base-uri 'self'");
    expect(APP_CONTENT_SECURITY_POLICY).toContain("form-action 'self'");
    expect(APP_CONTENT_SECURITY_POLICY).not.toContain("'unsafe-eval'");
    expect(APP_CONTENT_SECURITY_POLICY).not.toMatch(/connect-src[^;]*https?:/);
    expect(APP_CONTENT_SECURITY_POLICY).not.toContain("ipc:");
    expect(APP_CONTENT_SECURITY_POLICY).not.toContain("http://ipc.localhost");
  });
});

/** CSP の directive の値（source の列）を返す。なければ null。 */
function cspDirective(csp: string, name: string): string[] | null {
  for (const part of csp.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens[0] === name) return tokens.slice(1);
  }
  return null;
}

/** worker の script に効く directive（worker-src → child-src → script-src → default-src）。 */
function effectiveWorkerSources(csp: string): string[] | null {
  for (const name of ["worker-src", "child-src", "script-src", "default-src"]) {
    const sources = cspDirective(csp, name);
    if (sources) return sources;
  }
  return null;
}

describe("CSP の script-src と worker（K3/2「renderer の隔離」(c)(f)）", () => {
  it("script-src は unsafe を含まず、外部 origin も許さない", () => {
    const scriptSrc = cspDirective(APP_CONTENT_SECURITY_POLICY, "script-src");
    expect(scriptSrc).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    for (const source of scriptSrc ?? []) {
      expect(source).not.toMatch(/unsafe-inline|(?<!wasm-)unsafe-eval/);
      expect(source).not.toMatch(/^(https?:|wss?:|\*|data:|blob:)/);
    }
  });

  it("worker-src は script-src の 'self' に落ち、blob:/data:/外部 origin を許さない", () => {
    const sources = effectiveWorkerSources(APP_CONTENT_SECURITY_POLICY);
    expect(sources).toContain("'self'");
    expect(sources).not.toContain("blob:");
    expect(sources).not.toContain("data:");
    expect(sources?.some((s) => /^https?:|^\*$/.test(s))).toBe(false);
  });

  it("同梱の force-layout worker: 同一 origin の同梱 script を読み、応答に CSP が付く", async () => {
    // WorkerForceLayoutEngine は `new Worker(new URL("./forceLayout.worker.ts",
    // import.meta.url), { type: "module" })` で同梱 script を読む（blob: や data: の
    // inline worker ではない）。vite はこれを `assets/*.js` の別 file にする。
    const engine = readFileSync(
      fileURLToPath(
        new URL(
          "../../src/features/map/layouts/forceEngine.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(engine).toContain(
      'new URL("./forceLayout.worker.ts", import.meta.url)',
    );
    expect(engine).not.toMatch(
      /new Worker\(\s*(URL\.createObjectURL|["']blob:|["']data:)/,
    );

    const handler = createAppProtocolHandler(distRoot);
    const res = await handler(
      new Request("app://bundle/assets/forceLayout.worker.js"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/javascript");
    // worker の CSP は script の応答で決まる。付いた CSP の下でも、同一 origin
    // （app://bundle）の script は worker-src（'self'）に合う。
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(effectiveWorkerSources(csp)).toContain("'self'");
    const workerUrl = new URL("app://bundle/assets/forceLayout.worker.js");
    expect(workerUrl.origin).toBe(new URL(PROD_INDEX_URL).origin);
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
    expect(
      resolveAppRequestPath("app://other/index.html", distRoot),
    ).toBeNull();
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

  it("資産: 200 + 対応 Content-Type + HTML と同じ CSP", async () => {
    const res = await handler(new Request("app://bundle/assets/app.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/javascript");
    expect(res.headers.get("Content-Security-Policy")).toBe(
      APP_CONTENT_SECURITY_POLICY,
    );
  });

  it.each([
    ["assets/forceLayout.worker.js", "text/javascript"],
    ["assets/app.js", "text/javascript"],
    ["assets/style.css", "text/css"],
    ["assets/data.json", "application/json"],
    ["assets/app.js.map", "application/json"],
    ["assets/pixel.png", "image/png"],
    ["assets/icon.svg", "image/svg+xml"],
    ["assets/module.wasm", "application/wasm"],
    ["assets/notes.txt", "text/plain"],
    ["assets/readme.md", "text/markdown"],
    ["TERMS_ja.md", "text/markdown"],
    ["assets/data.unknownext", "application/octet-stream"],
    ["assets/noext", "application/octet-stream"],
    ["page.html", "text/html"],
    ["index.html", "text/html"],
  ])(
    "content type ごとに全応答へ同じ CSP を付ける: %s",
    async (relPath, contentType) => {
      const res = await handler(new Request(`app://bundle/${relPath}`));
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain(contentType);
      expect(res.headers.get("Content-Security-Policy")).toBe(
        APP_CONTENT_SECURITY_POLICY,
      );
    },
  );

  it("fixture が配信対象の拡張子を網羅している（追加した content type は上の表に足す）", () => {
    const covered = new Set(
      Object.keys(ASSET_FIXTURES).map((p) => path.extname(p).toLowerCase()),
    );
    for (const ext of [".js", ".css", ".json", ".png", ".wasm", ".svg"]) {
      expect(covered.has(ext)).toBe(true);
    }
  });

  it.each([
    ["存在しない file", "app://bundle/nope.js"],
    ["directory", "app://bundle/assets"],
    ["percent-encode された traversal", "app://bundle/%2e%2e/secret"],
    ["バックスラッシュ", "app://bundle/a%5cb"],
    ["NUL", "app://bundle/a%00.html"],
    ["別の host", "app://other/index.html"],
    ["別の scheme", "file:///etc/passwd"],
  ])("404 の応答にも同じ CSP を付ける: %s", async (_label, url) => {
    const res = await handler(new Request(url));
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Security-Policy")).toBe(
      APP_CONTENT_SECURITY_POLICY,
    );
  });

  it.each(["POST", "PUT", "DELETE", "PATCH"])(
    "405 の応答（%s）にも同じ CSP を付ける",
    async (method) => {
      const res = await handler(
        new Request("app://bundle/index.html", { method }),
      );
      expect(res.status).toBe(405);
      expect(res.headers.get("Content-Security-Policy")).toBe(
        APP_CONTENT_SECURITY_POLICY,
      );
    },
  );

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
