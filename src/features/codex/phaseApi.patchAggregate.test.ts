import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
let phaseRow: {
  id: string;
  entryId: string;
  version: number;
  contextModeOverride: string | null;
  label?: string;
} | null = null;
let overrideRows: Array<{
  phaseId: string;
  definitionId: string;
  value: string | null;
}> = [];
let selectCalls = 0;

vi.mock("@/lib/tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("./impactBaselineVisibility", () => ({
  clearImpactBaselinePhaseDeletion: vi.fn(),
  markImpactBaselinePhasesRestricted: vi.fn(),
  markImpactBaselinePhaseVisible: vi.fn(),
  markImpactBaselinePhaseVisibleDeleted: vi.fn(),
}));

vi.mock("@/db/client", () => {
  return {
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            then: (resolve: (v: unknown) => void) => {
              selectCalls += 1;
              // 1: getPhase (pre), 2: getPhase (post), 3+: overrides
              if (selectCalls <= 2) {
                resolve(phaseRow ? [phaseRow] : []);
              } else {
                resolve(overrideRows);
              }
            },
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            toSQL: () => ({
              sql: "update codex_entry_phases set version = ?",
              params: [5],
            }),
          }),
        }),
      }),
      insert: () => ({
        values: () => ({
          toSQL: () => ({
            sql: "insert into codex_phase_detail_overrides",
            params: [],
          }),
        }),
      }),
      delete: () => ({
        where: () => ({
          toSQL: () => ({
            sql: "delete from codex_phase_detail_overrides",
            params: [],
          }),
        }),
      }),
    },
  };
});

import { patchPhaseAggregate } from "./phaseApi";
import { PhaseVersionConflictError } from "./phaseOcc";

beforeEach(() => {
  invokeMock.mockReset();
  selectCalls = 0;
  phaseRow = {
    id: "phase-1",
    entryId: "entry-1",
    version: 4,
    contextModeOverride: null,
  };
  overrideRows = [];
});

describe("patchPhaseAggregate", () => {
  it("bumps phase.version once for multiple override changes", async () => {
    invokeMock.mockImplementation(async () => {
      phaseRow = {
        id: "phase-1",
        entryId: "entry-1",
        version: 5,
        contextModeOverride: null,
        label: "死亡",
      };
      overrideRows = [
        { phaseId: "phase-1", definitionId: "d1", value: "a" },
        { phaseId: "phase-1", definitionId: "d2", value: "b" },
        { phaseId: "phase-1", definitionId: "d3", value: "c" },
      ];
      return [];
    });

    const result = await patchPhaseAggregate({
      phaseId: "phase-1",
      baseVersion: 4,
      detailOverrides: [
        { definitionId: "d1", value: "a" },
        { definitionId: "d2", value: "b" },
        { definitionId: "d3", value: "c" },
      ],
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const statements = invokeMock.mock.calls[0]?.[1]?.statements as unknown[];
    expect(statements).toHaveLength(6);
    expect(result.phase.version).toBe(5);
    expect(result.overrides).toHaveLength(3);
  });

  it("throws PhaseVersionConflictError when CAS fails", async () => {
    invokeMock.mockRejectedValueOnce(new Error("Phase version conflict"));

    await expect(
      patchPhaseAggregate({
        phaseId: "phase-1",
        baseVersion: 3,
        detailOverrides: [{ definitionId: "d1", value: "x" }],
      }),
    ).rejects.toBeInstanceOf(PhaseVersionConflictError);
  });
});
