import { useSyncExternalStore } from "react";
import {
  isQuiescenceLeaseActive,
  subscribeQuiescenceLease,
} from "./quiescenceLease";

/** React projection of the shared destructive-lifecycle scheduling barrier. */
export function useQuiescenceLeaseActive(): boolean {
  return useSyncExternalStore(
    subscribeQuiescenceLease,
    isQuiescenceLeaseActive,
    () => false,
  );
}
