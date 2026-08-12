import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const limitMock = vi.fn();
let selectQueue: unknown[][] = [];

function takeSelectResult(): Promise<unknown[]> {
  return Promise.resolve(selectQueue.shift() ?? []);
}

vi.mock("@/lib/tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("./impactBaselineVisibility", () => ({
  clearImpactBaselinePhaseDeletion: vi.fn(),
  markImpactBaselinePhasesRestricted: vi.fn(),
  markImpactBaselinePhaseVisible: vi.fn(),
  markImpactBaselinePhaseVisibleDeleted: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: (...args: unknown[]) => {
            limitMock(...args);
            return takeSelectResult();
          },
          then: (
            resolve: (value: unknown[]) => void,
            reject: (reason: unknown) => void,
          ) => takeSelectResult().then(resolve, reject),
        }),
      }),
    }),
  },
}));

import { patchPhaseAggregate } from "./phaseApi";
import { PhaseVersionConflictError } from "./phaseOcc";

const currentPhase = {
  id: "phase-1",
  entryId: "entry-1",
  version: 4,
  contextModeOverride: null,
};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  limitMock.mockReset();
  selectQueue = [];
});

describe("patchPhaseAggregate", () => {
  it("uses one typed aggregate mutation and observes one persisted version bump", async () => {
    const detailOverrides = [
      { definitionId: "d1", value: "a" },
      { definitionId: "d2", value: "b" },
      { definitionId: "d3", value: "c" },
    ];
    selectQueue.push(
      [currentPhase],
      [{ projectId: "project-1" }],
      [{ ...currentPhase, version: 5, label: "死亡" }],
      detailOverrides.map((row) => ({ phaseId: "phase-1", ...row })),
    );

    const result = await patchPhaseAggregate({
      phaseId: "phase-1",
      baseVersion: 4,
      label: "死亡",
      detailOverrides,
    });

    expect(limitMock).toHaveBeenCalledWith(1);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("agent_codex_mutate", {
      payload: expect.objectContaining({
        operation: "phase.aggregate",
        projectId: "project-1",
        surface: "manual",
        phaseId: "phase-1",
        baseVersion: 4,
        label: "死亡",
        detailOverrides,
      }),
    });
    expect(result.phase.version).toBe(5);
    expect(result.overrides).toHaveLength(3);
  });

  it("maps a typed aggregate CAS failure to PhaseVersionConflictError", async () => {
    selectQueue.push([currentPhase], [{ projectId: "project-1" }]);
    invokeMock.mockRejectedValueOnce(new Error("Phase version conflict"));

    await expect(
      patchPhaseAggregate({
        phaseId: "phase-1",
        baseVersion: 3,
        detailOverrides: [{ definitionId: "d1", value: "x" }],
      }),
    ).rejects.toBeInstanceOf(PhaseVersionConflictError);
    expect(limitMock).toHaveBeenCalledWith(1);
  });
});
