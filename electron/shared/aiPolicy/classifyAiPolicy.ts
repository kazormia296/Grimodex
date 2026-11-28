/**
 * `projects.ai_policy` の分類。grimodex-core の `parse_policy_json` と同じ規則
 * （docs/plans/a4-ai-policy-fail-closed-decisions.md の DR-A4-1）。renderer も使うので
 * 依存を持たない。
 */
export type AiPolicyClassification = {
  state: "valid" | "missing" | "invalid";
  toggles: {
    chat: boolean;
    bodyWrite: boolean;
    analysis: boolean;
    structureWrite: boolean;
    knowledgeWrite: boolean;
  };
};

const PRESET_OPTIONAL_TOGGLES: Record<
  string,
  Pick<AiPolicyClassification["toggles"], "structureWrite" | "knowledgeWrite">
> = {
  full: { structureWrite: true, knowledgeWrite: true },
  "assist-off": { structureWrite: true, knowledgeWrite: true },
  "review-only": { structureWrite: false, knowledgeWrite: false },
  off: { structureWrite: false, knowledgeWrite: false },
  custom: { structureWrite: false, knowledgeWrite: false },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 書き込みの 3 軸は不可。会話と分析は、読めた `false` を可にしないために、
 * 必須の 3 欄がそろう値では `Boolean()` の値を渡す。
 */
function invalidPolicy(chat = true, analysis = true): AiPolicyClassification {
  return {
    state: "invalid",
    toggles: {
      chat,
      bodyWrite: false,
      analysis,
      structureWrite: false,
      knowledgeWrite: false,
    },
  };
}

export function classifyAiPolicy(raw: unknown): AiPolicyClassification {
  if (raw === null) {
    return {
      state: "missing",
      toggles: {
        chat: true,
        bodyWrite: true,
        analysis: true,
        structureWrite: false,
        knowledgeWrite: false,
      },
    };
  }
  if (typeof raw !== "string") return invalidPolicy();

  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      !Object.hasOwn(parsed, "preset") ||
      typeof parsed.preset !== "string" ||
      !Object.hasOwn(PRESET_OPTIONAL_TOGGLES, parsed.preset)
    ) {
      return invalidPolicy();
    }
    const presetDefaults = PRESET_OPTIONAL_TOGGLES[parsed.preset];
    if (
      presetDefaults === undefined ||
      !Object.hasOwn(parsed, "toggles") ||
      !isRecord(parsed.toggles)
    ) {
      return invalidPolicy();
    }

    const toggles = parsed.toggles;
    if (
      !Object.hasOwn(toggles, "chat") ||
      !Object.hasOwn(toggles, "bodyWrite") ||
      !Object.hasOwn(toggles, "analysis")
    ) {
      return invalidPolicy();
    }
    const { chat, bodyWrite, analysis } = toggles;
    const invalidRequiredToggle = invalidPolicy(
      Boolean(chat),
      Boolean(analysis),
    );
    if (
      typeof chat !== "boolean" ||
      typeof bodyWrite !== "boolean" ||
      typeof analysis !== "boolean"
    ) {
      return invalidRequiredToggle;
    }

    const structureWrite = Object.hasOwn(toggles, "structureWrite")
      ? toggles.structureWrite
      : presetDefaults.structureWrite;
    const knowledgeWrite = Object.hasOwn(toggles, "knowledgeWrite")
      ? toggles.knowledgeWrite
      : presetDefaults.knowledgeWrite;
    if (
      typeof structureWrite !== "boolean" ||
      typeof knowledgeWrite !== "boolean"
    ) {
      return invalidRequiredToggle;
    }

    return {
      state: "valid",
      toggles: { chat, bodyWrite, analysis, structureWrite, knowledgeWrite },
    };
  } catch {
    return invalidPolicy();
  }
}
