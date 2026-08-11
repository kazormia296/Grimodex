import { describe, it, expect } from "vitest";
import {
  MODEL_ROLES,
  PATH_TO_ROLE,
  MODEL_ROUTING_EXCLUDED,
  resolveRoleModel,
  resolveModelForPath,
  resolveRolePathConfig,
  isModelCapableForRole,
  roleSettingKey,
  ROLE_PROVIDERS_KEY,
  parseRoleProviders,
  resolveRoleSendOverride,
  sameProviderRoleModelKeys,
} from "./modelRouting";
import {
  AI_PATHS,
  GENERATION_LAYERS,
} from "@/features/ai-verification/aiPathRegistry";
import {
  __resetDynamicModelCapsForTests,
  registerDynamicModelCaps,
} from "./agent/dynamicModelCaps";

const emptyGetter = () => "";
const getterFor =
  (map: Record<string, string>) =>
  (k: string): string =>
    map[k] ?? "";

describe("resolveModelForPath — 空=既定フォールバック (byte-identical)", () => {
  it("ロール未設定なら全経路 undefined を返す（wire 差分ゼロ）", () => {
    for (const pathId of Object.keys(PATH_TO_ROLE)) {
      expect(resolveModelForPath(pathId, emptyGetter)).toBeUndefined();
    }
  });

  it("対象外・未知の経路は undefined", () => {
    for (const pathId of MODEL_ROUTING_EXCLUDED) {
      expect(resolveModelForPath(pathId, emptyGetter)).toBeUndefined();
    }
    expect(resolveModelForPath("does_not_exist", emptyGetter)).toBeUndefined();
  });
});

describe("resolveModelForPath — ロール設定時", () => {
  it("ロールに設定したモデルを同ロールの全経路へ反映する", () => {
    const getter = getterFor({ [roleSettingKey("structured")]: "gpt-4o" });
    expect(resolveModelForPath("synopsis", getter)).toBe("gpt-4o");
    expect(resolveModelForPath("foreshadow_audit_chapter", getter)).toBe(
      "gpt-4o",
    );
    expect(resolveModelForPath("tree_scaffold", getter)).toBe("gpt-4o");
    expect(resolveModelForPath("narrative_entity_resolve", getter)).toBe(
      "gpt-4o",
    );
    expect(resolveModelForPath("codex_judgment", getter)).toBe("gpt-4o");
    // 別ロールは影響を受けない
    expect(resolveModelForPath("session_title", getter)).toBeUndefined();
  });

  it("空白のみのロール値は未設定扱い", () => {
    const getter = getterFor({ [roleSettingKey("cheap")]: "   " });
    expect(resolveModelForPath("session_title", getter)).toBeUndefined();
  });

  it("resolveRoleModel は trim して空なら undefined", () => {
    expect(resolveRoleModel("inline", () => "  ")).toBeUndefined();
    expect(resolveRoleModel("inline", () => "gpt-4o-mini")).toBe("gpt-4o-mini");
  });
});

describe("能力ガード — agent ロールは tool 対応必須", () => {
  it("tool 非対応モデル(deepseek-r1)を agent ロールに指定しても override を無視し undefined", () => {
    const getter = getterFor({ [roleSettingKey("agent")]: "deepseek-r1" });
    expect(resolveModelForPath("chat_agent_main", getter)).toBeUndefined();
    expect(resolveModelForPath("context_creator", getter)).toBeUndefined();
  });

  it("tool 対応モデルは agent ロールで通る", () => {
    const getter = getterFor({ [roleSettingKey("agent")]: "claude-opus-4-8" });
    expect(resolveModelForPath("chat_agent_main", getter)).toBe(
      "claude-opus-4-8",
    );
  });

  it("cheap/inline/conversation は tool 非対応モデルでも通る（構造化ゲート対象外）", () => {
    const getter = getterFor({ [roleSettingKey("cheap")]: "deepseek-r1" });
    expect(resolveModelForPath("session_title", getter)).toBe("deepseek-r1");
  });

  it("isModelCapableForRole の単体契約", () => {
    expect(isModelCapableForRole("deepseek-r1", "agent")).toBe(false);
    expect(isModelCapableForRole("claude-opus-4-8", "agent")).toBe(true);
    expect(isModelCapableForRole("deepseek-r1", "cheap")).toBe(true);
  });
});

