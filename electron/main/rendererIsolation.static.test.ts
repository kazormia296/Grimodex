/**
 * renderer の隔離の静的な検査（K3/2「renderer の隔離とその固定」2。DA-1）。
 *
 * restricted でも renderer が読める平文を外へ直接は送れない、という根拠（O-2）を支える
 * 設定が、将来の変更で黙って外れないよう、`electron/main` の source を読んで固定する。
 * (a) すべての BrowserWindow が buildWebPreferences() を使う。
 * (b) buildWebPreferences() に禁止の option を加えず、既存の 4 つだけを持つ。
 * (c) CSP の script-src が unsafe と外部 origin を含まない。
 * (d) webRequest、proxy、host resolver、WebRTC、spellchecker の設定 API を呼ばない
 *     （Y-1 の対処として記録したものだけを下の許可表に置く。NC-1 の 1 エントリ）。
 * (e) packaged で ELECTRON_RENDERER_URL を見ない（devRendererUrl.ts だけが読む）。
 * (f) NC-1（K3/3。renderer の外向き通信を Main の network 層で塞ぐ）の閉じた集合
 *     （Negative (31)）と、unrestricted への影響の表の静的に確かめられる項目（5・7・9）。
 * 実装の挙動は windows.test.ts、protocol.test.ts、security.test.ts、devRendererUrl.test.ts が固定する。
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
 * 対処は K3/3 の NC-1（`rendererContainmentStartup.ts` の 1 エントリ）だけで、許す名前は
 * `setProxy / resolveProxy`、`host resolver`、`WebRTC` の 3 つ。`proxy switch` と
 * `spellchecker` は許可しない（K3/3 の「補助の層」。`--proxy-server` なども足さない）。
 * 加えるときは対処として記録し、その設定を固定する試験も足す（DR-DA1-7、DR-NC1-2）。
 */
