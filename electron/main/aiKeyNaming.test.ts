/**
 * aiKeyNaming の parity テスト（Phase 3 バッチ3a）。node 環境。
 * service/account 命名と resolve 規則が Tauri（grimodex-ai の keyring_* /
 * commands::ai::resolve_api_key）と一致することを固定する。
 */
import { describe, expect, it } from "vitest";

import {
  effectiveProviderEndpoint,
  hasApiKey,
  keyringService,
  keyringUser,
  keyringUserCandidates,
  resolveApiKey,
  type KeyLookup,
} from "./aiKeyNaming.js";

/** 与えた (service,account)→key のマップから KeyLookup を作る。 */
function lookup(map: Record<string, string>): KeyLookup {
  return (service, account) => {
    const key = map[`${service}\x00${account}`];
    return key === undefined ? null : key;
  };
}

describe("keyringService", () => {
  it("provider ごとに Tauri と同一の service 名を返す", () => {
    expect(keyringService("openrouter")).toBe("grimodex-openrouter");
    expect(keyringService("openai")).toBe("grimodex-openai");
    expect(keyringService("anthropic")).toBe("grimodex-anthropic");
    expect(keyringService("ollama")).toBe("grimodex-ollama");
    expect(keyringService("openai-compatible")).toBe(
      "grimodex-openai-compatible",
    );
    expect(keyringService("sakana")).toBe("grimodex-sakana");
    expect(keyringService("ai-novelist")).toBe("grimodex-ai-novelist");
    expect(keyringService("cli")).toBe("grimodex-cli");
  });

  it("未知 provider は throw する", () => {
    expect(() => keyringService("bogus")).toThrow(/unknown AI provider/);
  });
});

describe("keyringUser / keyringUserCandidates", () => {
  it("OpenAI 互換のみ endpoint_id を account に使う", () => {
    expect(keyringUser("openai-compatible", "ep1")).toBe("ep1");
    expect(keyringUser("openai-compatible", null)).toBe("grimodex-user");
    expect(keyringUser("openai-compatible", "")).toBe("grimodex-user");
    expect(keyringUser("openai", "ep1")).toBe("grimodex-user");
  });

  it('"default" エンドポイントは legacy user へフォールバックする候補列を返す', () => {
    expect(keyringUserCandidates("openai-compatible", "default")).toEqual([
      "default",
      "grimodex-user",
    ]);
    expect(keyringUserCandidates("openai-compatible", "ep1")).toEqual(["ep1"]);
    expect(keyringUserCandidates("openai-compatible", null)).toEqual([
      "grimodex-user",
    ]);
    expect(keyringUserCandidates("openai", "ep1")).toEqual(["grimodex-user"]);
  });
});

describe("resolveApiKey", () => {
  it("Ollama / Cli は keyring に触れず空文字", () => {
    const getKey: KeyLookup = () => {
      throw new Error("should not be called");
    };
    expect(resolveApiKey("ollama", null, getKey)).toBe("");
    expect(resolveApiKey("cli", null, getKey)).toBe("");
  });

  it("必須プロバイダは見つかればキー、無ければ throw", () => {
    const found = lookup({ "grimodex-openai\x00grimodex-user": "sk-openai" });
    expect(resolveApiKey("openai", null, found)).toBe("sk-openai");
    expect(() => resolveApiKey("openai", null, lookup({}))).toThrow(
      "No API key configured for openai",
    );
  });

  it("OpenAI 互換は endpoint 単位で解決し、無ければ空文字（任意）", () => {
    const found = lookup({
      "grimodex-openai-compatible\x00ep1": "sk-ep1",
    });
    expect(resolveApiKey("openai-compatible", "ep1", found)).toBe("sk-ep1");
    // 未設定は空文字（throw しない）。
    expect(resolveApiKey("openai-compatible", "ep2", found)).toBe("");
  });

  it('"default" エンドポイントは legacy user のキーへフォールバックする', () => {
    const legacyOnly = lookup({
      "grimodex-openai-compatible\x00grimodex-user": "sk-legacy",
    });
    // "default" 自身のキーは無いが、legacy(grimodex-user) にあるので継続。
    expect(resolveApiKey("openai-compatible", "default", legacyOnly)).toBe(
      "sk-legacy",
    );
  });
});

describe("hasApiKey", () => {
  it("候補のいずれかに在れば true", () => {
    const legacyOnly = lookup({
      "grimodex-openai-compatible\x00grimodex-user": "sk",
    });
    expect(hasApiKey("openai-compatible", "default", legacyOnly)).toBe(true);
    expect(hasApiKey("openai-compatible", "ep1", legacyOnly)).toBe(false);
    expect(hasApiKey("openai", null, lookup({}))).toBe(false);
    expect(
      hasApiKey(
        "openai",
        null,
        lookup({ "grimodex-openai\x00grimodex-user": "k" }),
      ),
    ).toBe(true);
  });
});

describe("effectiveProviderEndpoint", () => {
  const settings = {
    provider: "openai",
    openaiCompatibleEndpoints: [{ id: "known" }, { id: "default" }],
    activeOpenaiCompatibleEndpointId: "default",
  };

  it("引数 provider override が優先、無ければ設定の既定", () => {
    expect(
      effectiveProviderEndpoint(settings, "anthropic", null).provider,
    ).toBe("anthropic");
    expect(effectiveProviderEndpoint(settings, undefined, null).provider).toBe(
      "openai",
    );
    expect(effectiveProviderEndpoint(settings, "", null).provider).toBe(
      "openai",
    );
  });

  it("既知 endpoint override のみ採用、未知は設定 active を据え置き", () => {
    expect(
      effectiveProviderEndpoint(settings, undefined, "known").endpointId,
    ).toBe("known");
    // 未知 id は無言リターゲットせず active("default")を維持。
    expect(
      effectiveProviderEndpoint(settings, undefined, "ghost").endpointId,
    ).toBe("default");
    // 引数省略は設定 active。
    expect(
      effectiveProviderEndpoint(settings, undefined, undefined).endpointId,
    ).toBe("default");
  });
});
