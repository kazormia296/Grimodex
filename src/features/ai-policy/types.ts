export type AiFeature = "chat" | "bodyWrite" | "analysis" | "structureWrite";

export type AiPolicyPreset =
  | "full"
  | "assist-off"
  | "review-only"
  | "off"
  | "custom";

export interface AiPolicyToggles {
  chat: boolean;
  bodyWrite: boolean;
  analysis: boolean;
  /** AI による章/シーン/フォルダ構造の scaffold・再編 (案B)。本文代筆 bodyWrite とは別軸。 */
  structureWrite: boolean;
}

export interface AiPolicy {
  preset: AiPolicyPreset;
  toggles: AiPolicyToggles;
}

export type AiCapability =
  | { state: "pending" }
  | { state: "enabled" }
  | { state: "disabled"; reason: "policy" | "no-provider" | "no-model" };

export const DEFAULT_AI_POLICY: AiPolicy = {
  preset: "full",
  toggles: {
    chat: true,
    bodyWrite: true,
    analysis: true,
    structureWrite: true,
  },
};
