import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  MASTRA_ALLOWED_ENV_NAMES,
  MASTRA_PINNED_ENV,
  MASTRA_REMOVED_ENV_NAMES,
  MASTRA_REMOVED_ENV_PREFIXES,
  createMastraEnvPin,
  isMastraRemovedEnvName,
  mastraOriginalEnv,
  mastraOriginalEnvValue,
} from "./mastraEnv.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

describe("mastraEnv（env の固定。apply は MP-3c まで呼ばない）", () => {
  it("固定する値は厳密に MASTRA_TELEMETRY_DISABLED=1 と MASTRA_OFFLINE=true", () => {
    expect(MASTRA_PINNED_ENV).toEqual({
      MASTRA_TELEMETRY_DISABLED: "1",
      MASTRA_OFFLINE: "true",
    });
    expect(Object.isFrozen(MASTRA_PINNED_ENV)).toBe(true);
  });

  it("除く名前は型で決まる：先頭（MASTRA_・OM_・AI_GATEWAY_・VERCEL_）、末尾（key・token・secret・宛先）、明示の名前", () => {
    for (const name of [
      // 先頭
      "MASTRA_DEV",
      "MASTRA_AUTO_REFRESH_PROVIDERS",
      "MASTRA_LICENSE_KEY",
      "MASTRA_EE_LICENSE",
      "MASTRA_GATEWAY_API_KEY",
      "MASTRA_TELEMETRY_DISABLED",
      "OM_DEBUG",
      "OM_REPRO_CAPTURE",
      "OM_REPRO_CAPTURE_DIR",
      "OM_OTHER",
      "AI_GATEWAY_API_KEY",
      "AI_GATEWAY_BASE_URL",
      "VERCEL_OIDC_TOKEN",
      "VERCEL_DEPLOYMENT_ID",
      "VERCEL_ENV",
      "VERCEL_PROJECT_ID",
      "VERCEL_REGION",
      // 末尾
      "OPENROUTER_API_KEY",
      "PINECONE_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "NETLIFY_TOKEN",
      "SOME_API_TOKEN",
      "SOME_ACCESS_TOKEN",
      "SESSION_SECRET",
      "SOME_SECRET_KEY",
      "DB_PASSWORD",
      "SOME_PRIVATE_KEY",
      "OPENAI_BASE_URL",
      "ANTHROPIC_BASE_URL",
      // 明示の名前
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "GOOGLE_API_KEY",
      "DATABASE_URL",
      "AZURE_RESOURCE_NAME",
    ]) {
      expect(isMastraRemovedEnvName(name, "linux"), name).toBe(true);
    }
    for (const name of [
      "PATH",
      "HOME",
      "NODE_ENV",
      "NOT_MASTRA_DEV",
      "XOM_DEBUG",
      "TOKENIZER",
      "SECRETARY",
      "API_KEY_FILE",
      // POSIX の env 名は大文字小文字を区別する。
      "openai_api_key",
      "mastra_dev",
    ]) {
      expect(isMastraRemovedEnvName(name, "linux"), name).toBe(false);
    }
    // 既存の明示の名前は、型の規則に当たる名前も含めて一覧に残す。
    for (const name of [
      "OM_DEBUG",
      "OM_REPRO_CAPTURE",
      "OM_REPRO_CAPTURE_DIR",
      "VERCEL_OIDC_TOKEN",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "GOOGLE_API_KEY",
    ]) {
      expect(MASTRA_REMOVED_ENV_NAMES).toContain(name);
    }
    expect(isMastraRemovedEnvName("openai_api_key", "win32")).toBe(true);
    expect(isMastraRemovedEnvName("Mastra_Dev", "win32")).toBe(true);
    expect(isMastraRemovedEnvName("Path", "win32")).toBe(false);
  });

  it("apply は除く env を消して 2 値を固定し、他の env には触れない（値は結果に残さない）", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/home/u",
      NODE_ENV: "production",
      ANTHROPIC_AUTH_TOKEN: "dummy-auth",
      OPENROUTER_API_KEY: "dummy-openrouter",
      MASTRA_DEV: "true",
      MASTRA_AUTO_REFRESH_PROVIDERS: "true",
      MASTRA_TELEMETRY_DISABLED: "0",
      MASTRA_OFFLINE: "false",
      OM_DEBUG: "1",
      OM_REPRO_CAPTURE: "1",
      OM_REPRO_CAPTURE_DIR: "/tmp/x",
      VERCEL_OIDC_TOKEN: "t",
      OPENAI_API_KEY: "dummy-openai",
      ANTHROPIC_API_KEY: "dummy-anthropic",
      GOOGLE_GENERATIVE_AI_API_KEY: "dummy-google",
      GOOGLE_API_KEY: "dummy-google2",
    };
    const pin = createMastraEnvPin({ env, platform: "linux" });
    expect(pin.applied).toBe(false);
    const result = pin.apply();
    expect(pin.applied).toBe(true);
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/u",
      NODE_ENV: "production",
      MASTRA_TELEMETRY_DISABLED: "1",
      MASTRA_OFFLINE: "true",
    });
    expect(result.removed).toEqual(
      [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "GOOGLE_API_KEY",
        "GOOGLE_GENERATIVE_AI_API_KEY",
        "MASTRA_AUTO_REFRESH_PROVIDERS",
        "MASTRA_DEV",
        "MASTRA_OFFLINE",
        "MASTRA_TELEMETRY_DISABLED",
        "OM_DEBUG",
        "OM_REPRO_CAPTURE",
        "OM_REPRO_CAPTURE_DIR",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "VERCEL_OIDC_TOKEN",
      ].sort(),
    );
    expect(JSON.stringify(result)).not.toContain("dummy-");
    expect(result.pinned).toEqual(MASTRA_PINNED_ENV);
  });

  it("Windows の plain object では、大文字小文字の違う名前も除き、固定の名前は 1 つだけ残る", () => {
    const env: NodeJS.ProcessEnv = {
      Path: "C:\\x",
      openai_api_key: "dummy",
      Some_Token: "dummy",
      Vercel_Env: "preview",
      Mastra_Dev: "1",
      Mastra_Offline: "false",
    };
    createMastraEnvPin({ env, platform: "win32" }).apply();
    expect(env).toEqual({
      Path: "C:\\x",
      MASTRA_TELEMETRY_DISABLED: "1",
      MASTRA_OFFLINE: "true",
    });
  });

  it("originalEnv は固定を当てる前の env の写しを返し、2 回目の apply で撮り直さない", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "dummy-anthropic",
      ANTHROPIC_AUTH_TOKEN: "dummy-auth",
      MASTRA_DEV: "true",
    };
    const pin = createMastraEnvPin({ env, platform: "linux" });
    // apply の前は、現在の env の写し。
    expect(pin.originalEnv()).toEqual(env);
    expect(pin.originalEnv()).not.toBe(env);
    const first = pin.apply();
    expect(pin.apply()).toBe(first);
    const copy = pin.originalEnv();
    expect(copy).toEqual({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "dummy-anthropic",
      ANTHROPIC_AUTH_TOKEN: "dummy-auth",
      MASTRA_DEV: "true",
    });
    // 子 process に渡す写しを変えても、元の写しにも env にも響かない。
    copy.ANTHROPIC_API_KEY = "changed";
    expect(pin.originalEnv().ANTHROPIC_API_KEY).toBe("dummy-anthropic");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    // 固定済みの env を 2 回目に適用しても、写しは固定を当てる前のまま。
    pin.apply();
    expect(pin.originalEnv().MASTRA_DEV).toBe("true");
    expect(pin.originalEnv().MASTRA_OFFLINE).toBeUndefined();
  });

  it("既定の対象は process.env（apply しなければ触れない）", () => {
    const before = { ...process.env };
    const pin = createMastraEnvPin();
    expect(pin.originalEnv()).toEqual(before);
    expect(process.env).toEqual(before);
  });
});

