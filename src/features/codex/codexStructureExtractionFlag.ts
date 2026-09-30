/**
 * Product gate for Codex Structure Extraction HOLD review.
 *
 * Until Native Run / ProposalSet / Evidence / catalog Apply are fully wired,
 * the Structure Dialog must not be the only accept path in product UI.
 * Enable via Vite env `VITE_CODEX_STRUCTURE_EXTRACTION_REVIEW=true`, or DEV builds.
 */
export const CODEX_STRUCTURE_EXTRACTION_REVIEW_ENV =
  "VITE_CODEX_STRUCTURE_EXTRACTION_REVIEW" as const;

export function isCodexStructureExtractionReviewEnabled(
  env: ImportMetaEnv | Record<string, unknown> = import.meta.env,
): boolean {
  const named = env[CODEX_STRUCTURE_EXTRACTION_REVIEW_ENV];
  if (named === true || named === "true" || named === "1") return true;
  if (named === false || named === "false" || named === "0") return false;
  return Boolean(env.DEV);
}
