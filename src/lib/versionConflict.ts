import { rootCause } from "@/lib/debugLog";

/** True when a write/undo CAS failed because the entity version drifted. */
export function isVersionConflictError(err: unknown): boolean {
  const msg = rootCause(err).toLowerCase();
  return (
    msg.includes("version conflict") ||
    /version \d+ conflict/.test(msg) ||
    /version \d+ not found/.test(msg)
  );
}
