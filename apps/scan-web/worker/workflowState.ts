import type { ScanStatus } from "./stateMachine";

/** Preserve a user cancellation when it races with an unrelated step error. */
export function isCancellationRequestedOrTerminal(
  status: ScanStatus | null,
): boolean {
  return (
    status === "cancel_requested" ||
    status === "cancelled" ||
    status === "deleted"
  );
}