const OWNER_TOKEN_NAMES = [
  "GRIMODEX_RUNTIME_PERFORMANCE_OWNER_TOKEN",
  "GRIMODEX_BODY_DECLARATION_CI_OWNER_TOKEN",
  "GRIMODEX_PROFILE_ACTIVATION_CI_OWNER_TOKEN",
  "GRIMODEX_NIR1_LOCAL_GENERATION_CI_OWNER_TOKEN",
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_OWNER_TOKEN",
] as const;

describe("実名の許可リスト（MP-3a、DR-MP3-8）：Grimodex 自身の owner token 5 名だけを除かない", () => {
  it("許可リストは実名 5 つで、凍結され、決定のとおりの名前", () => {
    expect([...MASTRA_ALLOWED_ENV_NAMES]).toEqual([...OWNER_TOKEN_NAMES]);
    expect(Object.isFrozen(MASTRA_ALLOWED_ENV_NAMES)).toBe(true);
  });

  it("許可名は MASTRA_／OM_／AI_GATEWAY_／VERCEL_ で始まらず、除去の固定名と交わらない（型の規則に当たるのは _TOKEN だけ）", () => {
    for (const name of MASTRA_ALLOWED_ENV_NAMES) {
      for (const prefix of MASTRA_REMOVED_ENV_PREFIXES) {
        expect(name.startsWith(prefix), `${name} は ${prefix} で始まる`).toBe(
          false,
        );
      }
      expect(MASTRA_REMOVED_ENV_NAMES, name).not.toContain(name);
      expect(name.endsWith("_TOKEN"), name).toBe(true);
    }
    expect(new Set(MASTRA_ALLOWED_ENV_NAMES).size).toBe(
      MASTRA_ALLOWED_ENV_NAMES.length,
    );
  });

  it("5 名は残り、同じ形の他の名前（GRIMODEX_FOO_TOKEN など）は除かれる。許可は実名の完全一致だけ", () => {
    for (const name of OWNER_TOKEN_NAMES) {
      expect(isMastraRemovedEnvName(name, "linux"), name).toBe(false);
    }
    for (const name of [
      "GRIMODEX_FOO_TOKEN",
      "GRIMODEX_OPENAI_API_KEY",
      "GRIMODEX_RUNTIME_PERFORMANCE_OWNER_API_KEY",
      "X_GRIMODEX_BODY_DECLARATION_CI_OWNER_TOKEN",
      "GRIMODEX_NEW_CI_OWNER_TOKEN",
      "GRIMODEX_MASTRA_API_KEY",
    ]) {
      expect(isMastraRemovedEnvName(name, "linux"), name).toBe(true);
    }
    // GRIMODEX_ 始まり全体の除外ではない：除去の規則に当たらない名前は、もともと残る。
    expect(isMastraRemovedEnvName("GRIMODEX_NODE_PATH", "linux")).toBe(false);
  });

  it("比較は fold を通す：Windows では大小を問わず残り、POSIX は大小を区別する", () => {
    for (const name of OWNER_TOKEN_NAMES) {
      expect(isMastraRemovedEnvName(name.toLowerCase(), "win32"), name).toBe(
        false,
      );
      expect(
        isMastraRemovedEnvName(
          name.replace(/GRIMODEX_/, "Grimodex_").replace(/_TOKEN$/, "_Token"),
          "win32",
        ),
        name,
      ).toBe(false);
    }
    expect(isMastraRemovedEnvName("grimodex_foo_token", "win32")).toBe(true);
    // POSIX の小文字の名前は、末尾の規則（大文字）に当たらず残る（もともとの挙動）。
    expect(isMastraRemovedEnvName("grimodex_foo_token", "linux")).toBe(false);
  });

  it("apply は 5 名を残し、同じ形の他の名前を除く（Linux と Windows の plain object）", () => {
    for (const platform of ["linux", "win32"] as const) {
      const env: NodeJS.ProcessEnv = {
        PATH: "/usr/bin",
        GRIMODEX_FOO_TOKEN: "dummy-foo",
        ANTHROPIC_API_KEY: "dummy-anthropic",
      };
      for (const name of OWNER_TOKEN_NAMES) env[name] = "dummy-owner";
      const result = createMastraEnvPin({ env, platform }).apply();
      for (const name of OWNER_TOKEN_NAMES) {
        expect(env[name], `${platform} ${name}`).toBe("dummy-owner");
        expect(result.removed).not.toContain(name);
      }
      expect(env.GRIMODEX_FOO_TOKEN).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(result.removed).toEqual(
        ["ANTHROPIC_API_KEY", "GRIMODEX_FOO_TOKEN"].sort(),
      );
    }
  });
});

