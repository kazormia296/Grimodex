/**
 * Placement of the profile egress status display (DR-DA2-63, DR-PUBG-32-1, R3-8):
 * it floats over the editor's bottom-left area, clear of the LayoutShell's own
 * controls and of the editor's status bar. Two placements, both `fixed`:
 *
 * - Fallback (no editor status bar: zen mode, no scene open, a stubbed editor):
 *   the left stripe column, the bottom stripe row (with the bottom corner
 *   toggle) and the gap that follows them are off limits, so the display never
 *   covers a stripe icon or a corner toggle (62 px, 61 px).
 * - Anchored (the real `EditorPaneStatusBar` carries `anchor-name:
 *   --editor-status-bar`): CSS anchor positioning puts the display above the
 *   bar (`STATUS_BAR_GAP_PX` 10 px over its top edge) and right of the scene
 *   status menu, which opens upward from the button at the bar's left padding
 *   (12 px) and is at least 120 px wide (`min-w-[120px]`):
 *   `STATUS_MENU_CLEARANCE_PX` is 12 + 120 + 8 px from the bar's left edge. The
 *   anchor follows the bar through every layout (side panels, bottom region,
 *   splitter drags) with no script. A browser without anchor positioning uses
 *   the fallback values of `anchor()`.
 *
 * The unavailable card is wider than some open side panels and has nothing to
 * click, so it is `pointer-events-none`: a splitter handle under it keeps its
 * hit area. `layoutInvariants.browser.test.tsx` measures all of it against the
 * real status bar with the menu open.
 *
 * Below 720 px the app shows the phone workspace: there are no stripes and no
 * editor status bar, and the bottom nav (`phone-workspace-chrome__nav`, 68 px
 * plus the bottom safe area, `phoneWorkspace.css`) spans the full width. The
 * display then sits 8 px above the nav, from the left margin, and, while the
 * AI surface's composer is showing (`data-phone-chat-composer` in the visible,
 * non-inert `data-mobile-surface`; `phoneWorkspace.css` gives it the
 * `--phone-chat-composer` anchor), 8 px above the composer's top edge instead
 * (DR-PUBG-35-1: the composer is as high as 90 px and its height changes, so a
 * fixed offset could not clear it). The variant is
 * `width < 719.98px` (Tailwind 4 `max-[..]` is exclusive), so a 719 px window is
 * phone as in `VIEWPORT_BREAKPOINTS.phoneMaxExclusive` (720).
 *
 * The numbers repeat `OUTER_PAD_PX + STRIPE_SIZE + STRIPE_GAP_PX` and
 * `OUTER_PAD_PX + HORIZONTAL_STRIPE_SIZE + STRIPE_GAP_PX` of
 * `features/layout/layoutConstants` instead of importing them: a lazy chunk
 * that shares that module makes the bundler split it out of the startup graph
 * into a chunk of its own. `profileEgressStatusPlacement.test.ts` pins them,
 * the class names below and the phone nav height.
 */
export const PROFILE_EGRESS_STATUS_LEFT_PX = 62;
export const PROFILE_EGRESS_STATUS_BOTTOM_PX = 61;
export const STATUS_MENU_CLEARANCE_PX = 140;
export const STATUS_BAR_GAP_PX = 10;
export const PROFILE_EGRESS_STATUS_PHONE_LEFT_PX = 12;
export const PROFILE_EGRESS_STATUS_PHONE_BOTTOM_PX = 76;
export const PROFILE_EGRESS_STATUS_RIGHT_MARGIN_PX = 12;
/** The phone nav's height (`--phone-workspace-nav-height`, `phoneWorkspace.css`). */
export const PHONE_NAV_HEIGHT_PX = 68;
export const PHONE_COMPOSER_GAP_PX = 8;
/** The `anchor-name` `phoneWorkspace.css` gives the visible AI composer. */
export const PHONE_CHAT_COMPOSER_ANCHOR = "--phone-chat-composer";
/** The `anchor-name` that `EditorPaneStatusBar` sets on its root. */
export const EDITOR_STATUS_BAR_ANCHOR = "--editor-status-bar";

/**
 * Tailwind scans source for whole class names, so these are literals, not
 * built from the numbers above (the unit test pins that they agree). In an
 * `anchor()` the second argument is the fallback, so it is the fallback
 * placement minus the offset added after it.
 */
export const PROFILE_EGRESS_STATUS_PLACEMENT_CLASS =
  "left-[calc(anchor(--editor-status-bar_left,-78px)+140px)] bottom-[calc(anchor(--editor-status-bar_top,51px)+10px)] max-w-[calc(100vw-74px)] max-[719.98px]:left-[12px] max-[719.98px]:bottom-[calc(anchor(--phone-chat-composer_top,calc(68px+env(safe-area-inset-bottom)))+8px)] max-[719.98px]:max-w-[calc(100vw-24px)]";
