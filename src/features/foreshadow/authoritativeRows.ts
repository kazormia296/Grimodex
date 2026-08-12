import type { ForeshadowRow } from "./types";

type AuthoritativeForeshadowRowsSink = (rows: readonly ForeshadowRow[]) => void;

let authoritativeForeshadowRowsSink: AuthoritativeForeshadowRowsSink | null =
  null;

/**
 * Registers the currently loaded Foreshadow store as the projection sink.
 * Re-registration intentionally replaces the previous sink for HMR/module reloads.
 */
export function setAuthoritativeForeshadowRowsSink(
  sink: AuthoritativeForeshadowRowsSink,
): void {
  authoritativeForeshadowRowsSink = sink;
}

/** Publish native-authoritative root rows without importing the Foreshadow store. */
export function publishAuthoritativeForeshadowRows(
  rows: readonly ForeshadowRow[],
): void {
  if (rows.length === 0) return;
  authoritativeForeshadowRowsSink?.(rows);
}
