export type SemanticRerankerMode = "off" | "shadow" | "apply";
export type SemanticRerankerLanguage = "ja" | "en";
export type SemanticRerankerUnavailableReason =
  | "unsupported-language"
  | "unsupported-runtime"
  | "resources-unavailable";

export interface SemanticRerankerCapabilityInput {
  language: string | null | undefined;
  electronRuntime: boolean;
  resourcesAvailable: boolean;
}

export interface SemanticRerankerCapability {
  available: boolean;
  language: SemanticRerankerLanguage | null;
  unavailableReason: SemanticRerankerUnavailableReason | null;
}

export function resolveSemanticRerankerLanguage(
  language: string | null | undefined,
): SemanticRerankerLanguage | null {
  const normalized = language?.trim().toLowerCase().replaceAll("_", "-");
  if (normalized === "ja" || normalized?.startsWith("ja-")) return "ja";
  if (normalized === "en" || normalized?.startsWith("en-")) return "en";
  return null;
}

export function resolveSemanticRerankerCapability(
  input: SemanticRerankerCapabilityInput,
): SemanticRerankerCapability {
  const language = resolveSemanticRerankerLanguage(input.language);
  if (!language) {
    return {
      available: false,
      language: null,
      unavailableReason: "unsupported-language",
    };
  }
  if (!input.electronRuntime) {
    return {
      available: false,
      language,
      unavailableReason: "unsupported-runtime",
    };
  }
  if (!input.resourcesAvailable) {
    return {
      available: false,
      language,
      unavailableReason: "resources-unavailable",
    };
  }
  return { available: true, language, unavailableReason: null };
}

export function resolveSemanticRerankerMode(input: {
  applyEnabled: boolean;
  devShadowEnabled: boolean;
  semanticRecallEnabled: boolean;
  hybridRecallEnabled: boolean;
  capability: SemanticRerankerCapabilityInput;
}): SemanticRerankerMode {
  if (
    !input.semanticRecallEnabled ||
    !input.hybridRecallEnabled ||
    !resolveSemanticRerankerCapability(input.capability).available
  ) {
    return "off";
  }
  if (input.applyEnabled) return "apply";
  if (input.devShadowEnabled) return "shadow";
  return "off";
}

export function isSemanticRerankerDevShadowEnabled(): boolean {
  return (
    import.meta.env.DEV && import.meta.env.VITE_SEMANTIC_RERANKER_SHADOW === "1"
  );
}
