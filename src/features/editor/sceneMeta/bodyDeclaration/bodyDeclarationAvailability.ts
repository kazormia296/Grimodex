/**
 * Whether the Scene body declaration UI exists for the product (CB-3, DR-CB3-2).
 *
 * The product keeps Graph's Scene disclosure closed until PUB-G. While this is
 * `false` the section renders nothing and no declaration command is invoked at
 * all. Turning it on is a PUB-G change: it is made together with opening the
 * product gate in Native, under the same approval. Native's gate is the second,
 * independent lock: with this on and the gate closed the read answers
 * `gate-closed` and the section stays hidden. PUB-G changes this together
 * with the Related Scenes Graph UI constant (`NIR1_GRAPH_UI_ENABLED`,
 * DR-CP3B-2).
 */
export const BODY_DECLARATION_UI_ENABLED = false as const;

/**
 * The single point tests replace (`vi.mock`). Components and hooks read the
 * constant only through it.
 */
export function isBodyDeclarationUiEnabled(): boolean {
  return BODY_DECLARATION_UI_ENABLED;
}
