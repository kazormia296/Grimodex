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
} from "vitest";

import {
  MASTRA_PINNED_ENV,
  MASTRA_REMOVED_ENV_NAMES,
  createMastraEnvPin,
  isMastraRemovedEnvName,
} from "./mastraEnv.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

describe("mastraEnv（env の固定。MP-1 では未配線）", () => {
  it("固定する値は厳密に MASTRA_TELEMETRY_DISABLED=1 と MASTRA_OFFLINE=true", () => {
    expect(MASTRA_PINNED_ENV).toEqual({
      MASTRA_TELEMETRY_DISABLED: "1",
      MASTRA_OFFLINE: "true",
    });
    expect(Object.isFrozen(MASTRA_PINNED_ENV)).toBe(true);
  });

  it("除く名前：MASTRA_* の全部と、OM_*・VERCEL_OIDC_TOKEN・3 社の API key だけ（Windows は大文字小文字を区別しない）", () => {
    for (const name of [
      "MASTRA_DEV",
      "MASTRA_AUTO_REFRESH_PROVIDERS",
      "MASTRA_LICENSE_KEY",
      "MASTRA_EE_LICENSE",
      "MASTRA_GATEWAY_API_KEY",
      "MASTRA_TELEMETRY_DISABLED",
      "OM_DEBUG",
      "OM_REPRO_CAPTURE",
      "OM_REPRO_CAPTURE_DIR",
      "VERCEL_OIDC_TOKEN",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "GOOGLE_API_KEY",
    ]) {
      expect(isMastraRemovedEnvName(name, "linux"), name).toBe(true);
    }
    for (const name of [
      "PATH",
      "HOME",
      "ANTHROPIC_AUTH_TOKEN",
      "OPENROUTER_API_KEY",
      "OM_OTHER",
      "NOT_MASTRA_DEV",
      "openai_api_key",
      "mastra_dev",
    ]) {
      expect(isMastraRemovedEnvName(name, "linux"), name).toBe(false);
    }
    expect(isMastraRemovedEnvName("openai_api_key", "win32")).toBe(true);
    expect(isMastraRemovedEnvName("Mastra_Dev", "win32")).toBe(true);
    expect(isMastraRemovedEnvName("Path", "win32")).toBe(false);
  });

  it("apply は除く env を消して 2 値を固定し、他の env には触れない（値は結果に残さない）", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/home/u",
      ANTHROPIC_AUTH_TOKEN: "keep-me",
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
      ANTHROPIC_AUTH_TOKEN: "keep-me",
      MASTRA_TELEMETRY_DISABLED: "1",
      MASTRA_OFFLINE: "true",
    });
    expect(result.removed).toEqual(
      [
        "ANTHROPIC_API_KEY",
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

describe("版を上げたときの drift の検知（計画書の第 11 節の 1）", () => {
  const readDistJs = (pkg: string): string[] => {
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

  it("@mastra/memory の dist が読む env は、全部が除く一覧に入っている（新しい env が増えたら落ちる）", () => {
    const names = new Set<string>();
    for (const file of readDistJs("memory")) {
      const text = fs.readFileSync(file, "utf8");
      for (const match of text.matchAll(
        /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[["']([A-Za-z_][A-Za-z0-9_]*)["']\])/g,
      )) {
        names.add(match[1] ?? match[2]);
      }
    }
    expect([...names].length).toBeGreaterThan(0);
    for (const name of names) {
      expect(isMastraRemovedEnvName(name, "linux"), name).toBe(true);
    }
    // 計数が 3 社の key を引く表も、除く一覧に入っている。
    const source = readDistJs("memory")
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");
    const table = source.match(/PROVIDER_API_KEY_ENV_VARS = \{([^}]*)\}/)?.[1];
    expect(table).toBeTruthy();
    for (const name of table!.match(/"[A-Z0-9_]+"/g) ?? []) {
      expect(MASTRA_REMOVED_ENV_NAMES).toContain(name.slice(1, -1));
    }
  });

  it("固定する 2 つの env 名を、@mastra/core の dist が今も参照している（名前が変わったら落ちる）", () => {
    const text = readDistJs("core")
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");
    for (const name of Object.keys(MASTRA_PINNED_ENV)) {
      expect(text, name).toContain(name);
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
    keyHeader: string | undefined;
  }

  // arm ごとに process.env を元に戻す（固定を当てる arm が env を変えるため）。
  let envSnapshot: NodeJS.ProcessEnv = {};
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
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const arm = ARMS.find((candidate) => candidate.path === req.url);
        received.push({
          method: req.method ?? "",
          path: req.url ?? "",
          originalHost: req.headers["x-original-host"] as string | undefined,
          keyHeader: arm
            ? (req.headers[arm.header] as string | undefined)
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
    // 実在の Mastra を load する（env を読むのは呼出し時なので、load の順序は結果に影響しない）。
    const { TokenCounter } = await import("@mastra/memory/processors");
    makeCounter = (model) => new TokenCounter({ model }) as unknown as Counter;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const resetRun = () => {
    received = [];
    attempts = [];
    restoreFetch?.();
    restoreFetch = installLoopbackFetch();
  };

  beforeEach(() => {
    envSnapshot = { ...process.env };
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
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
        setEnv(arm.envName, "dummy-m13a-not-a-real-key");
        const total = await count(arm.provider, arm.modelId);
        expect(providerAttempts()).toEqual([
          { method: "POST", host: arm.host, path: arm.path },
        ]);
        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({
          method: "POST",
          path: arm.path,
          originalHost: arm.host,
          keyHeader: arm.keyHeader("dummy-m13a-not-a-real-key"),
        });
        // 模擬 server の数が計数に使われている（ローカルの見積りではない）。
        expect(total).toBeGreaterThanOrEqual(REMOTE_TOKENS);
      });

      it("固定あり：POST は 0 件、key は届かず、ローカルの見積りだけで数える。key を戻すと再び POST が出る", async () => {
        resetRun();
        setEnv(arm.envName, "dummy-m13a-not-a-real-key");
        const pin = createMastraEnvPin();
        pin.apply();
        expect(process.env[arm.envName]).toBeUndefined();
        const pinnedTotal = await count(arm.provider, arm.modelId);
        expect(providerAttempts()).toEqual([]);
        expect(received).toEqual([]);
        expect(pinnedTotal).toBeLessThan(REMOTE_TOKENS);
        // 0 件が固定の効果であること：key だけ戻すと、同じ経路で POST が出る（cache のせいではない）。
        process.env[arm.envName] = "dummy-m13a-not-a-real-key";
        const restoredTotal = await count(arm.provider, arm.modelId);
        expect(providerAttempts()).toHaveLength(1);
        expect(received).toHaveLength(1);
        expect(restoredTotal).toBeGreaterThanOrEqual(REMOTE_TOKENS);
        // 子 process 用の写しには、固定を当てる前の key が残っている。
        expect(pin.originalEnv()[arm.envName]).toBe(
          "dummy-m13a-not-a-real-key",
        );
      });
    });
  }

  it("provider 名が 3 社でなければ、固定なしでも POST しない（D3 の別の防御。M13(c) の別系統は data URL では出ない）", async () => {
    resetRun();
    setEnv("OPENAI_API_KEY", "dummy-m13a-not-a-real-key");
    await count("grimodex-rust", "gpt-4o");
    expect(providerAttempts()).toEqual([]);
    expect(received).toEqual([]);
  });
});