describe("能力ガード — structured/review ロールは構造化JSON対応必須 (Phase 2)", () => {
  it("supportsStructuredJson=false のモデル(deepseek-r1)を structured ロールに指定しても override を無視し undefined", () => {
    const getter = getterFor({ [roleSettingKey("structured")]: "deepseek-r1" });
    expect(resolveModelForPath("synopsis", getter)).toBeUndefined();
    expect(resolveModelForPath("tree_scaffold", getter)).toBeUndefined();
  });

  it("review ロールも構造化JSON非対応モデルを無視する", () => {
    const getter = getterFor({ [roleSettingKey("review")]: "deepseek-r1" });
    expect(resolveModelForPath("post_effect_review", getter)).toBeUndefined();
    expect(
      resolveModelForPath("post_effect_consistency", getter),
    ).toBeUndefined();
  });

  it("構造化JSON対応モデルは structured/review で通る（absent⇒true 既定）", () => {
    const sGetter = getterFor({ [roleSettingKey("structured")]: "gpt-4o" });
    expect(resolveModelForPath("synopsis", sGetter)).toBe("gpt-4o");
    const rGetter = getterFor({
      [roleSettingKey("review")]: "claude-opus-4-8",
    });
    expect(resolveModelForPath("post_effect_review", rGetter)).toBe(
      "claude-opus-4-8",
    );
  });

  it("isModelCapableForRole の structured/review 契約", () => {
    expect(isModelCapableForRole("deepseek-r1", "structured")).toBe(false);
    expect(isModelCapableForRole("deepseek-r1", "review")).toBe(false);
    expect(isModelCapableForRole("deepseek-r1", "reader")).toBe(false);
    expect(isModelCapableForRole("gpt-4o", "structured")).toBe(true);
    expect(isModelCapableForRole("claude-opus-4-8", "review")).toBe(true);
  });

  it("擬似コメントは校閲レビューと別の reader ロールへ解決される", () => {
    const getter = getterFor({
      [roleSettingKey("reader")]: "reader-model",
    });
    expect(PATH_TO_ROLE.post_effect_pseudo_comment).toBe("reader");
    expect(resolveModelForPath("post_effect_pseudo_comment", getter)).toBe(
      "reader-model",
    );
  });
});

