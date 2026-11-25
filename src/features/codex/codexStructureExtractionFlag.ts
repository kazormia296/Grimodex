/**
 * Product gate for the Codex Structure Extraction HOLD review screen.
 *
 * Open by default (2026-11-25: opened together with the Work Layer live entry, which
 * leads to this screen). Setting the Vite env `VITE_CODEX_STRUCTURE_EXTRACTION_REVIEW`
 * to `false` or `0` closes it for a build. Applying a reviewed candidate stays behind the
 * narrative runtime policy (`narrativeDomainApplyAllowed`), not behind this flag.
 */
export const CODEX_STRUCTURE_EXTRACTION_REVIEW_ENV =
  "VITE_CODEX_STRUCTURE_EXTRACTION_REVIEW" as const;

export function isCodexStructureExtractionReviewEnabled(
  env: ImportMetaEnv | Record<string, unknown> = import.meta.env,
): boolean {
  const named = env[CODEX_STRUCTURE_EXTRACTION_REVIEW_ENV];
  if (named === true || named === "true" || named === "1") return true;
  if (named === false || named === "false" || named === "0") return false;
  return true;
}
