// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MP-4b PR-8b：Codex の hidden を通る read tool 4 本が、PR-0 の golden の 46 case（17・10・9・10）で
 * **送る呼出しの列**の特性試験（反証 A-3）。結果は同じでも、SQL（列・条件・limit・DISTINCT・並び）や
 * 呼ぶ順が変わる移し方を落とす。golden と結果は PR-0 の試験が固定するので、ここは送ったものだけを固定する。
 *
 * `db_execute` の（sql・params・method）と、fts_search・codex_semantic_search の引数を、case ごとに
 * fixture（`__fixtures__/codexReadCalls/codex-read-calls.golden.txt`）へ。**seed だけの world**（この file は
 * seed に行を足さない。足すと params が変わる）で、未変更の legacy から作った。共有 core へ移した後も
 * この file は無変更で通り（renderer の経路）、main の adapter 上の core が送る db_execute の列も同じ fixture と
 * 一致する（`readCore.mainAdapter.test.ts`）。
 *
 * fixture の再生成：該当 file を消して `pnpm exec vitest --run <この file>`（CI では書かれず落ちる）。
 * 再生成した差分は人が目で確認する。
 */
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  const { legacyReadInvokeBridge } =
    await import("./legacyReadInvokeBridge.testSupport");
  legacyReadInvokeBridge.bindActual(actual.invoke as never);
  return { ...actual, invoke: legacyReadInvokeBridge.invoke };
});
vi.mock("../contextBuilder", () => ({
  countTokens: (s: string) => (s ? s.length : 0),
}));

import { invoke } from "@/lib/tauri";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { executeTool } from "./toolExecutors";
import { LEGACY_READ_CANNED_CODEX_HITS } from "./__fixtures__/legacyReadSeed";
import { legacyReadInvokeBridge } from "./legacyReadInvokeBridge.testSupport";
import {
  bindLegacyReadHarnessPorts,
  seedLegacyReadFixture,
  setLegacyReadWorkspaceIdentity,
  setLegacyReadWorld,
  type LegacyReadGoldenCase,
} from "./legacyReadHarness.testSupport";

bindLegacyReadHarnessPorts({
  executeRun: (sql, params) =>
    invoke("db_execute", { sql, params, method: "run" }),
  setTreeState: (state) => useTreeStore.setState(state),
  setPhaseState: (state) => usePhaseStore.setState(state),
});

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

beforeAll(async () => {
  await seedLegacyReadFixture();
});

beforeEach(() => {
  setLegacyReadWorkspaceIdentity();
  legacyReadInvokeBridge.reset();
});

const GOLDEN_FILES = import.meta.glob<string>(
  "./__fixtures__/legacyReadGolden/*.golden.txt",
  { query: "?raw", import: "default", eager: true },
);
const CALLS_FIXTURE =
  "./__fixtures__/codexReadCalls/codex-read-calls.golden.txt";
const CODEX_TOOLS = [
  "search_codex",
  "list_codex_by_type",
  "search_codex_by_tags",
  "find_related_entries",
] as const;

const goldenCases = (tool: string): LegacyReadGoldenCase[] => {
  const raw =
    GOLDEN_FILES[`./__fixtures__/legacyReadGolden/${tool}.golden.txt`];
  if (raw === undefined) throw new Error(`no golden for ${tool}`);
  return (JSON.parse(raw) as { cases: LegacyReadGoldenCase[] }).cases;
};

/** golden の case 名から、その scenario の dense の差し替えを決める（`legacyGolden.test.ts` の表と同じ）。 */
function denseOverrideOf(caseName: string): (() => unknown) | null {
  if (!caseName.startsWith("canned dense:")) return null;
  if (caseName.includes("reject")) {
    return () => {
      throw new Error("dense unavailable");
    };
  }
  return () => LEGACY_READ_CANNED_CODEX_HITS;
}

describe("4 本が golden の 46 case で送る呼出しの列", () => {
  it("46 case を全部流し、db_execute の（sql・params・method）と fts・dense の引数が fixture と一致する", async () => {
    const doc: Record<string, Record<string, unknown[]>> = {};
    let total = 0;
    for (const tool of CODEX_TOOLS) {
      const perCase: Record<string, unknown[]> = {};
      for (const golden of goldenCases(tool)) {
        await setLegacyReadWorld(golden.world);
        legacyReadInvokeBridge.reset();
        const dense = denseOverrideOf(golden.case);
        if (dense) {
          legacyReadInvokeBridge.override("codex_semantic_search", dense);
        }
        await executeTool(tool, "call-1", golden.params);
        perCase[golden.case] = legacyReadInvokeBridge.calls().map((call) =>
          call.cmd === "db_execute"
            ? {
                cmd: call.cmd,
                sql: call.args?.["sql"],
                params: call.args?.["params"],
                method: call.args?.["method"],
              }
            : { cmd: call.cmd, args: call.args },
        );
        legacyReadInvokeBridge.reset();
        total += 1;
      }
      doc[tool] = perCase;
    }
    expect(total).toBe(46);
    await expect(`${JSON.stringify(doc, null, 2)}\n`).toMatchFileSnapshot(
      CALLS_FIXTURE,
    );
  });
});
