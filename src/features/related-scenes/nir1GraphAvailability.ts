/**
 * Whether the Related Scenes Graph UI exists for the product (CP-3b,
 * DR-CP3B-2).
 *
 * While this is `false` the renderer reads no pin, sends no Graph seed (begin
 * is byte-identical to the one before CP-3a), never requests the Graph UI
 * chunk and draws no Graph row. Turning it on is a PUB-G change, made together
 * with `BODY_DECLARATION_UI_ENABLED` and Native's product gate under the same
 * approval. Native's gate is the second, independent lock: with this on and
 * the gate closed the owner answers `not-activated` (`profile-not-restricted`
 * when unrestricted) and no Graph payload reaches the renderer.
 */
export const NIR1_GRAPH_UI_ENABLED = false as const;

/**
 * The single point tests replace (`vi.mock`). Hooks and components read the
 * constant only through it.
 */
export function isNir1GraphUiEnabled(): boolean {
  return NIR1_GRAPH_UI_ENABLED;
}
