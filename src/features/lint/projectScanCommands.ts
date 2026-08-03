import { useLintProjectStore } from "./lintProjectStore";

/** Cancel the active Project lint scan without exposing its Zustand store. */
export function cancelProjectLintScan(): void {
  useLintProjectStore.getState().cancel();
}
