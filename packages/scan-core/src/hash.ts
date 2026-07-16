import { sha256Hex } from "@grimodex/scan-contract";

/** @deprecated Name kept for call-site compatibility; this is now SHA-256. */
export function stableHash8(value: string): string {
  return sha256Hex(value);
}
