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

// 空白の判定は Rust の `str::trim`（White_Space）に近づけ、U+0085 も含める。
// JS の \s には Rust の White_Space に無い U+FEFF もあり、TS は Rust より広く
// 拒否する（over-rejection）。db の判定が最終で、広い側に倒れても安全側。
// 1 文字ずつ判定するので、全角空白などの BMP 外ではない空白もすべて 1 単位で扱える。
const WHITESPACE_CHAR = /^[\s\u0085]$/u;

/** 前後の空白を除いた範囲 [start, end)。先頭と末尾から 1 回ずつ走査する（線形）。 */
function trimmedRange(value: string): readonly [number, number] {
  let start = 0;
  let end = value.length;
  while (start < end && WHITESPACE_CHAR.test(value[start])) {
    start += 1;
  }
  while (end > start && WHITESPACE_CHAR.test(value[end - 1])) {
    end -= 1;
  }
  return [start, end];
}

/** ASCII だけを小文字にする（Rust の eq_ignore_ascii_case と同じ。toLowerCase は
 * Kelvin sign などの非 ASCII も畳むので使わない）。 */
function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/gu, (char) => char.toLowerCase());
}

/** eventId／executionId／operationId／parentExecutionId が予約に入るか。 */
export function isNir1LocalAuditReservedId(value: string): boolean {
  const [start] = trimmedRange(value);
  // 接頭辞の長さまでだけを見る。全体を正規化しない（長い入力でも線形）。
  return (
    asciiLowercase(
      value.slice(start, start + NIR1_LOCAL_AUDIT_ID_PREFIX.length),
    ) === NIR1_LOCAL_AUDIT_ID_PREFIX
  );
}

export function isNir1LocalAuditReservedPathId(value: string): boolean {
  const [start, end] = trimmedRange(value);
  const length = end - start;
  return NIR1_LOCAL_AUDIT_PATH_IDS.some(
    (path) =>
      path.length === length &&
      asciiLowercase(value.slice(start, end)) === path,
  );
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
