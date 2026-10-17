/**
 * NIR-1 のローカル生成 route が使う監査 namespace（K5/3、S17）。
 *
 * この namespace の path ID と、eventId／executionId／operationId／
 * parentExecutionId の予約接頭辞は、Native の専用 append だけが書く。
 * renderer が呼ぶ `ai_audit_append_batch` は、1 件でも予約に入る event を含む
 * batch を何も書かずに拒否する（Main のここと、db の汎用 append の二重）。
 *
 * Rust の正本は `src-tauri/crates/grimodex-db/src/nir1_local_audit.rs`。
 * 定数は `nir1LocalAuditNamespace.test.ts` が Rust の source と照合する。
 */

export const NIR1_LOCAL_AUDIT_ID_PREFIX = "nir1-local-generation:";
export const NIR1_LOCAL_WRITING_PATH_ID = "nir1_local_generation_writing";
export const NIR1_LOCAL_REVIEW_PATH_ID = "nir1_local_generation_review";
export const NIR1_LOCAL_AUDIT_PATH_IDS: readonly string[] = [
  NIR1_LOCAL_WRITING_PATH_ID,
  NIR1_LOCAL_REVIEW_PATH_ID,
];

// Rust の `str::trim`（White_Space）に合わせる。JS の trim に無い U+0085 も含む。
const SURROUNDING_WHITESPACE = /^[\s\u0085]+|[\s\u0085]+$/gu;

function normalized(value: string): string {
  // ASCII だけを小文字にする（Rust の eq_ignore_ascii_case と同じ。
  // toLowerCase は Kelvin sign などの非 ASCII も畳むので使わない）。
  return value
    .replace(SURROUNDING_WHITESPACE, "")
    .replace(/[A-Z]/gu, (char) => char.toLowerCase());
}

/** eventId／executionId／operationId／parentExecutionId が予約に入るか。 */
export function isNir1LocalAuditReservedId(value: string): boolean {
  return normalized(value).startsWith(NIR1_LOCAL_AUDIT_ID_PREFIX);
}

export function isNir1LocalAuditReservedPathId(value: string): boolean {
  return NIR1_LOCAL_AUDIT_PATH_IDS.includes(normalized(value));
}

/** event の最初の予約済み項目名。無ければ null。 */
export function nir1LocalAuditReservedField(event: {
  readonly pathId?: unknown;
  readonly eventId?: unknown;
  readonly executionId?: unknown;
  readonly operationId?: unknown;
  readonly parentExecutionId?: unknown;
}): string | null {
  if (
    typeof event.pathId === "string" &&
    isNir1LocalAuditReservedPathId(event.pathId)
  ) {
    return "pathId";
  }
  for (const key of [
    "eventId",
    "executionId",
    "operationId",
    "parentExecutionId",
  ] as const) {
    const value = event[key];
    if (typeof value === "string" && isNir1LocalAuditReservedId(value)) {
      return key;
    }
  }
  return null;
}
