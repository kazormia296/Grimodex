import type { AiPolicyPreset, AiPolicyToggles } from "./types";

type DefinedPreset = Exclude<AiPolicyPreset, "custom">;

const PRESET_TABLE: Record<DefinedPreset, AiPolicyToggles> = {
  // structureWrite(案B): 「本文代筆」ではなく構造 scaffold/再編なので、
  // 本文を禁じる assist-off でも ON、analysis のみ/全停止では OFF。
  // knowledgeWrite: Codex/Snippet 自律書き込み。structureWrite とは別軸。
  full: {
    chat: true,
    bodyWrite: true,
    analysis: true,
    structureWrite: true,
    knowledgeWrite: true,
  },
  "assist-off": {
    chat: true,
    bodyWrite: false,
    analysis: true,
    structureWrite: true,
    knowledgeWrite: true,
  },
  "review-only": {
    chat: false,
    bodyWrite: false,
    analysis: true,
    structureWrite: false,
    knowledgeWrite: false,
  },
  off: {
    chat: false,
    bodyWrite: false,
    analysis: false,
    structureWrite: false,
    knowledgeWrite: false,
  },
};

export function expandPreset(preset: AiPolicyPreset): AiPolicyToggles {
  if (preset === "custom") return { ...PRESET_TABLE.full };
  return { ...PRESET_TABLE[preset] };
}

export function inferPreset(toggles: AiPolicyToggles): AiPolicyPreset {
  for (const [name, ref] of Object.entries(PRESET_TABLE) as [
    DefinedPreset,
    AiPolicyToggles,
  ][]) {
    if (
      ref.chat === toggles.chat &&
      ref.bodyWrite === toggles.bodyWrite &&
      ref.analysis === toggles.analysis &&
      ref.structureWrite === toggles.structureWrite &&
      ref.knowledgeWrite === toggles.knowledgeWrite
    ) {
      return name;
    }
  }
  return "custom";
}