const RECORDED_Y1_COUNTERMEASURES: Readonly<Record<string, readonly string[]>> =
  {
    "rendererContainmentStartup.ts": [
      "setProxy / resolveProxy",
      "host resolver",
      "WebRTC",
    ],
  };

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

  it("appendSwitch は GPU の設定（linuxGraphics.ts）と NC-1 の module（host-resolver-rules だけ）だけが呼ぶ", () => {
    const callers = mainSources()
      .filter(({ text }) => /\.appendSwitch\s*\(/.test(stripComments(text)))
      .map(({ file }) => file);
    expect(callers).toEqual([
      "linuxGraphics.ts",
      "rendererContainmentStartup.ts",
    ]);
    // NC-1 の module が当てる switch は host-resolver-rules の 1 つだけ。
    const nc1 = stripComments(
      readFileSync(
        path.join(MAIN_DIR, "rendererContainmentStartup.ts"),
        "utf8",
      ),
    );
    const switches = [...nc1.matchAll(/appendSwitch\(\s*"([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(switches).toEqual(["host-resolver-rules"]);
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
      // index.ts は app protocol の登録の判定だけを使う（同じ helper の内側）。
      const helper =
        file === "index.ts"
          ? /shouldRegisterAppProtocol\(\)/
          : /getDevRendererUrl\(\)/;
      expect(text, file).toMatch(helper);
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

describe("(f) NC-1 の閉じた集合（K3/3 の Negative (31)）", () => {
  const product = () =>
    mainSources().filter(({ file }) => !/\.(test|spec)\./.test(file));
  const codeOf = (file: string): string =>
    stripComments(readFileSync(path.join(MAIN_DIR, file), "utf8"));
  const filesMatching = (pattern: RegExp): string[] =>
    product()
      .filter(({ text }) => pattern.test(stripComments(text)))
      .map(({ file }) => file)
      .sort();

  it("RS-1 の定数・AL-0・規則・policy・LS-1 の上界が固定どおり（順序まで exact）", async () => {
    const containment = await import("./rendererContainment.js");
    const listener = await import("./rendererContainmentListener.js");
    expect([...containment.RS1_RESOLVABLE_NAMES]).toEqual([
      "github.com",
      "objects.githubusercontent.com",
      "release-assets.githubusercontent.com",
      "localhost",
    ]);
    expect(containment.RESOLVER_SENTINEL_HOST).toBe(
      "grimodex-rule-sentinel.invalid",
    );
    // AL-0: 直接通信を許す先は 0 件で、proxyBypassRules は <-loopback> だけ。
    expect(containment.AL0_DIRECT_ALLOWLIST).toEqual([]);
    expect(containment.PROXY_BYPASS_RULES).toBe("<-loopback>");
    expect(containment.buildProxyConfig(4321)).toEqual({
      mode: "fixed_servers",
      proxyRules: "socks5://127.0.0.1:4321",
      proxyBypassRules: "<-loopback>",
    });
    expect(containment.buildHostResolverRules()).toBe(
      "MAP grimodex-rule-sentinel.invalid 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE github.com, EXCLUDE objects.githubusercontent.com, EXCLUDE release-assets.githubusercontent.com, EXCLUDE 127.0.0.1, EXCLUDE localhost",
    );
    expect(containment.WEBRTC_IP_HANDLING_POLICY).toBe(
      "disable_non_proxied_udp",
    );
    // LS-1 と起動前の期限の上界（確認済みの上限。超えたら赤。exact には固定しない）。
    expect(listener.LS1_MAX_CONCURRENT_CONNECTIONS).toBeLessThanOrEqual(256);
    expect(listener.LS1_MAX_HOLD_MS).toBeLessThanOrEqual(5000);
    expect(containment.NC_STARTUP_DEADLINE_MS).toBeLessThanOrEqual(5000);
  });

  it("buildHostResolverRules の製品の呼出しは起動の 1 箇所で、引数なし（prefixRules は試験だけ）", () => {
    const calls: Array<{ file: string; args: string }> = [];
    for (const { file, text } of product()) {
      const code = stripComments(text);
      for (const match of code.matchAll(
        /buildHostResolverRules\s*\(([^)]*)\)/g,
      )) {
        // 定義（export function … (prefixRules …)）は呼出しでない。
        const before = code.slice(Math.max(0, match.index! - 20), match.index!);
        if (/function\s*$/.test(before)) continue;
        calls.push({ file, args: match[1].trim() });
      }
    }
    expect(calls).toEqual([
      { file: "rendererContainmentStartup.ts", args: "" },
    ]);
  });

  it("NC-1 の module と設定の部品は env・起動引数・IPC を読まない。orchestrator の製品の呼出しは index.ts の引数なし", () => {
    for (const file of [
      "rendererContainment.ts",
      "rendererContainmentListener.ts",
      "rendererContainmentStartup.ts",
    ]) {
      const code = codeOf(file);
      expect(code, file).not.toMatch(
        /process\.env|process\.argv|ipcMain|ipcRenderer|\.handle\(|app\.commandLine\.(hasSwitch|getSwitchValue)/,
      );
    }
    const calls: Array<{ file: string; args: string }> = [];
    for (const { file, text } of product()) {
      const code = stripComments(text);
      for (const match of code.matchAll(
        /createRendererContainment\s*\(([^)]*)\)/g,
      )) {
        const before = code.slice(Math.max(0, match.index! - 20), match.index!);
        if (/function\s*$/.test(before)) continue;
        calls.push({ file, args: match[1].trim() });
      }
    }
    expect(calls).toEqual([{ file: "index.ts", args: "" }]);
    const index = codeOf("index.ts");
    for (const method of [
      "appendResolverSwitch",
      "registerWebContentsPolicy",
      "start",
    ]) {
      const invocations = [
        ...index.matchAll(
          new RegExp(`rendererContainment\\??\\.${method}\\(([^)]*)\\)`, "g"),
        ),
      ];
      expect(invocations.length, method).toBe(1);
      expect(invocations[0][1], method).toBe("");
    }
  });

  it("listener の製品の呼出しは NC-1 の module の 1 箇所で、上界を渡さない（確認済みの上限をそのまま使う）", () => {
    const calls = filesMatching(/startBlackholeListener\s*\(/);
    // 定義の file と NC-1 の module（呼出し）。
    expect(calls).toEqual([
      "rendererContainmentListener.ts",
      "rendererContainmentStartup.ts",
    ]);
    expect(codeOf("rendererContainmentStartup.ts")).not.toMatch(
      /maxConnections|holdMs/,
    );
  });

  it("listener は受けた bytes を検査・保存・log・書込みに渡さず、返事をしない", () => {
    const code = codeOf("rendererContainmentListener.ts");
    expect(code).not.toMatch(
      /["']data["']|\.read\(|\.write\(|\.end\(|\.pipe\(|\.setEncoding\(|\.on\(\s*["']readable["']|console\.|writeFile|appendFile|\bfs\b/,
    );
    expect(code).toMatch(/socket\.resume\(\)/);
  });

  it("session.defaultSession の出現は NC-1 の module と applySessionPermissionPolicy と installProductDownloadGuard だけ", () => {
    expect(filesMatching(/\bdefaultSession\b/)).toEqual([
      "downloadGuardElectron.ts",
      "rendererContainmentStartup.ts",
      "security.ts",
    ]);
    expect(filesMatching(/\bsession\.defaultSession\b/)).toEqual([
      "downloadGuardElectron.ts",
      "rendererContainmentStartup.ts",
      "security.ts",
    ]);
  });

  it("protocol.* の暗黙の default session の接触は registerAppProtocolHandler（protocol.ts）だけ", () => {
    expect(
      filesMatching(
        /\bprotocol\.(handle|unhandle|isProtocolHandled|isProtocolRegistered|isProtocolIntercepted|register\w*Protocol|intercept\w*Protocol|unintercept\w*|unregisterProtocol)\b/,
      ),
    ).toEqual(["protocol.ts"]);
  });

  it("proxy・WebRTC・host resolver の設定、専用 partition、listener の出現が NC-1 の許可した箇所だけ", () => {
    // setProxy／app.setProxy／resolveProxy／setWebRTC*／host-resolver-rules は NC-1 の module だけ。
    expect(filesMatching(/\bsetProxy\b/)).toEqual([
      "rendererContainmentStartup.ts",
    ]);
    expect(filesMatching(/\bresolveProxy\b/)).toEqual([
      "rendererContainmentStartup.ts",
    ]);
    expect(filesMatching(/\bapp\.setProxy\b/)).toEqual([]);
    expect(filesMatching(/setWebRTC\w*|getWebRTC\w*/)).toEqual([
      "rendererContainmentStartup.ts",
    ]);
    expect(filesMatching(/host-resolver-rules/)).toEqual([
      "rendererContainmentStartup.ts",
    ]);
    expect(filesMatching(/\bwebRequest\b/)).toEqual([]);
    expect(filesMatching(/proxy-server|proxy-pac-url|no-proxy-server/)).toEqual(
      [],
    );
    // 専用の partition を作らない（NC-1 は default session の 1 箇所）。
    expect(filesMatching(/fromPartition|["'`]persist:/)).toEqual([]);
    // `.listen(` は NC-1 の listener の file だけ（codexAppServer の argv の "--listen" は対象外）。
    expect(filesMatching(/\.listen\s*\(/)).toEqual([
      "rendererContainmentListener.ts",
    ]);
    // default session の net.fetch／net.request を足さない（影響表 9。electron/main は 0 件）。
    expect(filesMatching(/\bnet\.(fetch|request)\b/)).toEqual([]);
    expect(filesMatching(/\bnet\b[^;\n]*from\s+["']electron["']/)).toEqual([]);
  });

  it("閉じ込めを止める・弱める名前を export しない", () => {
    for (const file of [
      "rendererContainment.ts",
      "rendererContainmentListener.ts",
      "rendererContainmentStartup.ts",
    ]) {
      const names = [
        ...codeOf(file).matchAll(
          /export\s+(?:const|function|async function|class)\s+(\w+)/g,
        ),
      ].map((m) => m[1]);
      expect(names.length, file).toBeGreaterThan(0);
      for (const name of names) {
        expect(name, `${file}: ${name}`).not.toMatch(
          /disable(?!_)|enableContainment|skip|turnOff|unrestrict|unsafe|insecure/i,
        );
      }
    }
  });

  it("名前解決の記録層と DoH の canary は製品の source に入らない", () => {
    expect(
      filesMatching(
        /LD_PRELOAD|PROBE_DNSLOG|dnslog|dns-canary|doh-canary|canary/i,
      ),
    ).toEqual([]);
  });

  it("名前解決の記録層と DoH の canary は製品の bundle（main と preload の esbuild の出力）に入らない（electron/shared と preload 経由の混入も見る）", async () => {
    // pnpm electron:build と同じ設定（electron/scripts/build.mjs の bundleConfigs）を、書き出さずに in-memory で束ねて走査する。
    // 'canary' 単独は依存 package の文字列に当たりうるので、記録層と DoH の canary の固有の名前だけを見る。
    const buildModule = (await import(
      pathToFileURL(path.join(MAIN_DIR, "..", "scripts", "build.mjs")).href
    )) as { bundleConfigs: Array<Record<string, unknown>> };
    const esbuild = (await import("esbuild")).default;
    const forbidden =
      /LD_PRELOAD|PROBE_DNSLOG|dnslog|dns-canary|doh-canary|webrtc-block-probe/i;
    expect(buildModule.bundleConfigs.length).toBe(2);
    for (const config of buildModule.bundleConfigs) {
      const result = await esbuild.build({
        ...config,
        outfile: undefined,
        outdir: "out",
        write: false,
        sourcemap: false,
        logLevel: "silent",
      });
      expect(result.outputFiles.length).toBe(1);
      const text = result.outputFiles[0].text;
      // 束ねた出力が空でない（走査が何も見ていないわけではない）。NC-1 の module が main に入っている。
      const isMain = /electron[\\/]main[\\/]/.test(String(config.entryPoints));
      expect(text.length).toBeGreaterThan(isMain ? 1_000_000 : 1_000);
      expect(text.match(forbidden), String(config.entryPoints)).toBeNull();
      if (isMain) expect(text).toContain("grimodex-rule-sentinel.invalid");
    }
  }, 60_000);

  it("NC-1 の適用は shouldRegisterAppProtocol() が true のときだけで、packaged は env があっても適用する", async () => {
    const index = codeOf("index.ts");
    expect(index).toMatch(
      /const rendererContainment\s*=\s*shouldRegisterAppProtocol\(\)\s*\?\s*createRendererContainment\(\)\s*:\s*null/,
    );
    const { shouldRegisterAppProtocolFor, resolveDevRendererUrl } =
      await import("./devRendererUrl.js");
    const env = { ELECTRON_RENDERER_URL: "http://127.0.0.1:5173" };
    // packaged: env があっても true（dev URL を読まない）。
    expect(shouldRegisterAppProtocolFor({ isPackaged: true, env })).toBe(true);
    expect(resolveDevRendererUrl({ isPackaged: true, env })).toBeUndefined();
    // 非 packaged で env あり（dev server）だけが除外。
    expect(shouldRegisterAppProtocolFor({ isPackaged: false, env })).toBe(
      false,
    );
    expect(shouldRegisterAppProtocolFor({ isPackaged: false, env: {} })).toBe(
      true,
    );
  });

  it("影響表 7: src、electron/main、electron/preload は RTCPeerConnection を使わない", () => {
    const roots = ["../../src", ".", "../preload"].map((rel) =>
      path.resolve(MAIN_DIR, rel),
    );
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules") continue;
          walk(full);
        } else if (
          /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry.name) &&
          !/\.(test|spec)\./.test(entry.name) &&
          // この file 自身ではない製品 source だけを見る。
          /RTCPeerConnection|webkitRTCPeerConnection/.test(
            stripComments(readFileSync(full, "utf8")),
          )
        ) {
          offenders.push(path.relative(path.resolve(MAIN_DIR, "../.."), full));
        }
      }
    };
    for (const root of roots) walk(root);
    expect(offenders).toEqual([]);
  });
});

/**
 * DA-2 ST2（K3/2 の X-1 と K3/3 の変える点 4、Negative (6)、P3-3、D-15。
 * `docs/plans/nir1-lane-decisions/da2-decisions.md` の DR-DA2-10、11、17）。
 */
describe("DA-2: spellchecker、grant を伴わない activation、gate の entry、workspace の束縛", () => {
  const REPO = path.resolve(MAIN_DIR, "../..");
  /** The product's Main source: not the tests, not the pipeline specs. */
  const productSources = (): Array<{ file: string; text: string }> =>
    mainSources().filter(({ file }) => !/\.spec\./.test(file));

  it("main never configures the spellchecker（言語、辞書の取得先、外部 service、webPreferences の spellcheck）", () => {
    const pattern =
      /\bsetSpellChecker(?:Languages|DictionaryDownloadURL|Enabled)\b|\baddWordToSpellCheckerDictionary\b|\bremoveWordFromSpellCheckerDictionary\b|\bspellcheck\s*:|\bspellCheckerEnabled\b/;
    const preload = readdirSync(path.join(MAIN_DIR, "..", "preload"))
      .filter((name) => /\.ts$/.test(name) && !/\.test\./.test(name))
      .map((name) => ({
        file: `../preload/${name}`,
        text: readFileSync(path.join(MAIN_DIR, "..", "preload", name), "utf8"),
      }));
    const offenders = [...productSources(), ...preload]
      .filter(({ text }) => pattern.test(stripComments(text)))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("grant を伴わない activation の method が index.d.ts と Main の型・source に残らない（Negative (6)）", () => {
    const dts = readFileSync(
      path.join(REPO, "electron/native/grimodex-node/index.d.ts"),
      "utf8",
    );
    expect(dts).not.toMatch(/\bactivateProfileEgress\b/);
    for (const method of [
      "profileActivationPreview",
      "profileActivationIssue",
      "profileActivationConsume",
      "profileActivationCommit",
      "profileActivationAbortInFlight",
    ]) {
      expect(dts, method).toMatch(new RegExp(`\\b${method}\\(`));
    }
    const contract = stripComments(
      readFileSync(path.join(REPO, "electron/shared/ipcContract.ts"), "utf8"),
    );
    expect(contract).not.toMatch(/\bactivateProfileEgress\b/);
    const offenders = productSources()
      .filter(({ text }) =>
        /\bactivateProfileEgress\b|\bactivateFirstRestrictedPublication\b/.test(
          stripComments(text),
        ),
      )
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("Native の commit を呼ぶのは gate（profileEgress.ts）だけ、consume を呼ぶのは token を作る関数だけ", () => {
    const callers = (pattern: RegExp): string[] =>
      productSources()
        .filter(({ text }) => pattern.test(stripComments(text)))
        .map(({ file }) => file)
        .sort();
    expect(callers(/\.profileActivationCommit\b/)).toEqual([
      "profileEgress.ts",
    ]);
    // profileActivation.ts only checks the method is present.
    expect(callers(/\bprofileActivationConsume\b/)).toEqual([
      "profileActivation.ts",
      "profileEgress.ts",
    ]);
    const consumeCalls = [
      ...stripComments(
        readFileSync(path.join(MAIN_DIR, "profileEgress.ts"), "utf8"),
      ).matchAll(/profileActivationConsume\b/g),
    ];
    expect(consumeCalls.length).toBeGreaterThan(0);
    // DR-DA2-24 / L-1: only the gate asks Native to stop the AI in flight.
    expect(callers(/\bprofileActivationAbortInFlight\b/)).toEqual([
      "profileEgress.ts",
    ]);
  });

  it("the gate asks Native to stop the AI in flight before the unavailable notice, outside stages 4 and 5 (L-1)", () => {
    const source = stripComments(
      readFileSync(path.join(MAIN_DIR, "profileEgress.ts"), "utf8"),
    );
    // The one call site wraps the N-API; the activation's catch calls it.
    expect([
      ...source.matchAll(/backend\.profileActivationAbortInFlight!\(\)/g),
    ]).toHaveLength(1);
    const begin = source.indexOf("  beginProfileActivation(");
    const end = source.indexOf("  private requestNativeInFlightAbort(");
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
    const body = source.slice(begin, end);
    const abort = body.indexOf(
      "if (!commitRequested) this.requestNativeInFlightAbort();",
    );
    const notice = body.indexOf(
      'const view: ProfileEgressStatusView = { state: "unavailable", reason };',
    );
    expect(abort).toBeGreaterThan(0);
    expect(notice).toBeGreaterThan(abort);
    expect(body.indexOf("commitRequested = true;")).toBeLessThan(
      body.indexOf("raw = await commit();"),
    );
  });

  it("index.ts wires the gate's DA-2 members (R-4)", () => {
    const index = stripComments(
      readFileSync(path.join(MAIN_DIR, "index.ts"), "utf8"),
    ).replace(/\s+/g, " ");
    for (const wiring of [
      // The notices of stage 2, stage 6 and unavailable.
      "profileEgress.onStatusChange( createProfileEgressStatusNotifier({ resetWindowTitles, terminateAiStreams: () => aiStreamTerminals.terminateAll(), disposeLicenseValidation: () => licenseValidation.dispose(), broadcast: broadcastMainEvent, }), );",
      "createAiStreamTerminalTracker({ send: sendAiStreamTerminalToWindow, });",
      // L-3: the quit reaches the gate.
      'app.on("will-quit", (event) => { profileEgress.noteAppQuitting(); void quitFinalizer(event); });',
      // R-7: the closed reason of a Backend that could not be built.
      "createProfileEgressGate(initializedBackend, { backendConstructionFailure: initializedBackend ? null : getBackendConstructionFailure(), });",
      // The request controller and the router.
      "createProfileActivationController({ backend, gate: profileEgress, inFlight: mainGrantInFlight, confirm: profileActivationCiSeam?.confirm, });",
      "mainGrant, profileActivation, aiStreamTerminals, );",
      // R-3: the seam refuses the ordinary data directories.
      "defaultUserDataDirs: defaultUserDataDirectoriesForApp(app),",
    ]) {
      expect(index, wiring).toContain(wiring);
    }
    // The product gate's members are required: no optional call on them.
    expect(index).not.toMatch(
      /profileEgress\.(?:onStatusChange|statusView|beginProfileActivation|isIssuedCallerIdentity|noteAppQuitting)\?\./,
    );
  });

  /**
   * Every reference of the gate-opening N-API, by line. The `typeof` check
   * and the `Pick<NapiBackendLike, …>` type are named as such; any other
   * reference (a call in any form, `?.(`, `.call(`, `["…"](`, an alias) is
   * kept as written, so only the three seams' exact calls pass (R-1).
   */
  const gateOpenReferences = (
    sources: ReadonlyArray<{ file: string; text: string }>,
  ): string[] =>
    sources.flatMap(({ file, text }) =>
      stripComments(text)
        .split("\n")
        .filter((line) => /\bmainOpenPrePublicationGate\b/.test(line))
        .map((line) => {
          const trimmed = line.trim();
          if (
            /^if \(typeof backend\?\.mainOpenPrePublicationGate !== "function"\) return (?:null|false);$/.test(
              trimmed,
            )
          ) {
            return `${file}: typeof-check`;
          }
          if (
            /^readonly backend: Pick<NapiBackendLike, "mainOpenPrePublicationGate"> \| null;$/.test(
              trimmed,
            )
          ) {
            return `${file}: type`;
          }
          return `${file}: ${trimmed}`;
        }),
    );

  it("mainOpenPrePublicationGate を呼ぶのは 3 つの seam だけで、wire の値はそれぞれの定数だけ（P3-3、R-1、DR-DD1B-4）", () => {
    expect(gateOpenReferences(productSources()).sort()).toEqual([
      "bodyDeclarationCiSeam.ts: backend.mainOpenPrePublicationGate(BODY_DECLARATION_CI_GATE_ENTRY);",
      "bodyDeclarationCiSeam.ts: type",
      "bodyDeclarationCiSeam.ts: typeof-check",
      "nir1LocalGeneration.ts: backend.mainOpenPrePublicationGate(NIR1_LOCAL_GENERATION_CI_GATE_ENTRY);",
      "nir1LocalGeneration.ts: type",
      "nir1LocalGeneration.ts: typeof-check",
      "profileActivationCiSeam.ts: backend.mainOpenPrePublicationGate(PROFILE_ACTIVATION_CI_GATE_ENTRY);",
      "profileActivationCiSeam.ts: type",
      "profileActivationCiSeam.ts: typeof-check",
    ]);
    // DD-1b: the local generation route's entry, opened only by its seam.
    expect(
      readFileSync(path.join(MAIN_DIR, "nir1LocalGeneration.ts"), "utf8"),
    ).toMatch(
      /export const NIR1_LOCAL_GENERATION_CI_GATE_ENTRY = "nir1-local-generation";/,
    );
    const body = readFileSync(
      path.join(MAIN_DIR, "bodyDeclarationCiSeam.ts"),
      "utf8",
    );
    expect(body).toMatch(
      /export const BODY_DECLARATION_CI_GATE_ENTRY = "scene-body-declaration";/,
    );
    const profile = readFileSync(
      path.join(MAIN_DIR, "profileActivationCiSeam.ts"),
      "utf8",
    );
    expect(profile).toMatch(
      /export const PROFILE_ACTIVATION_CI_GATE_ENTRY = "profile-activation";/,
    );
  });

  it("the gate-opening check catches the call forms that a `.name(` pattern misses (R-1)", () => {
    for (const evasion of [
      'backend?.mainOpenPrePublicationGate?.("profile-activation");',
      'backend.mainOpenPrePublicationGate.call(backend, "profile-activation");',
      'backend["mainOpenPrePublicationGate"]("profile-activation");',
      "const open = backend.mainOpenPrePublicationGate;",
    ]) {
      expect(
        gateOpenReferences([{ file: "other.ts", text: evasion }]),
        evasion,
      ).toEqual([`other.ts: ${evasion}`]);
      // Inside a seam file too, an extra form is kept as written, so the
      // exact list above no longer matches.
      expect(
        gateOpenReferences([
          { file: "profileActivationCiSeam.ts", text: evasion },
        ]),
        evasion,
      ).toEqual([`profileActivationCiSeam.ts: ${evasion}`]);
    }
    // A comment is not a reference.
    expect(
      gateOpenReferences([
        { file: "other.ts", text: "// mainOpenPrePublicationGate(x)" },
      ]),
    ).toEqual([]);
  });

  it("main が束縛を観測する前に Native が workspace を束縛する経路が製品にない（D-15）", () => {
    const binders =
      /\.(openWorkspace|restoreBackup|restoreRecoveryCandidate|seedSampleWorkspace|importWebEditorWorkspace)\s*[(,)]/;
    const offenders = productSources()
      .filter(({ text }) => binders.test(stripComments(text)))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
    // They are reached through the router's NAPI_COMMANDS only.
    const contract = stripComments(
      readFileSync(path.join(REPO, "electron/shared/ipcContract.ts"), "utf8"),
    );
    for (const method of [
      "openWorkspace",
      "restoreBackup",
      "restoreRecoveryCandidate",
      "seedSampleWorkspace",
      "importWebEditorWorkspace",
    ]) {
      expect(
        [...contract.matchAll(new RegExp(`\\bb\\.${method}\\b`, "g"))].length,
        method,
      ).toBe(1);
    }
  });
});
