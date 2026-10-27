/**
 * CP-4 TR（レビュー P2-3）：trace の page の待ちの規則（純粋）。`cp4-trace-probe.tsx`
 * が page の中で 2 ms ごとに呼び、node の試験（`trace-cycle.test.mjs`）が同じ
 * 関数を直接押さえる。import を持たない（node の型の除去でそのまま読める）。
 *
 * - counted query の親: その操作の後（`sinceAt` 以後）に呼ばれた、その場面の、
 *   `afterSeq` より後の最初の fetch で、`graph-ready` の印の無いもの（印のある
 *   取り直しは親にしない）。
 * - cycle end（S2 `cycleEnd`）: 親が completed 以外で返った（parent-ended）、親の
 *   次の `graph-ready` の取り直しが completed 以外で返った（child-ended）か
 *   React の commit に出た（child-published）、親の `t_raw_ready` + T_show が
 *   経った（t-show-elapsed）。親が guard の内に返らなければ harness-limit。
 * - 公開（S2 `until: query-published`）: その場面の `sinceAt` 以後の最初の fetch
 *   が返り、その結果が commit に出た（published）か、completed 以外で返った。
 */

export interface TraceFetchRow {
  seq: number;
  sceneId: string;
  refreshTrigger: string | null;
  calledAt: number;
  resolvedAt: number | null;
  status: string | null;
  tRawReadyMs: number | null;
}

export interface TraceCommit {
  at: number;
  fetchSeq: number | null;
}

export function selectCountedFetch(
  rows: readonly TraceFetchRow[],
  input: { sceneId: string; afterSeq: number; sinceAt: number },
): TraceFetchRow | null {
  return (
    rows.find(
      (row) =>
        row.seq > input.afterSeq &&
        row.sceneId === input.sceneId &&
        row.calledAt >= input.sinceAt &&
        row.refreshTrigger === null,
    ) ?? null
  );
}

export type CycleEndReason =
  | "parent-ended"
  | "child-ended"
  | "child-published"
  | "t-show-elapsed"
  | "harness-limit";

export function cycleEndOf(
  rows: readonly TraceFetchRow[],
  commits: readonly TraceCommit[],
  input: {
    parentSeq: number;
    tShowMs: number;
    now: number;
    elapsedMs: number;
    limitMs: number;
  },
): CycleEndReason | null {
  const parent = rows.find((row) => row.seq === input.parentSeq);
  if (!parent || parent.resolvedAt === null)
    return input.elapsedMs >= input.limitMs ? "harness-limit" : null;
  if (parent.status !== "completed") return "parent-ended";
  const child = rows.find(
    (row) => row.seq > input.parentSeq && row.refreshTrigger === "graph-ready",
  );
  if (child && child.resolvedAt !== null) {
    if (child.status !== "completed") return "child-ended";
    if (commits.some((commit) => commit.fetchSeq === child.seq))
      return "child-published";
  }
  if (
    parent.tRawReadyMs !== null &&
    input.now >= parent.tRawReadyMs + input.tShowMs
  )
    return "t-show-elapsed";
  return input.elapsedMs >= input.limitMs ? "harness-limit" : null;
}

export function publishedOf(
  rows: readonly TraceFetchRow[],
  commits: readonly TraceCommit[],
  input: { sceneId: string; sinceAt: number; now: number },
): { seq: number; at: number; published: boolean } | null {
  const row = rows.find(
    (fetch) =>
      fetch.sceneId === input.sceneId && fetch.calledAt >= input.sinceAt,
  );
  if (!row || row.resolvedAt === null) return null;
  const shown = commits.find((commit) => commit.fetchSeq === row.seq);
  if (shown) return { seq: row.seq, at: shown.at, published: true };
  if (row.status !== "completed")
    return { seq: row.seq, at: input.now, published: false };
  return null;
}