describe("resolveRolePathConfig — プロバイダ横断", () => {
  it("roleProviders 未設定なら model のみ（provider/endpoint/variant なし=後方互換）", () => {
    const getter = getterFor({ [roleSettingKey("conversation")]: "gpt-4o" });
    expect(resolveRolePathConfig("chat_stream_non_agent", getter)).toEqual({
      model: "gpt-4o",
    });
  });

  it("ロールに別プロバイダを割り当てると provider 付き override を返す", () => {
    const getter = getterFor({
      [roleSettingKey("conversation")]: "openai/gpt-4o",
      [ROLE_PROVIDERS_KEY]: JSON.stringify({
        conversation: { provider: "openrouter" },
      }),
    });
    expect(resolveRolePathConfig("chat_stream_non_agent", getter)).toEqual({
      model: "openai/gpt-4o",
      provider: "openrouter",
      endpointId: undefined,
      // openrouter は overrideApiVariantForProvider=null → variant 未指定
      variant: undefined,
    });
  });

  it("sakana 割り当ては variant=responses を導出する（composer と同則）", () => {
    const getter = getterFor({
      [roleSettingKey("agent")]: "fugu",
      [ROLE_PROVIDERS_KEY]: JSON.stringify({ agent: { provider: "sakana" } }),
    });
    const cfg = resolveRolePathConfig("chat_agent_main", getter);
    expect(cfg?.provider).toBe("sakana");
    expect(cfg?.variant).toBe("responses");
  });

  it("openai-compatible は endpointId を引き継ぎ variant は持たせない（Rust 側 endpoint 既定で解決）", () => {
    const getter = getterFor({
      [roleSettingKey("structured")]: "plamo-3.0-prime",
      [ROLE_PROVIDERS_KEY]: JSON.stringify({
        structured: { provider: "openai-compatible", endpointId: "plamo" },
      }),
    });
    expect(resolveRolePathConfig("synopsis", getter)).toEqual({
      model: "plamo-3.0-prime",
      provider: "openai-compatible",
      endpointId: "plamo",
      variant: undefined,
    });
  });

  it("能力ガードはプロバイダ横断でも効く（agent×tool非対応→override無視で undefined）", () => {
    const getter = getterFor({
      [roleSettingKey("agent")]: "deepseek-r1",
      [ROLE_PROVIDERS_KEY]: JSON.stringify({
        agent: { provider: "openrouter" },
      }),
    });
    expect(resolveRolePathConfig("chat_agent_main", getter)).toBeUndefined();
  });

  it("provider-scoped Ollama capability rejects a same-named no-tools role model", () => {
    __resetDynamicModelCapsForTests();
    registerDynamicModelCaps("openrouter", [
      {
        id: "shared:latest",
        name: "OpenRouter shared",
        supportedParameters: ["tools"],
      },
    ]);
    registerDynamicModelCaps("ollama", [
      {
        id: "shared:latest",
        name: "Ollama shared",
        supportedParameters: [],
      },
    ]);
    const getter = getterFor({
      [roleSettingKey("agent")]: "shared:latest",
      [ROLE_PROVIDERS_KEY]: JSON.stringify({
        agent: { provider: "ollama" },
      }),
    });

    expect(resolveRolePathConfig("chat_agent_main", getter)).toBeUndefined();
    expect(isModelCapableForRole("shared:latest", "agent", "openrouter")).toBe(
      true,
    );
    __resetDynamicModelCapsForTests();
  });

  it("uses the active provider scope for a providerless Agent role", () => {
    __resetDynamicModelCapsForTests();
    registerDynamicModelCaps("ollama", [
      {
        id: "local-role:latest",
        name: "Local role",
        supportedParameters: [],
      },
    ]);
    const getter = getterFor({
      [roleSettingKey("agent")]: "local-role:latest",
    });

    expect(
      resolveRolePathConfig("chat_agent_main", getter, "ollama"),
    ).toBeUndefined();
    expect(
      resolveRoleSendOverride("context_creator", getter, "ollama"),
    ).toEqual({
      model: null,
      provider: null,
      apiVariant: null,
      endpointId: null,
    });
    __resetDynamicModelCapsForTests();
  });

  it("provider 空文字はオーバーライド扱いしない（active provider 据え置き）", () => {
    const getter = getterFor({
      [roleSettingKey("inline")]: "gpt-4o-mini",
      [ROLE_PROVIDERS_KEY]: JSON.stringify({
        inline: { provider: "  ", endpointId: "x" },
      }),
    });
    expect(resolveRolePathConfig("inline_ai_stream", getter)).toEqual({
      model: "gpt-4o-mini",
    });
  });

  it("resolveModelForPath は provider 設定時も model のみ返す（後方互換ラッパ）", () => {
    const getter = getterFor({
      [roleSettingKey("conversation")]: "openai/gpt-4o",
      [ROLE_PROVIDERS_KEY]: JSON.stringify({
        conversation: { provider: "openrouter" },
      }),
    });
    expect(resolveModelForPath("chat_stream_non_agent", getter)).toBe(
      "openai/gpt-4o",
    );
  });

  it("parseRoleProviders は不正 JSON を空マップに丸める", () => {
    expect(parseRoleProviders("")).toEqual({});
    expect(parseRoleProviders("not json")).toEqual({});
    expect(parseRoleProviders("null")).toEqual({});
    expect(parseRoleProviders('{"agent":{"provider":"openai"}}')).toEqual({
      agent: { provider: "openai" },
    });
  });
});

describe("parseRoleProviders — 不正な内部値の型ガード（破損/旧スキーマ防御）", () => {
  it("provider が非文字列のエントリは捨てる（resolve 時 .trim() TypeError 防止）", () => {
    expect(parseRoleProviders('{"agent":{"provider":123}}')).toEqual({});
    expect(parseRoleProviders('{"agent":{"provider":{"x":1}}}')).toEqual({});
    expect(parseRoleProviders('{"agent":{"provider":["openai"]}}')).toEqual({});
  });

  it("トップレベル配列・内部配列は弾く", () => {
    expect(parseRoleProviders("[]")).toEqual({});
    expect(parseRoleProviders('{"agent":[]}')).toEqual({});
  });

  it("endpointId のみ文字列なら保持（provider 無しは resolve で無視される）", () => {
    expect(parseRoleProviders('{"agent":{"endpointId":"e"}}')).toEqual({
      agent: { endpointId: "e" },
    });
  });

  it("endpointId が非文字列なら provider だけ残す", () => {
    expect(
      parseRoleProviders('{"agent":{"provider":"openai","endpointId":5}}'),
    ).toEqual({ agent: { provider: "openai" } });
  });
});

