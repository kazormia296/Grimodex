import type { AiPolicyPreset, AiPolicyToggles } from "./types";

type DefinedPreset = Exclude<AiPolicyPreset, "custom">;

const PRESET_TABLE: Record<DefinedPreset, AiPolicyToggles> = {
  // structureWrite(案B): 「本文代筆」ではなく構造 scaffold/再編なので、
  // 本文を禁じる assist-off でも ON、analysis のみ/全停止では OFF。
  full: { chat: true, bodyWrite: true, analysis: true, structureWrite: true },
  "assist-off": {
    chat: true,
    bodyWrite: false,
    analysis: true,
    structureWrite: true,
  },
  "review-only": {
    chat: false,
    bodyWrite: false,
    analysis: true,
    structureWrite: false,
  },
  off: {
    chat: false,
    bodyWrite: false,
    analysis: false,
    structureWrite: false,
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
      ref.structureWrite === toggles.structureWrite
    ) {
      return name;
    }
  }
  return "custom";
}
