export type ScanStatus =
  | "created"
  | "uploading"
  | "queued"
  | "validating"
  | "chunking"
  | "extracting"
  | "merging"
  | "adjudicating"
  | "reporting"
  | "completed"
  | "cancel_requested"
  | "cancelled"
  | "failed"
  | "expired"
  | "deleted";

const transitions: Record<ScanStatus, readonly ScanStatus[]> = {
  created: ["uploading", "queued", "cancel_requested", "failed", "deleted"],
  uploading: ["queued", "cancel_requested", "failed", "expired", "deleted"],
  queued: ["validating", "cancel_requested", "failed", "expired", "deleted"],
  validating: ["chunking", "cancel_requested", "failed", "deleted"],
  chunking: ["extracting", "cancel_requested", "failed", "deleted"],
  extracting: ["merging", "cancel_requested", "failed", "deleted"],
  merging: [
    "adjudicating",
    "reporting",
    "cancel_requested",
    "failed",
    "deleted",
  ],
  adjudicating: ["reporting", "cancel_requested", "failed", "deleted"],
  reporting: ["completed", "cancel_requested", "failed", "deleted"],
  completed: ["deleted"],
  cancel_requested: ["cancelled", "failed", "deleted"],
  cancelled: ["deleted"],
  failed: ["deleted"],
  expired: ["deleted"],
  deleted: [],
};

export function canTransition(from: ScanStatus, to: ScanStatus): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: ScanStatus, to: ScanStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`invalid scan status transition: ${from} -> ${to}`);
  }
}

export function isTerminalStatus(status: ScanStatus): boolean {
  return (
    status === "completed" ||
    status === "cancelled" ||
    status === "failed" ||
    status === "expired" ||
    status === "deleted"
  );
}
