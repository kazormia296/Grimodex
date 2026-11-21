/**
 * Whether the Scene body declaration UI exists for the product (CB-3, DR-CB3-2).
 *
 * The product keeps Graph's Scene disclosure closed until PUB-G. While this is
 * `false` the section renders nothing and no declaration command is invoked at
 * all. K2/5: the reader no longer reads a declaration (a Graph-only Scene needs
 * no author action), so PUB-G does not open this UI and the Related Scenes
 * Graph UI constant (`NIR1_GRAPH_UI_ENABLED`, DR-CP3B-2) is not changed with
 * it. Native's gate (`gate-closed`) stays the second, independent lock. The UI,
 * its writer and its gate are removed in a later PR (K2/5 PR-2).
 */
export const BODY_DECLARATION_UI_ENABLED = false as const;

/**
 * The single point tests replace (`vi.mock`). Components and hooks read the
 * constant only through it.
 */
export function isBodyDeclarationUiEnabled(): boolean {
  return BODY_DECLARATION_UI_ENABLED;
}
