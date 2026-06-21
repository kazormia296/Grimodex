import { describe, it, expect } from "vitest";
import {
  MODEL_ROLES,
  PATH_TO_ROLE,
  MODEL_ROUTING_EXCLUDED,
  resolveRoleModel,
  resolveModelForPath,
  isModelCapableForRole,
  roleSettingKey,
} from "./modelRouting";
import {
  AI_PATHS,
  GENERATION_LAYERS,
} from "@/features/ai-verification/aiPathRegistry";

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
    expect(isModelCapableForRole("gpt-4o", "structured")).toBe(true);
    expect(isModelCapableForRole("claude-opus-4-8", "review")).toBe(true);
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
