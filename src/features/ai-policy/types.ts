export type AiFeature = "chat" | "bodyWrite" | "analysis";

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
  toggles: { chat: true, bodyWrite: true, analysis: true },
};
