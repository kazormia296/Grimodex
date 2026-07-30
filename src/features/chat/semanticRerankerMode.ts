export type SemanticRerankerMode = "off" | "shadow" | "apply";

export function resolveSemanticRerankerMode(input: {
  applyEnabled: boolean;
  devShadowEnabled: boolean;
  semanticRecallEnabled: boolean;
  hybridRecallEnabled: boolean;
}): SemanticRerankerMode {
  if (!input.semanticRecallEnabled || !input.hybridRecallEnabled) {
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
