import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runTimelapseMutation: vi.fn(),
}));

const phase = {
  id: "phase-1",
  entryId: "entry-1",
  anchorNodeId: "scene-1",
  label: "Phase 1",
  summaryOverride: "old summary",
  contentOverride: "old content",
  contextModeOverride: null,
  version: 4,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

function queryResult<T>(
  rows: T[],
): Promise<T[]> & { limit: () => Promise<T[]> } {
  return Object.assign(Promise.resolve(rows), {
    limit: () => Promise.resolve(rows),
  });
}

vi.mock("@/features/timelapse/bodyWriteMode", () => mocks);
vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));
vi.mock("@/db/client", () => ({
  db: {
    select: (projection?: unknown) => ({
      from: () => ({
        where: () =>
          queryResult<unknown>(
            (projection === undefined
              ? [phase]
              : [{ projectId: "project-1" }]) as unknown[],
          ),
      }),
    }),
  },
}));
vi.mock("./impactBaselineVisibility", () => ({
  clearImpactBaselinePhaseDeletion: vi.fn(),
  markImpactBaselinePhasesRestricted: vi.fn(),
  markImpactBaselinePhaseVisible: vi.fn(),
  markImpactBaselinePhaseVisibleDeleted: vi.fn(),
}));

import { updatePhase } from "./phaseApi";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runTimelapseMutation.mockResolvedValue(undefined);
});

describe("updatePhase preexisting-draft propagation", () => {
  it("passes the permit to the Phase timelapse mutation", async () => {
    const options = { baseVersion: 4, preexistingDraft: true };

    await updatePhase("phase-1", { contentOverride: "draft content" }, options);

    expect(mocks.runTimelapseMutation).toHaveBeenCalledWith(
      "project-1",
      expect.any(Function),
      { preexistingDraft: true },
    );
  });

  it("does not add a permit to ordinary Phase mutations", async () => {
    await updatePhase(
      "phase-1",
      { contentOverride: "ordinary content" },
      { baseVersion: 4 },
    );

    expect(mocks.runTimelapseMutation).toHaveBeenCalledWith(
      "project-1",
      expect.any(Function),
      undefined,
    );
  });
});
