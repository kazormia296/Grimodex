/**
 * CP-4 H5 診断（DR-CP4-S1C2-27）の harness 専用の shim：製品の
 * `src/lib/shell.ts` の `electronBridge()` が返す preload の bridge の
 * `invoke` に、transport の開始と応答の時刻（renderer の `performance.now()`）を
 * 記録する包みを足す。
 *
 * 製品の `ipcQueue` は derived lane を 1 枠に絞る（`MAX_CONCURRENT_DERIVED`）。
 * wrapper の層の timing shim（`nir1RelatedScenesApi.timing.ts`）の `calledAt` は
 * queue に入る時刻なので、queue の待ちと Main＋Native の時間を分けるために、
 * 実際に `window.grimodex.invoke` が呼ばれた時刻をここで取る。
 *
 * harness の renderer build が `bridgeTiming: true` のときだけ、製品の import を
 * この file に解決する（解決後の path で照合）。この file だけが製品の module を
 * import する。引数・応答・製品の制御の流れは変えない。製品の `dist/` には入らない。
 */
import * as product from "@/lib/shell";

export * from "@/lib/shell";

interface BridgeRow {
  cmd: string;
  settle: boolean;
  startedAt: number;
  endedAt: number | null;
  ok: boolean | null;
}

const host = globalThis as unknown as {
  __cp4BridgeTiming?: BridgeRow[];
  __cp4BridgeTimingInstalled?: boolean;
};
const rows = (host.__cp4BridgeTiming ??= []);
host.__cp4BridgeTimingInstalled = true;

type Bridge = ReturnType<typeof product.electronBridge>;
let source: Bridge | null = null;
let wrapped: Bridge | null = null;

export const electronBridge: typeof product.electronBridge = () => {
  const bridge = product.electronBridge();
  if (bridge !== source || wrapped === null) {
    source = bridge;
    const invoke = bridge.invoke.bind(bridge) as Bridge["invoke"];
    // contextBridge の object は frozen なので Proxy でなく写しを返す。
    wrapped = {
      ...bridge,
      invoke: ((cmd: string, args?: Record<string, unknown>) => {
        const row: BridgeRow = {
          cmd,
          settle:
            cmd === "related_scenes_graph_continue" &&
            args?.settle !== undefined,
          startedAt: performance.now(),
          endedAt: null,
          ok: null,
        };
        rows.push(row);
        if (rows.length > 4000) rows.splice(0, rows.length - 4000);
        return invoke(cmd, args).then(
          (value) => {
            row.endedAt = performance.now();
            row.ok = true;
            return value;
          },
          (error: unknown) => {
            row.endedAt = performance.now();
            row.ok = false;
            throw error;
          },
        );
      }) as Bridge["invoke"],
    } as Bridge;
  }
  return wrapped;
};
