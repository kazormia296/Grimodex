import type { Nir1GraphEvidenceQualifyResponse } from "@/../electron/shared/relatedScenesSearchWire";
import { invoke } from "@/lib/tauri";

const UNAVAILABLE_REASONS = new Set(["invalidated", "cancelled", "failed"]);
const FAILED = { status: "unavailable", reason: "failed" } as const;
/**
 * Fields only the IR arm carries. Any of them on a Graph-only answer means the
 * arms were mixed up (a renderer bug), so the answer is refused fail-closed
 * instead of skipping the digest checks (CP-3b F2, DR-CP3B-14). The startup
 * click path (`nir1EvidenceNavigation.ts`) does not hold this list; it refuses
 * a Graph-only answer whose key count is not exactly 5.
 */
const IR_ARM_FIELDS = [
  "sourceVersion",
  "storageDigest",
  "canonicalTextDigest",
  "normalizerVersion",
  "fullQuote",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/**
 * Click-time re-qualification of a Graph-only row's handle (CP-3b, D6). The
 * same command as IR (`nir1_evidence_qualify`); Native answers the Graph-only
 * arm without a body digest or the full quote (DR-CP3A-26). Only the
 * digest-free fields are copied; an IR-arm field or any other shape is
 * `unavailable:failed`.
 *
 * Imported by the lazy click consumer only, never by a startup module.
 */
export async function qualifyNir1GraphEvidence(
  navigationIdentity: string,
): Promise<Nir1GraphEvidenceQualifyResponse> {
  const value: unknown = await invoke("nir1_evidence_qualify", {
    navigationIdentity,
  });
  if (!isRecord(value)) return FAILED;
  if (value.status === "unavailable")
    return typeof value.reason === "string" &&
      UNAVAILABLE_REASONS.has(value.reason)
      ? {
          status: "unavailable",
          reason: value.reason as "invalidated" | "cancelled" | "failed",
        }
      : FAILED;
  const range = value.canonicalRange;
  if (
    value.status !== "qualified" ||
    IR_ARM_FIELDS.some((field) => field in value) ||
    !isText(value.bindingKey) ||
    !isText(value.queryBinding) ||
    !isText(value.sceneId) ||
    !isRecord(range) ||
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end)
  )
    return FAILED;
  return {
    status: "qualified",
    bindingKey: value.bindingKey,
    queryBinding: value.queryBinding,
    sceneId: value.sceneId,
    canonicalRange: { start: range.start as number, end: range.end as number },
  };
}
