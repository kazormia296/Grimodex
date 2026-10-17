/**
 * renderer の隔離の静的な検査（K3/2「renderer の隔離とその固定」2。DA-1）。
 *
 * restricted でも renderer が読める平文を外へ直接は送れない、という根拠（O-2）を支える
 * 設定が、将来の変更で黙って外れないよう、`electron/main` の source を読んで固定する。
 * (a) すべての BrowserWindow が buildWebPreferences() を使う。
 * (b) buildWebPreferences() に禁止の option を加えず、既存の 4 つだけを持つ。
 * (c) CSP の script-src が unsafe と外部 origin を含まない。
 * (d) webRequest、proxy、host resolver、WebRTC、spellchecker の設定 API を呼ばない
 *     （Y-1 の対処として記録したものだけを下の許可表に置く。今は空）。
 * (e) packaged で ELECTRON_RENDERER_URL を見ない（devRendererUrl.ts だけが読む）。
 * 実装の挙動は windows.test.ts、protocol.test.ts、security.test.ts、devRendererUrl.test.ts が固定する。
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
}));

const { APP_CONTENT_SECURITY_POLICY } = await import("./protocol.js");

const MAIN_DIR = path.dirname(fileURLToPath(import.meta.url));

function mainSources(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        /\.(ts|tsx|mts|cts)$/.test(entry.name) &&
        !/\.test\./.test(entry.name)
      )
        out.push({
          file: path.relative(MAIN_DIR, full).split(path.sep).join("/"),
          text: readFileSync(full, "utf8"),
        });
    }
  };
  walk(MAIN_DIR);
  return out;
}

/** コメントを除く（コメントに API 名が出ても検査に掛けない）。 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/**
 * Y-1 の対処として記録した設定。file ごとに許可する API 名の一覧。
 * 今は対処を加えていないので空（DR-DA1-7）。加えるときは対処として記録し、
 * その設定を固定する試験も足す。
 */
const RECORDED_Y1_COUNTERMEASURES: Readonly<Record<string, readonly string[]>> =
  {};

