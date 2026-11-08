/**
 * Placement of the profile egress status display (DR-DA2-63, R3-8): it floats
 * over the editor's bottom-left corner, clear of the LayoutShell's own
 * controls. The left stripe column, the bottom stripe row (with the bottom
 * corner toggle) and the gap that follows them are off limits, so the display
 * never covers a stripe icon or a corner toggle. The unavailable card is wider
 * than some open side panels and has nothing to click, so it is
 * `pointer-events-none`: a splitter handle under it keeps its hit area.
 * `layoutInvariants.browser.test.tsx` measures both.
 *
 * The numbers repeat `OUTER_PAD_PX + STRIPE_SIZE + STRIPE_GAP_PX` and
 * `OUTER_PAD_PX + HORIZONTAL_STRIPE_SIZE + STRIPE_GAP_PX` of
 * `features/layout/layoutConstants` instead of importing them: a lazy chunk
 * that shares that module makes the bundler split it out of the startup graph
 * into a chunk of its own. `profileEgressStatusPlacement.test.ts` pins them.
 */
export const PROFILE_EGRESS_STATUS_LEFT_PX = 62;
export const PROFILE_EGRESS_STATUS_BOTTOM_PX = 61;
const RIGHT_MARGIN_PX = 12;

export const PROFILE_EGRESS_STATUS_POSITION = {
  left: PROFILE_EGRESS_STATUS_LEFT_PX,
  bottom: PROFILE_EGRESS_STATUS_BOTTOM_PX,
  maxWidth: `calc(100vw - ${PROFILE_EGRESS_STATUS_LEFT_PX + RIGHT_MARGIN_PX}px)`,
} as const;
