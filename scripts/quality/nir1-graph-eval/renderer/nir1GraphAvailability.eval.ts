/**
 * CP-4 harness stub of `src/features/related-scenes/nir1GraphAvailability.ts`
 * (TASK D11 (A), §15.6; DR-CP4-S1C1-5).
 *
 * Only the harness renderer build (`scripts/quality/nir1-graph-eval/
 * renderer-build.mjs`) resolves the product module to this file, and only
 * into `.artifacts/cp4/<run>/renderer-dist`. The product source, the product
 * `vite.config.ts` and the product `dist/` never reference it. With this on,
 * the product hook reads the seed and sends it on begin; Native's product
 * gate stays the second lock (an evaluation `.node` opens it only for the
 * registered owner, a product `.node` answers `not-activated`).
 */
export const NIR1_GRAPH_UI_ENABLED = true as const;

export function isNir1GraphUiEnabled(): boolean {
  return NIR1_GRAPH_UI_ENABLED;
}