describe("originalEnv の配線（MP-3a、DR-MP3-9）：apply の前は live の process.env と同値で、gate 閉で挙動が変わらない", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("共有の pin の mastraOriginalEnv は、apply の前は live の process.env の写しと同値で、後の変更も見える", () => {
    expect(mastraOriginalEnv()).toEqual({ ...process.env });
    expect(mastraOriginalEnv()).not.toBe(process.env);
    vi.stubEnv("GRIMODEX_MP3A_PROBE", "after-construction");
    expect(mastraOriginalEnv().GRIMODEX_MP3A_PROBE).toBe("after-construction");
    expect(mastraOriginalEnvValue("GRIMODEX_MP3A_PROBE")).toBe(
      "after-construction",
    );
    vi.stubEnv("GRIMODEX_MP3A_PROBE", undefined);
    expect(mastraOriginalEnvValue("GRIMODEX_MP3A_PROBE")).toBeUndefined();
    // 写しを変えても process.env に響かない。
    const copy = mastraOriginalEnv();
    copy.GRIMODEX_MP3A_WRITE = "x";
    expect(process.env.GRIMODEX_MP3A_WRITE).toBeUndefined();
  });

  it("名前引きは apply の前後で同じ値（apply の後は固定前の写し）。除く名前も固定前の値を返す", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      OPENROUTER_API_KEY: "dummy-openrouter",
      MASTRA_DEV: "true",
    };
    const pin = createMastraEnvPin({ env, platform: "linux" });
    expect(pin.originalEnvValue("OPENROUTER_API_KEY")).toBe("dummy-openrouter");
    pin.apply();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(pin.originalEnvValue("OPENROUTER_API_KEY")).toBe("dummy-openrouter");
    expect(pin.originalEnvValue("MASTRA_DEV")).toBe("true");
    expect(pin.originalEnvValue("MASTRA_OFFLINE")).toBeUndefined();
    expect(pin.originalEnvValue("PATH")).toBe("/usr/bin");
    expect(pin.originalEnvValue("absent")).toBeUndefined();
  });

  it("Windows：写しも名前引きも、process.env と同じく大文字小文字を区別しない（実 key が Path でも PATH で引ける）", () => {
    const env: NodeJS.ProcessEnv = {
      Path: "C:\\Windows",
      LocalAppData: "C:\\Users\\u\\AppData\\Local",
      ANTHROPIC_API_KEY: "dummy",
    };
    const pin = createMastraEnvPin({ env, platform: "win32" });
    const before = pin.originalEnv();
    expect(before.PATH).toBe("C:\\Windows");
    expect(before.LOCALAPPDATA).toBe("C:\\Users\\u\\AppData\\Local");
    expect("PATH" in before).toBe(true);
    expect(pin.originalEnvValue("PATH")).toBe("C:\\Windows");
    expect(pin.originalEnvValue("localappdata")).toBe(
      "C:\\Users\\u\\AppData\\Local",
    );
    // 実 key は変わらない（spawn の env に Path がそのまま渡る）。
    expect(Object.keys(before).sort()).toEqual(
      ["ANTHROPIC_API_KEY", "LocalAppData", "Path"].sort(),
    );
    expect({ ...before }).toEqual({ ...env });
    pin.apply();
    const after = pin.originalEnv();
    expect(after.path).toBe("C:\\Windows");
    expect(after.ANTHROPIC_API_KEY).toBe("dummy");
    expect(env.Path).toBe("C:\\Windows");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    // 写しへの書込みは、固定前の写しにも env にも響かない。大小違いの名前は同じ key に書く。
    after.PATH = "changed";
    expect(after.Path).toBe("changed");
    expect(pin.originalEnv().Path).toBe("C:\\Windows");
    delete after.pAtH;
    expect(after.Path).toBeUndefined();
  });

  it("POSIX の写しは plain object のまま（大小を区別する）", () => {
    const pin = createMastraEnvPin({
      env: { Path: "/x" },
      platform: "linux",
    });
    expect(pin.originalEnv().PATH).toBeUndefined();
    expect(pin.originalEnvValue("PATH")).toBeUndefined();
    expect(pin.originalEnvValue("Path")).toBe("/x");
  });

  it("構築後に process.env の object が差し替わっても、既定の pin は新しい process.env を見る", () => {
    const real = process.env;
    const pin = createMastraEnvPin({ platform: "linux" });
    try {
      process.env = { PATH: "/replaced" };
      expect(pin.originalEnv()).toEqual({ PATH: "/replaced" });
    } finally {
      process.env = real;
    }
  });
});

