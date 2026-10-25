/**
 * CP-4 S1c-2 harness-only timing shim of the product module
 * `src/features/related-scenes/nir1RelatedScenesApi.ts` (DR-CP4-S1C2-9).
 *
 * The harness renderer build resolves the product's imports of that module to
 * this file (matched on the resolved path, as the availability alias); this
 * file alone imports the product module itself. Every export is the
 * product's; three are wrapped only to note, with the renderer
 * `performance.now()` the product's join helper uses, when the begin and the
 * Graph wait were called and when their answers arrived. The arguments, the
 * answers and the product's control flow are unchanged; each wrapper adds one
 * promise reaction (µs). It never ships in the product `dist/`.
 */
import * as product from "@/features/related-scenes/nir1RelatedScenesApi";

export * from "@/features/related-scenes/nir1RelatedScenesApi";

interface TimingRow {
  cmd: string;
  calledAt: number;
  resolvedAt: number | null;
  ok: boolean | null;
  settle: string | null;
  status: string | null;
  reason: string | null;
  graphStatus: string | null;
  graphReason: string | null;
  pathAttachments: number | null;
  graphOnly: boolean | null;
}

const host = globalThis as unknown as { __cp4IpcTiming?: TimingRow[] };
const rows = (host.__cp4IpcTiming ??= []);

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function timed<T>(cmd: string, settle: string | null, call: () => Promise<T>) {
  const row: TimingRow = {
    cmd,
    calledAt: performance.now(),
    resolvedAt: null,
    ok: null,
    settle,
    status: null,
    reason: null,
    graphStatus: null,
    graphReason: null,
    pathAttachments: null,
    graphOnly: null,
  };
  rows.push(row);
  return call().then(
    (value) => {
      row.resolvedAt = performance.now();
      row.ok = true;
      row.status = text(field(value, "status"));
      row.reason = text(field(value, "reason"));
      const graph = field(value, "graph");
      row.graphStatus = text(field(graph, "status"));
      row.graphReason = text(field(graph, "reason"));
      const attachments = field(value, "pathAttachments");
      if (Array.isArray(attachments)) row.pathAttachments = attachments.length;
      const graphOnly = field(value, "graphOnly");
      if (graphOnly !== undefined) row.graphOnly = graphOnly !== null;
      return value;
    },
    (error: unknown) => {
      row.resolvedAt = performance.now();
      row.ok = false;
      throw error;
    },
  );
}

export const beginRelatedScenes: typeof product.beginRelatedScenes = (
  request,
) =>
  timed("related_scenes_begin", null, () =>
    product.beginRelatedScenes(request),
  );

export const continueRelatedScenesGraph: typeof product.continueRelatedScenesGraph =
  (operationTicket, rawSceneIds) =>
    timed("related_scenes_graph_continue", null, () =>
      product.continueRelatedScenesGraph(operationTicket, rawSceneIds),
    );

export const settleRelatedScenesGraph: typeof product.settleRelatedScenesGraph =
  (operationTicket, settle) =>
    timed("related_scenes_graph_continue", String(settle), () =>
      product.settleRelatedScenesGraph(operationTicket, settle),
    );
