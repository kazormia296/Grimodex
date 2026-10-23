/**
 * Whether a declared-but-not-effective declaration can come back (CB-3,
 * DR-CB3-29).
 *
 * The author is told one of two things about a stored declaration that is not
 * effective, and the two must not be mixed up:
 *
 * - `paused`: nothing about what the author confirmed has changed. The cause
 *   can be taken away again (a veto record removed, the workspace put back to
 *   its place and ID), and then the very same bytes are effective again. The
 *   reader (CB-4) behaves the same way, so the screen must not call this
 *   "expired".
 * - `expired`: the body, title, Scope (A1), registry, folder structure,
 *   POV or the identity of the Scene changed. Those tokens only move forward;
 *   putting the content back does not make the declaration effective, and only
 *   a new declaration does.
 *
 * Native reports either a `blocker` (then `expiredBy` is empty) or the groups
 * that differ. A blocker does not say whether the binding also differs, so a
 * "paused" screen only promises to come back when nothing else changed.
 */
import type {
  BodyDeclarationBlocker,
  BodyDeclarationExpiryGroup,
} from "./bodyDeclarationTypes";

export type DeclaredStanding = "effective" | "paused" | "expired";

/**
 * Blockers whose cause does not touch the binding (a veto record, the
 * workspace identity), so taking the cause away can make the declaration
 * effective again. Every other blocker (an archived or emptied Scene, a Scope
 * that is not explicit, a POV, an oversized or unreadable body, a long title)
 * can only come from a change that also moved a token of the binding after the
 * declaration, so it is an expiry.
 */
const PAUSING_BLOCKERS: ReadonlySet<BodyDeclarationBlocker> = new Set([
  "veto-secret-foreshadow",
  "veto-secret-event-reveal",
  "veto-secret-event-link",
  "veto-limit",
  "locator-unavailable",
]);

export function declaredStanding(state: {
  readonly effective: boolean;
  readonly expiredBy: readonly BodyDeclarationExpiryGroup[];
  readonly blocker: BodyDeclarationBlocker | null;
}): DeclaredStanding {
  if (state.effective) return "effective";
  if (state.blocker !== null) {
    return PAUSING_BLOCKERS.has(state.blocker) ? "paused" : "expired";
  }
  // No blocker: the groups that differ. Only a workspace change comes back (by
  // restoring the place and ID). With no group at all the reason is unknown,
  // and an unknown reason is not called an expiry.
  return state.expiredBy.every((group) => group === "workspace")
    ? "paused"
    : "expired";
}