describe("apply に届く入口は mastraEnv.ts の外に無い（MP-3a は apply を呼ばない。呼ぶのは MP-3c）", () => {
  /** コメントと文字列の中の言及を除いた code。 */
  const codeOf = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  /** electron の製品 code（試験・spec 以外の .ts）。 */
  const productSources = (): Record<string, string> => {
    const out: Record<string, string> = {};
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (
          /\.ts$/.test(entry.name) &&
          !/\.(test|spec)\.ts$/.test(entry.name) &&
          !/\.d\.ts$/.test(entry.name)
        ) {
          out[path.relative(repoRoot, full)] = fs.readFileSync(full, "utf8");
        }
      }
    };
    for (const sub of ["main", "shared", "preload"]) {
      walk(path.join(repoRoot, "electron", sub));
    }
    return out;
  };

  /** mastraEnv.ts の外で、pin の作成・apply・固定の定数に触れている file と理由。 */
  const violations = (sources: Record<string, string>): string[] => {
    const found: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      if (file.endsWith(path.join("electron", "main", "mastraEnv.ts"))) {
        continue;
      }
      const code = codeOf(text);
      for (const match of code.matchAll(
        /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["'][^"']*mastraEnv(?:\.js)?["']/g,
      )) {
        for (const raw of match[1].split(",")) {
          const name = raw.trim().split(/\s+as\s+/)[0];
          if (
            name &&
            name !== "mastraOriginalEnv" &&
            name !== "mastraOriginalEnvValue" &&
            !/^type\s/.test(name) &&
            name !== "MastraEnvPin" &&
            name !== "MastraEnvPinResult"
          ) {
            found.push(`${file}: mastraEnv から ${name} を import している`);
          }
        }
      }
      if (/createMastraEnvPin|sharedPin|\bMASTRA_PINNED_ENV\b/.test(code)) {
        found.push(`${file}: pin の作成か固定の定数に触れている`);
      }
      if (/\bimport\s*\*\s*as\s+\w+\s+from\s*["'][^"']*mastraEnv/.test(code)) {
        found.push(`${file}: mastraEnv を namespace import している`);
      }
    }
    return found;
  };

  it("製品の code は mastraOriginalEnv／mastraOriginalEnvValue だけを import し、pin を作らず apply に届かない", () => {
    const sources = productSources();
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    expect(violations(sources)).toEqual([]);
    // mastraEnv を使う file が配線の想定どおり（読む箇所が 0 件になっていない）。
    const users = Object.entries(sources)
      .filter(
        ([file, text]) =>
          !file.endsWith(path.join("main", "mastraEnv.ts")) &&
          /from\s*["'][^"']*mastraEnv(?:\.js)?["']/.test(text),
      )
      .map(([file]) => file.split(path.sep).slice(-2).join("/"))
      .sort();
    expect(users).toEqual(
      [
        "main/backend.ts",
        "main/cliAi.ts",
        "main/ipc.ts",
        "main/mcpSidecar.ts",
        "codexAppServer/process.ts",
        "main/vivliostyle.ts",
      ].sort(),
    );
  });

  it("陰性対照：pin を作る・apply に届く import は検出される", () => {
    expect(
      violations({
        "electron/main/x.ts":
          'import { createMastraEnvPin } from "./mastraEnv.js";\nconst pin = createMastraEnvPin(); pin.apply();',
        "electron/main/y.ts":
          'import * as env from "./mastraEnv.js";\nenv.mastraOriginalEnv();',
        "electron/main/z.ts":
          'import { mastraOriginalEnv, MASTRA_PINNED_ENV as P } from "./mastraEnv.js";',
        "electron/main/ok.ts":
          '// createMastraEnvPin は書かない\nimport { mastraOriginalEnv } from "./mastraEnv.js";',
      }).length,
    ).toBe(5);
  });

  it("apply の呼び出しは mastraEnv.ts の定義だけ（共有 pin への入口を export していない）", () => {
    const text = codeOf(
      fs.readFileSync(
        path.join(repoRoot, "electron/main/mastraEnv.ts"),
        "utf8",
      ),
    );
    expect([...text.matchAll(/\.apply\(/g)]).toEqual([]);
    expect(text).not.toMatch(/export\s+(?:const|let|function)\s+sharedPin/);
    expect(text).not.toMatch(/export\s*\{[^}]*sharedPin/);
    expect(
      [...text.matchAll(/export\s+function\s+(\w+)/g)].map((m) => m[1]),
    ).toEqual([
      "isMastraRemovedEnvName",
      "createMastraEnvPin",
      "mastraOriginalEnv",
      "mastraOriginalEnvValue",
    ]);
  });

  it("配線した箇所は process.env を直接読まない（ipc.ts は launch の env だけ、backend.ts は GRIMODEX_NODE_PATH を除く）", () => {
    const read = (rel: string) =>
      codeOf(fs.readFileSync(path.join(repoRoot, rel), "utf8"));
    for (const rel of [
      "electron/main/cliAi.ts",
      "electron/main/codexAppServer/process.ts",
      "electron/main/vivliostyle.ts",
      "electron/main/mcpSidecar.ts",
    ]) {
      expect(read(rel), rel).not.toMatch(/process\.env/);
      expect(read(rel), rel).toMatch(/mastraOriginalEnv/);
    }
    const backend = read("electron/main/backend.ts");
    expect(backend.match(/process\.env/g)).toHaveLength(1);
    expect(backend).toMatch(/process\.env\.GRIMODEX_NODE_PATH/);
    expect(backend.match(/= mastraOriginalEnv\(\)/g)).toHaveLength(2);
    expect(read("electron/main/ipc.ts")).toMatch(
      /isPackaged: false,\s*env: mastraOriginalEnv\(\)/,
    );
  });
});

