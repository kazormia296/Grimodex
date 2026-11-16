/**
 * Placement of the profile egress status display (DR-DA2-63, DR-PUBG-32-1, R3-8):
 * it floats over the editor's bottom-left corner, clear of the LayoutShell's own
 * controls and of the editor's status bar. The left stripe column, the bottom
 * stripe row (with the bottom corner toggle) and the gap that follows them are
 * off limits, so the display never covers a stripe icon or a corner toggle.
 * Above that the editor's status bar (`EditorPaneStatusBar`, the scene status
 * button and the badges) sits on the center's bottom edge, so the display is
 * lifted over it too: `EDITOR_STATUS_BAR_CLEARANCE_PX` is the bar's measured
 * height (29 px) plus a 10 px gap. The unavailable card is wider than some open
 * side panels and has nothing to click, so it is `pointer-events-none`: a
 * splitter handle under it keeps its hit area. `layoutInvariants.browser.test.tsx`
 * measures all of it against the real status bar.
 *
 * Below 720 px the app shows the phone workspace: there are no stripes and no
 * editor status bar, and the bottom nav (`phone-workspace-chrome__nav`, 68 px
 * plus the bottom safe area, `phoneWorkspace.css`) spans the full width. The
 * display then sits 8 px above the nav, from the left margin. The media query
 * is the same 720 px as `VIEWPORT_BREAKPOINTS.phoneMaxExclusive`.
 *
 * The numbers repeat `OUTER_PAD_PX + STRIPE_SIZE + STRIPE_GAP_PX` and
 * `OUTER_PAD_PX + HORIZONTAL_STRIPE_SIZE + STRIPE_GAP_PX` of
 * `features/layout/layoutConstants` instead of importing them: a lazy chunk
 * that shares that module makes the bundler split it out of the startup graph
 * into a chunk of its own. `profileEgressStatusPlacement.test.ts` pins them,
 * the class names below and the phone nav height.
 */
export const PROFILE_EGRESS_STATUS_LEFT_PX = 62;
const STRIPE_CLEAR_BOTTOM_PX = 61;
export const EDITOR_STATUS_BAR_CLEARANCE_PX = 39;
export const PROFILE_EGRESS_STATUS_BOTTOM_PX =
  STRIPE_CLEAR_BOTTOM_PX + EDITOR_STATUS_BAR_CLEARANCE_PX;
export const PROFILE_EGRESS_STATUS_PHONE_LEFT_PX = 12;
export const PROFILE_EGRESS_STATUS_PHONE_BOTTOM_PX = 76;
const RIGHT_MARGIN_PX = 12;

/**
 * Tailwind scans source for whole class names, so these are literals, not
 * built from the numbers above (the unit test pins that they agree).
 */
export const PROFILE_EGRESS_STATUS_PLACEMENT_CLASS =
  "left-[62px] bottom-[100px] max-[719px]:left-[12px] max-[719px]:bottom-[calc(76px+env(safe-area-inset-bottom))]";

export const PROFILE_EGRESS_STATUS_POSITION = {
  maxWidth: `calc(100vw - ${PROFILE_EGRESS_STATUS_LEFT_PX + RIGHT_MARGIN_PX}px)`,
} as const;
