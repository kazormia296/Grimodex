export type WorkspaceViewportProfile = "wide" | "compact" | "phone";

export const VIEWPORT_BREAKPOINTS = {
  phoneMaxExclusive: 720,
  compactMaxExclusive: 1120,
} as const;

export function resolveViewportProfile(
  width: number,
): WorkspaceViewportProfile {
  if (
    !Number.isFinite(width) ||
    width < VIEWPORT_BREAKPOINTS.phoneMaxExclusive
  ) {
    return "phone";
  }
  if (width < VIEWPORT_BREAKPOINTS.compactMaxExclusive) return "compact";
  return "wide";
}