describe("版を上げたときの drift の検知（計画書の第 11 節の 1）", () => {
  /**
   * apply の後に値が残ってよい、key や token でない無害な設定。理由のコメントを付けて、版を上げて
   * 新しい名前が増えたときだけ足す。増えた名前が秘密や宛先なら、ここへ足さず除く規則を直す。
   */
  const HARMLESS_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
    "NODE_ENV", // 実行モードの文字列。
    "PATH", // 実行 file の探索 path。
    "ProgramFiles", // Windows の Program Files の path（shell の探索）。
    "npm_package_version", // npm が置く自分の版数。
    "EMBED_BATCH_SIZE", // embedding の batch の件数（数値）。
    "NETLIFY_SITE_ID", // deployer の site id（識別子。token の NETLIFY_TOKEN は除かれる）。deployer は使わない。
  ]);

  const distJs = (pkg: string): string[] => {
    const dist = fs.realpathSync(
      path.join(repoRoot, "node_modules", "@mastra", pkg, "dist"),
    );
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.[cm]?js$/.test(entry.name)) files.push(full);
      }
    };
    walk(dist);
    return files;
  };

  /** dist が読む env 名を、`process.env.X`、`process.env["X"]`、`environmentVariableName: "X"`（loadApiKey／loadOptionalSetting）で拾う。 */
  const readEnvNames = (pkg: string): Set<string> => {
    const names = new Set<string>();
    for (const file of distJs(pkg)) {
      const text = fs.readFileSync(file, "utf8");
      for (const match of text.matchAll(
        /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[["']([A-Za-z_][A-Za-z0-9_]*)["']\])/g,
      )) {
        names.add(match[1] ?? match[2]);
      }
      for (const match of text.matchAll(
        /environmentVariableName\s*:\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
      )) {
        names.add(match[1]);
      }
    }
    return names;
  };

  it("拾う名前の抽出器が、dist の実物から名前を拾えている（0 件で通らない）", () => {
    const memory = readEnvNames("memory");
    const core = readEnvNames("core");
    // process.env.X、process.env["X"]、environmentVariableName の 3 つの形から、それぞれ拾えている。
    expect(memory).toContain("OM_DEBUG");
    expect(core).toContain("MASTRA_DEV");
    expect(core).toContain("NODE_ENV");
    expect(core).toContain("OPENAI_BASE_URL");
    expect(core.size).toBeGreaterThan(30);
  });

  it("@mastra/memory と @mastra/core の dist が読む env は、apply の後に値が残るのが、固定する 2 つと許可の一覧だけ（新しい名前が増えたら落ちる）", () => {
    const names = new Set([...readEnvNames("memory"), ...readEnvNames("core")]);
    const env: NodeJS.ProcessEnv = {};
    for (const name of names) env[name] = "dummy";
    createMastraEnvPin({ env, platform: "linux" }).apply();
    const remaining = Object.keys(env).filter(
      (name) =>
        !(name in MASTRA_PINNED_ENV) && !HARMLESS_ENV_ALLOWLIST.has(name),
    );
    expect(remaining).toEqual([]);
    // 許可の一覧は、実際に dist が読む名前だけ（読まなくなった名前が残らない）。
    for (const name of HARMLESS_ENV_ALLOWLIST) {
      expect(names.has(name), name).toBe(true);
    }
    // 計数が 3 社の key を引く表の名前は、全部が除かれる。
    const source = distJs("memory")
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");
    const table = source.match(/PROVIDER_API_KEY_ENV_VARS = \{([^}]*)\}/)?.[1];
    expect(table).toBeTruthy();
    for (const name of table!.match(/"[A-Z0-9_]+"/g) ?? []) {
      expect(isMastraRemovedEnvName(name.slice(1, -1), "linux")).toBe(true);
    }
  });

  it("許可リスト（Grimodex 自身の owner token）の名前を、@mastra の dist は読まない。GRIMODEX_ の名前も読まない（読むようになったら落ちる。DR-MP3-8）", () => {
    for (const pkg of ["core", "memory"]) {
      const names = readEnvNames(pkg);
      for (const name of MASTRA_ALLOWED_ENV_NAMES) {
        expect(names.has(name), `${pkg}: ${name}`).toBe(false);
      }
      expect(
        [...names].filter((name) => /^grimodex_/i.test(name)),
        pkg,
      ).toEqual([]);
    }
  });

  it("固定する 2 つの env 名を、@mastra/core の dist が今も参照している（名前が変わったら落ちる）", () => {
    const names = readEnvNames("core");
    for (const name of Object.keys(MASTRA_PINNED_ENV)) {
      expect(names.has(name), name).toBe(true);
    }
  });
});

