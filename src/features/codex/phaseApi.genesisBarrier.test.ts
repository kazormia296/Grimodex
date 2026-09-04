import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  currentProjectId: "project-1",
  clearImpactBaselinePhaseDeletion: vi.fn(),
  markImpactBaselinePhasesRestricted: vi.fn(),
  markImpactBaselinePhaseVisible: vi.fn(),
  markImpactBaselinePhaseVisibleDeleted: vi.fn(),
}));

const phase = {
  id: "phase-1",
  entryId: "entry-1",
  anchorNodeId: null,
  label: "Phase 1",
  summaryOverride: null,
  contentOverride: null,
  contextModeOverride: null,
  version: 4,
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
};

function queryResult<T>(
  rows: T[],
): Promise<T[]> & { limit: () => Promise<T[]> } {
  return Object.assign(Promise.resolve(rows), {
    limit: () => Promise.resolve(rows),
  });
}

vi.mock("@/lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("@/application/project/currentProjectAuthority", () => ({
  getCurrentProjectId: () => mocks.currentProjectId,
}));
vi.mock("@/db/client", () => ({
  db: {
    select: (projection?: unknown) => ({
      from: () => ({
        where: () =>
          queryResult(
            projection === undefined
              ? [
                  {
                    ...phase,
                    version: mocks.invoke.mock.calls.length > 0 ? 5 : 4,
                  },
                ]
              : [{ projectId: "project-1" }],
          ),
      }),
    }),
  },
}));
vi.mock("./impactBaselineVisibility", () => ({
  clearImpactBaselinePhaseDeletion: mocks.clearImpactBaselinePhaseDeletion,
  markImpactBaselinePhasesRestricted: mocks.markImpactBaselinePhasesRestricted,
  markImpactBaselinePhaseVisible: mocks.markImpactBaselinePhaseVisible,
  markImpactBaselinePhaseVisibleDeleted:
    mocks.markImpactBaselinePhaseVisibleDeleted,
}));

import {
  _resetTimelapseGenesisBarriersForTests,
  beginTimelapseGenesisBarrier,
} from "@/features/timelapse/genesisBarrier";
import { createPhase, patchPhaseAggregate, updatePhase } from "./phaseApi";

beforeEach(() => {
  vi.clearAllMocks();
  _resetTimelapseGenesisBarriersForTests();
  mocks.currentProjectId = "project-1";
  mocks.invoke.mockResolvedValue(undefined);
  mocks.clearImpactBaselinePhaseDeletion.mockResolvedValue(undefined);
  mocks.markImpactBaselinePhasesRestricted.mockResolvedValue(undefined);
  mocks.markImpactBaselinePhaseVisible.mockResolvedValue(undefined);
  mocks.markImpactBaselinePhaseVisibleDeleted.mockResolvedValue(undefined);
});

describe("updatePhase contentOverride genesis barrier", () => {
  it("does not invoke the Native writer while genesis is pending", async () => {
    const genesis = beginTimelapseGenesisBarrier("project-1");
    const update = updatePhase(
      "phase-1",
      { contentOverride: '{"type":"doc","content":[]}' },
      { baseVersion: 4 },
    );

    await Promise.resolve();
    await Promise.resolve();
    const callsBeforeRelease = mocks.invoke.mock.calls.length;
    genesis.complete();
    await update;

    expect(callsBeforeRelease).toBe(0);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(
      "codex_mutate",
      expect.objectContaining({
        payload: expect.objectContaining({
          operation: "phase.update",
          projectId: "project-1",
          contentOverride: '{"type":"doc","content":[]}',
        }),
      }),
    );
  });

  it("fails closed without invoking Native after genesis failure", async () => {
    const genesis = beginTimelapseGenesisBarrier("project-1");
    const failure = new Error("genesis E1");
    genesis.fail(failure);

    await expect(
      updatePhase(
        "phase-1",
        { contentOverride: '{"type":"doc","content":[]}' },
        { baseVersion: 4 },
      ),
    ).rejects.toMatchObject({
      name: "TimelapseGenesisBarrierError",
      cause: failure,
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("Phase creation/aggregate genesis barrier", () => {
  it("holds create content before every impact/native side effect", async () => {
    const genesis = beginTimelapseGenesisBarrier("project-1");
    const creation = createPhase({
      ...phase,
      contentOverride: '{"type":"doc","content":[]}',
      contextModeOverride: "never",
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.markImpactBaselinePhasesRestricted).not.toHaveBeenCalled();

    genesis.complete();
    await creation;
    expect(mocks.invoke).toHaveBeenCalledWith(
      "codex_mutate",
      expect.objectContaining({
        payload: expect.objectContaining({
          operation: "phase.create",
          projectId: "project-1",
        }),
      }),
    );
  });

  it("fails create content closed with zero impact/native side effects", async () => {
    const genesis = beginTimelapseGenesisBarrier("project-1");
    genesis.fail(new Error("genesis failed"));

    await expect(
      createPhase({
        ...phase,
        contentOverride: null,
        contextModeOverride: "never",
      }),
    ).rejects.toMatchObject({ name: "TimelapseGenesisBarrierError" });
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.markImpactBaselinePhasesRestricted).not.toHaveBeenCalled();
  });

  it("blocks metadata-only create on genesis", async () => {
    const genesis = beginTimelapseGenesisBarrier("project-1");
    const creation = createPhase({
      id: phase.id,
      entryId: phase.entryId,
      label: "metadata only",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.invoke).not.toHaveBeenCalled();
    genesis.complete();
    await creation;
    expect(mocks.invoke).toHaveBeenCalledOnce();
  });

  it("holds aggregate content before every impact/native side effect", async () => {
    const genesis = beginTimelapseGenesisBarrier("project-1");
    const patch = patchPhaseAggregate({
      phaseId: phase.id,
      baseVersion: phase.version,
      content: null,
      contextMode: "never",
      detailOverrides: [],
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.markImpactBaselinePhasesRestricted).not.toHaveBeenCalled();

    genesis.complete();
    await patch;
    expect(mocks.invoke).toHaveBeenCalledWith(
      "codex_mutate",
      expect.objectContaining({
        payload: expect.objectContaining({
          operation: "phase.aggregate",
          projectId: "project-1",
        }),
      }),
    );
  });

  it("fails aggregate content closed with zero impact/native side effects", async () => {
    const genesis = beginTimelapseGenesisBarrier("project-1");
    genesis.fail(new Error("genesis failed"));

    await expect(
      patchPhaseAggregate({
        phaseId: phase.id,
        baseVersion: phase.version,
        content: '{"type":"doc"}',
        contextMode: "never",
        detailOverrides: [],
      }),
    ).rejects.toMatchObject({ name: "TimelapseGenesisBarrierError" });
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.markImpactBaselinePhasesRestricted).not.toHaveBeenCalled();
  });

  it("blocks metadata-only aggregate on genesis", async () => {
    const genesis = beginTimelapseGenesisBarrier("project-1");
    const patch = patchPhaseAggregate({
      phaseId: phase.id,
      baseVersion: phase.version,
      label: "metadata only",
      detailOverrides: [],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.invoke).not.toHaveBeenCalled();
    genesis.complete();
    await patch;
    expect(mocks.invoke).toHaveBeenCalledOnce();
  });
});
