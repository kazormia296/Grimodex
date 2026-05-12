import type { AiPolicyPreset, AiPolicyToggles } from "./types";

type DefinedPreset = Exclude<AiPolicyPreset, "custom">;

const PRESET_TABLE: Record<DefinedPreset, AiPolicyToggles> = {
  full: { chat: true, bodyWrite: true, analysis: true },
  "assist-off": { chat: true, bodyWrite: false, analysis: true },
  "review-only": { chat: false, bodyWrite: false, analysis: true },
  off: { chat: false, bodyWrite: false, analysis: false },
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
      ref.analysis === toggles.analysis
    ) {
      return name;
    }
  }
  return "custom";
}