/**
 * M13(a)：ダミー key を env に置き、固定なしでは Mastra の token 計数が provider の endpoint へ POST を試み、
 * 固定ありでは 0 件になることの対照走行（計画書の第 8.2 節）。
 *
 * - 実在の provider へは送らない。`fetch` を差し替え、3 社の host への呼び出しだけを loopback の模擬 server に
 *   向ける。それ以外の host は転送せず拒否する（元の URL へは決して転送しない）。
 * - 呼ぶのは OM が token 数を数えるために呼ぶ `TokenCounter.countMessagesAsync`（OM 全体は通していない）。
 *   画像は base64 の data URL（URL にすると M13(c) の GET の別系統になる）。
 * - 見積りは part と in-flight の map に cache されるので、arm ごとに新しい counter と新しい message を使う。
 */
describe("M13(a)：ダミー key の対照走行（loopback の模擬 server）", () => {
  const PROVIDER_HOSTS = new Set([
    "api.openai.com",
    "api.anthropic.com",
    "generativelanguage.googleapis.com",
  ]);
  const REMOTE_TOKENS = 4321;
  const DATA_URL =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const ARMS = [
    {
      provider: "openai",
      modelId: "gpt-4o",
      envName: "OPENAI_API_KEY",
      host: "api.openai.com",
      path: "/v1/responses/input_tokens",
      header: "authorization",
      keyHeader: (key: string) => `Bearer ${key}`,
    },
    {
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      envName: "ANTHROPIC_API_KEY",
      host: "api.anthropic.com",
      path: "/v1/messages/count_tokens",
      header: "x-api-key",
      keyHeader: (key: string) => key,
    },
    {
      provider: "google",
      modelId: "gemini-2.5-flash",
      envName: "GOOGLE_GENERATIVE_AI_API_KEY",
      host: "generativelanguage.googleapis.com",
      path: "/v1beta/models/gemini-2.5-flash:countTokens",
      header: "x-goog-api-key",
      keyHeader: (key: string) => key,
    },
    {
      provider: "google",
      modelId: "gemini-2.5-flash",
      envName: "GOOGLE_API_KEY",
      host: "generativelanguage.googleapis.com",
      path: "/v1beta/models/gemini-2.5-flash:countTokens",
      header: "x-goog-api-key",
      keyHeader: (key: string) => key,
    },
  ] as const;

  interface Attempt {
    method: string;
    host: string;
    path: string;
  }
  interface Received {
    method: string;
    path: string;
    originalHost: string | undefined;
    /** key の header がダミー key と一致したか（値そのものは記録しない）。 */
    keyMatches: boolean | undefined;
  }

  // arm ごとに process.env を元に戻す（固定を当てる arm が env を変えるため）。
  // 開発機に実 key があっても使わないよう、各 arm の前に key・token などの env を消す。
  let envSnapshot: NodeJS.ProcessEnv = {};
  const DUMMY_KEY = "dummy-m13a-not-a-real-key";
  const setEnv = (name: string, value: string) => {
    process.env[name] = value;
  };

  let server: Server;
  let port = 0;
  let received: Received[] = [];
  let attempts: Attempt[] = [];
  let restoreFetch: (() => void) | undefined;
  type Counter = {
    countMessagesAsync: (messages: never[]) => Promise<number>;
  };
  let makeCounter: (model: { provider: string; modelId: string }) => Counter;

  const installLoopbackFetch = () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      attempts.push({
        method: init?.method ?? "GET",
        host: url.host,
        path: url.pathname,
      });
      const isLoopback = url.hostname === "127.0.0.1";
      if (!isLoopback && !PROVIDER_HOSTS.has(url.hostname)) {
        throw new Error(`blocked non-loopback host: ${url.host}`);
      }
      // 3 社の host は loopback の模擬 server に付け替える。元の host は header で運ぶ。
      const target = isLoopback
        ? url
        : new URL(`http://127.0.0.1:${port}${url.pathname}${url.search}`);
      if (target.hostname !== "127.0.0.1" || target.port !== String(port)) {
        throw new Error(`refused to forward to ${target.host}`);
      }
      return original(target, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string> | undefined),
          "x-original-host": url.host,
        },
      });
    }) as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  };

  beforeAll(async () => {
    // fetch の差し替えは、@mastra/* を import するより前に行う（load 時に fetch を握られても捕捉できるように）。
    restoreFetch = installLoopbackFetch();
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const arm = ARMS.find((candidate) => candidate.path === req.url);
        received.push({
          method: req.method ?? "",
          path: req.url ?? "",
          originalHost: req.headers["x-original-host"] as string | undefined,
          keyMatches: arm
            ? req.headers[arm.header] === arm.keyHeader(DUMMY_KEY)
            : undefined,
        });
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            input_tokens: REMOTE_TOKENS,
            totalTokens: REMOTE_TOKENS,
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as AddressInfo).port;
    // 実在の Mastra を load する。
    const { TokenCounter } = await import("@mastra/memory/processors");
    makeCounter = (model) => new TokenCounter({ model }) as unknown as Counter;
  }, 60_000);

  afterAll(async () => {
    restoreFetch?.();
    restoreFetch = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const resetRun = () => {
    received = [];
    attempts = [];
  };

  beforeEach(() => {
    envSnapshot = { ...process.env };
    for (const name of Object.keys(process.env)) {
      if (isMastraRemovedEnvName(name)) delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of Object.keys(process.env)) {
      if (!(name in envSnapshot)) delete process.env[name];
    }
    for (const [name, value] of Object.entries(envSnapshot)) {
      if (value !== undefined) process.env[name] = value;
    }
  });

  /** arm ごとに新しい counter と新しい message で、画像 1 枚の token 数を数える。 */
  const count = async (provider: string, modelId: string) => {
    const message = {
      id: `m13a-${Math.random().toString(36).slice(2)}`,
      role: "user",
      createdAt: new Date(),
      content: {
        format: 2,
        parts: [{ type: "file", mimeType: "image/png", data: DATA_URL }],
      },
    };
    return makeCounter({ provider, modelId }).countMessagesAsync([
      message as never,
    ]);
  };
  const providerAttempts = () =>
    attempts.filter((attempt) => PROVIDER_HOSTS.has(attempt.host));

  it("hook の自己試験：3 社の host を捕捉して loopback に付け替え、他の host は転送せず拒否する", async () => {
    resetRun();
    const response = await fetch("https://api.openai.com/v1/self-test", {
      method: "POST",
    });
    expect(response.ok).toBe(true);
    expect(attempts).toEqual([
      { method: "POST", host: "api.openai.com", path: "/v1/self-test" },
    ]);
    expect(received).toHaveLength(1);
    expect(received[0].originalHost).toBe("api.openai.com");
    await expect(fetch("https://self-test.invalid/x")).rejects.toThrow(
      /blocked non-loopback host/,
    );
    expect(attempts.at(-1)?.host).toBe("self-test.invalid");
    expect(received).toHaveLength(1);
  });

  for (const arm of ARMS) {
    describe(`${arm.provider}（${arm.envName}）`, () => {
      it("固定なし：ダミー key があると POST を試み、key が模擬 server に届く", async () => {
        resetRun();
        setEnv(arm.envName, DUMMY_KEY);
        const total = await count(arm.provider, arm.modelId);
        expect(providerAttempts()).toEqual([
          { method: "POST", host: arm.host, path: arm.path },
        ]);
        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({
          method: "POST",
          path: arm.path,
          originalHost: arm.host,
          keyMatches: true,
        });
        // 模擬 server の数が計数に使われている（ローカルの見積りではない）。
        expect(total).toBeGreaterThanOrEqual(REMOTE_TOKENS);
      });

      it("固定あり：POST は 0 件、key は届かず、ローカルの見積りだけで数える。key を戻すと再び POST が出る", async () => {
        resetRun();
        setEnv(arm.envName, DUMMY_KEY);
        const pin = createMastraEnvPin();
        pin.apply();
        expect(process.env[arm.envName]).toBeUndefined();
        const pinnedTotal = await count(arm.provider, arm.modelId);
        expect(providerAttempts()).toEqual([]);
        expect(received).toEqual([]);
        expect(pinnedTotal).toBeLessThan(REMOTE_TOKENS);
        // 0 件が固定の効果であること：key だけ戻すと、同じ経路で POST が出る（cache のせいではない）。
        process.env[arm.envName] = DUMMY_KEY;
        const restoredTotal = await count(arm.provider, arm.modelId);
        expect(providerAttempts()).toHaveLength(1);
        expect(received).toHaveLength(1);
        expect(restoredTotal).toBeGreaterThanOrEqual(REMOTE_TOKENS);
        // 子 process 用の写しには、固定を当てる前の key が残っている。
        expect(pin.originalEnv()[arm.envName] === DUMMY_KEY).toBe(true);
      });
    });
  }

  it("provider 名が 3 社でなければ、固定なしでも POST しない（D3 の別の防御。M13(c) の別系統は data URL では出ない）", async () => {
    resetRun();
    setEnv("OPENAI_API_KEY", DUMMY_KEY);
    await count("grimodex-rust", "gpt-4o");
    expect(providerAttempts()).toEqual([]);
    expect(received).toEqual([]);
  });
});