describe("sameProviderRoleModelKeys — アクティブプロバイダ切替時のクリア対象", () => {
  it("roleProviders が空なら全ロールのモデルキーが対象", () => {
    expect(sameProviderRoleModelKeys("")).toEqual(
      MODEL_ROLES.map((r) => roleSettingKey(r)),
    );
  });

  it("明示的な provider 割り当てのあるロールは対象外（宛先が固定）", () => {
    const raw = JSON.stringify({ review: { provider: "anthropic" } });
    const keys = sameProviderRoleModelKeys(raw);
    expect(keys).not.toContain(roleSettingKey("review"));
    expect(keys).toContain(roleSettingKey("conversation"));
  });

  it("endpointId だけのエントリ（provider 無し）は active 追従なので対象", () => {
    const raw = JSON.stringify({ review: { endpointId: "e1" } });
    expect(sameProviderRoleModelKeys(raw)).toContain(roleSettingKey("review"));
  });

  it("破損 JSON は空マップ扱い＝全ロール対象（安全側）", () => {
    expect(sameProviderRoleModelKeys("{broken")).toEqual(
      MODEL_ROLES.map((r) => roleSettingKey(r)),
    );
  });
});

describe("resolveRoleSendOverride — invoke 4 引数への展開", () => {
  it("未設定ロールは provider/apiVariant/endpointId が null（active・byte-identical）", () => {
    const getter = getterFor({ [roleSettingKey("structured")]: "gpt-4o" });
    expect(resolveRoleSendOverride("synopsis", getter)).toEqual({
      model: "gpt-4o",
      provider: null,
      apiVariant: null,
      endpointId: null,
    });
  });

  it("ロール未割当（model も無し）は全 null", () => {
    expect(resolveRoleSendOverride("synopsis", emptyGetter)).toEqual({
      model: null,
      provider: null,
      apiVariant: null,
      endpointId: null,
    });
  });

  it("別プロバイダ割当を model/provider/apiVariant/endpointId へ展開", () => {
    const getter = getterFor({
      [roleSettingKey("structured")]: "plamo-3.0-prime",
      [ROLE_PROVIDERS_KEY]: JSON.stringify({
        structured: { provider: "openai-compatible", endpointId: "plamo" },
      }),
    });
    expect(resolveRoleSendOverride("synopsis", getter)).toEqual({
      model: "plamo-3.0-prime",
      provider: "openai-compatible",
      apiVariant: null,
      endpointId: "plamo",
    });
  });

  it("sakana 割当は apiVariant=responses を導出する", () => {
    const getter = getterFor({
      [roleSettingKey("agent")]: "fugu",
      [ROLE_PROVIDERS_KEY]: JSON.stringify({ agent: { provider: "sakana" } }),
    });
    const ov = resolveRoleSendOverride("chat_agent_main", getter);
    expect(ov.provider).toBe("sakana");
    expect(ov.apiVariant).toBe("responses");
  });

  it("能力不適合（agent×非tool）は全 null（override 無視で active へ）", () => {
    const getter = getterFor({
      [roleSettingKey("agent")]: "deepseek-r1",
      [ROLE_PROVIDERS_KEY]: JSON.stringify({
        agent: { provider: "openrouter" },
      }),
    });
    expect(resolveRoleSendOverride("chat_agent_main", getter)).toEqual({
      model: null,
      provider: null,
      apiVariant: null,
      endpointId: null,
    });
  });
});

describe("PATH_TO_ROLE 完全性メタテスト (aiPathRegistry と同期)", () => {
  it("全 generation-layer 経路は role か excluded のどちらか一方に必ず属する", () => {
    const genPaths = AI_PATHS.filter((p) =>
      GENERATION_LAYERS.includes(p.layer),
    );
    for (const p of genPaths) {
      const mapped = p.id in PATH_TO_ROLE;
      const excluded = MODEL_ROUTING_EXCLUDED.includes(p.id);
      expect(
        mapped !== excluded,
        `${p.id} (${p.layer}) は role/excluded のどちらか一方に属すること`,
      ).toBe(true);
    }
  });

  it("PATH_TO_ROLE / EXCLUDED は registry に存在する id のみを含む", () => {
    const knownIds = new Set(AI_PATHS.map((p) => p.id));
    for (const id of Object.keys(PATH_TO_ROLE)) {
      expect(knownIds.has(id), `${id} は AI_PATHS に存在すること`).toBe(true);
    }
    for (const id of MODEL_ROUTING_EXCLUDED) {
      expect(knownIds.has(id), `${id} は AI_PATHS に存在すること`).toBe(true);
    }
  });

  it("全ロール値は MODEL_ROLES の一員", () => {
    for (const role of Object.values(PATH_TO_ROLE)) {
      expect(MODEL_ROLES).toContain(role);
    }
  });
});