describe("(a)(b) BrowserWindow と webPreferences", () => {
  const sources = mainSources();
  const windowsTs = sources.find((s) => s.file === "windows.ts")!;

  it("BrowserWindow を作るのは windows.ts だけで、すべて buildWebPreferences() を使う", () => {
    const creators = sources.filter((s) =>
      /new\s+BrowserWindow\s*\(/.test(stripComments(s.text)),
    );
    expect(creators.map((s) => s.file)).toEqual(["windows.ts"]);

    const text = stripComments(windowsTs.text);
    const constructions = [...text.matchAll(/new\s+BrowserWindow\s*\(\s*\{/g)];
    expect(constructions.length).toBeGreaterThan(0);
    for (const match of constructions) {
      const rest = text.slice(match.index!, match.index! + 300);
      expect(rest).toMatch(/webPreferences:\s*buildWebPreferences\(\)/);
    }
  });

  it("webview、BrowserView、WebContentsView を作らない", () => {
    for (const { file, text } of sources) {
      const code = stripComments(text);
      expect(code, file).not.toMatch(/new\s+(BrowserView|WebContentsView)\b/);
      expect(code, file).not.toMatch(/<webview\b/);
    }
  });

  it("buildWebPreferences() は preload、contextIsolation、sandbox、nodeIntegration だけを持つ", () => {
    const text = stripComments(windowsTs.text);
    const body = text.match(
      /function buildWebPreferences\(\)[^{]*\{\s*return\s*\{([\s\S]*?)\};\s*\}/,
    )?.[1];
    expect(body).toBeDefined();
    const keys = [...body!.matchAll(/^\s*(\w+)\s*:/gm)].map((m) => m[1]);
    expect(keys.sort()).toEqual(
      ["contextIsolation", "nodeIntegration", "preload", "sandbox"].sort(),
    );
    expect(body).toMatch(/contextIsolation:\s*true/);
    expect(body).toMatch(/sandbox:\s*true/);
    expect(body).toMatch(/nodeIntegration:\s*false/);
    for (const forbidden of [
      "webviewTag",
      "webSecurity",
      "allowRunningInsecureContent",
      "nodeIntegrationInWorker",
      "nodeIntegrationInSubFrames",
      "experimentalFeatures",
      "enableBlinkFeatures",
      "nativeWindowOpen",
      "spellcheck",
      "offscreen",
      "partition",
    ]) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });
});

describe("(c) CSP", () => {
  it("script-src は unsafe-inline・unsafe-eval・外部 origin を含まない", () => {
    const scriptSrc = APP_CONTENT_SECURITY_POLICY.split(";")
      .map((part) => part.trim().split(/\s+/))
      .find((tokens) => tokens[0] === "script-src");
    expect(scriptSrc).toBeDefined();
    const sources = scriptSrc!.slice(1);
    expect(sources).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(sources.join(" ")).not.toMatch(
      /unsafe-inline|[^-]unsafe-eval|https?:|wss?:|\*|data:|blob:|ftp:/,
    );
  });

  it("default-src と connect-src は 'self' だけで、外部 origin を許さない", () => {
    for (const directive of ["default-src", "connect-src"]) {
      const tokens = APP_CONTENT_SECURITY_POLICY.split(";")
        .map((part) => part.trim().split(/\s+/))
        .find((t) => t[0] === directive);
      expect(tokens?.slice(1), directive).toEqual(["'self'"]);
    }
  });
});

describe("(d) 外向きの設定 API を呼ばない", () => {
  const FORBIDDEN: ReadonlyArray<{ name: string; pattern: RegExp }> = [
    { name: "webRequest", pattern: /\bwebRequest\b/ },
    { name: "setProxy / resolveProxy", pattern: /\b(setProxy|resolveProxy)\b/ },
    {
      name: "host resolver",
      pattern: /setHostResolver|host-resolver-rules|host-rules/,
    },
    {
      name: "proxy switch",
      pattern: /proxy-server|proxy-pac-url|proxy-bypass-list|no-proxy-server/,
    },
    {
      name: "WebRTC",
      pattern:
        /setWebRTC|WebRTCIPHandlingPolicy|webrtc-ip-handling|force-webrtc/i,
    },
    {
      name: "spellchecker",
      pattern:
        /\bsetSpellChecker\w*|\bspellcheck\b|SpellCheckerDictionary|spellChecker/i,
    },
    {
      name: "安全でない起動 switch",
      pattern:
        /disable-web-security|ignore-certificate-errors|allow-running-insecure-content|disable-site-isolation|--no-sandbox|disable-features=.*(Isolat|Sandbox)/i,
    },
  ];

  it("electron/main の製品 source は禁止の API と switch を含まない", () => {
    const violations: string[] = [];
    for (const { file, text } of mainSources()) {
      const code = stripComments(text);
      const allowed = RECORDED_Y1_COUNTERMEASURES[file] ?? [];
      for (const { name, pattern } of FORBIDDEN) {
        if (pattern.test(code) && !allowed.includes(name)) {
          violations.push(`${file}: ${name}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("appendSwitch は GPU の設定（linuxGraphics.ts）だけが呼ぶ", () => {
    const callers = mainSources()
      .filter(({ text }) => /\.appendSwitch\s*\(/.test(stripComments(text)))
      .map(({ file }) => file);
    expect(callers).toEqual(["linuxGraphics.ts"]);
  });
});

describe("(e) packaged で ELECTRON_RENDERER_URL を見ない", () => {
  it("env を読むのは devRendererUrl.ts だけ", () => {
    const readers = mainSources()
      .filter(({ text }) => /ELECTRON_RENDERER_URL/.test(stripComments(text)))
      .map(({ file }) => file);
    expect(readers).toEqual(["devRendererUrl.ts"]);
  });

  it("windows.ts、security.ts、index.ts は共通の helper を使う", () => {
    for (const file of ["windows.ts", "security.ts", "index.ts"]) {
      const text = stripComments(
        readFileSync(path.join(MAIN_DIR, file), "utf8"),
      );
      expect(text, file).toMatch(/getDevRendererUrl\(\)/);
      expect(text, file).not.toMatch(/process\.env\.ELECTRON_RENDERER_URL/);
    }
  });

  it("devRendererUrl.ts は packaged のとき env を返さない分岐を持つ", () => {
    const text = stripComments(
      readFileSync(path.join(MAIN_DIR, "devRendererUrl.ts"), "utf8"),
    );
    expect(text).toMatch(/if \(input\.isPackaged\) return undefined/);
  });
});

describe("SF-1 と E-3 の配線", () => {
  it("index.ts は mount の manager に guard と restricted の判定を渡し、title と download を固定する", () => {
    const text = stripComments(
      readFileSync(path.join(MAIN_DIR, "index.ts"), "utf8"),
    );
    expect(text).toMatch(/profileDataGuard:\s*getDefaultProfileDataGuard\(\)/);
    expect(text).toMatch(
      /isProfileRestricted:\s*\(\)\s*=>\s*profileEgress\.restricted\s*\|\|\s*profileEgress\.unavailable/,
    );
    expect(text).toMatch(/setWindowTitleLock\(/);
    expect(text).toMatch(/installProductDownloadGuard\(\)/);
  });

  it("保存 dialog の入口は guard を通す（共通の入口 showSavePathDialog）", () => {
    const text = stripComments(
      readFileSync(path.join(MAIN_DIR, "shellCommands.ts"), "utf8"),
    );
    const body = text.slice(
      text.indexOf("export async function showSavePathDialog"),
    );
    expect(body).toMatch(/sanitizeSuggestedName\(options\.suggestedName\)/);
    expect(body).toMatch(/guard\.assertOutside\(result\.filePath\)/);
    // dialog を直接開く箇所は showSavePathDialog だけ。
    expect(text.match(/showSaveDialog\(/g)?.length).toBe(2);
  });

  it("Chromium の download を保存する箇所は downloadGuard だけで、renderer の値で保存先を決めない", () => {
    const offenders = mainSources()
      .filter(
        ({ file, text }) =>
          file !== "downloadGuard.ts" &&
          /will-download|setSavePath/.test(stripComments(text)),
      )
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
