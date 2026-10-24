// @vitest-environment happy-dom
import { beforeEach, describe, it, expect, vi } from "vitest";

// DA-2b M (DR-DA2-51, DR-DA2B-R3): the version writers are typed Native
// writers. Numbering (the former `coalesce(max(...)) + 1` sub-select race
// fix) and the "same content as the latest version" check happen inside one
// Native transaction (cargo `d2a_m_t_typed_writers`); the renderer sends no
// generic SQL for them, in either mode (D-11 (a)).

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@/lib/tauri", () => ({ invoke: invokeMock }));
vi.mock("@/lib/debugLog", () => ({
  debugLog: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  errorDetail: (error: unknown) => ({ error: String(error) }),
}));

import { debugLog } from "@/lib/debugLog";
import { createRevision, pruneRevisions, type RevisionWriteScope } from "./api";

const current: RevisionWriteScope = { projectId: "p1", isCurrent: () => true };
const stale: RevisionWriteScope = { projectId: "p1", isCurrent: () => false };

beforeEach(() => {
  invokeMock.mockReset();
  vi.mocked(debugLog.warn).mockClear();
});

describe("createRevision", () => {
  it("sends revision_create with the owner project and builds the version from the request", async () => {
    invokeMock.mockResolvedValueOnce({
      created: true,
      id: "v2",
      versionNumber: 2,
      createdAt: "2026-10-24T00:00:00.000Z",
    });

    const rev = await createRevision({
      scope: current,
      entityType: "scene",
      entityId: "s1",
      content: "X",
      snapshotType: "auto",
    });

    expect(invokeMock.mock.calls).toEqual([
      [
        "revision_create",
        {
          payload: {
            projectId: "p1",
            entityType: "scene",
            entityId: "s1",
            content: "X",
            snapshotType: "auto",
          },
        },
      ],
    ]);
    // The same `ContentVersion` the legacy RETURNING row gave.
    expect(rev).toEqual({
      id: "v2",
      entityType: "scene",
      entityId: "s1",
      content: "X",
      versionNumber: 2,
      snapshotType: "auto",
      createdAt: "2026-10-24T00:00:00.000Z",
    });
  });

  it("answers null for the latest version's content (created: false), as before", async () => {
    invokeMock.mockResolvedValueOnce({
      created: false,
      id: "v1",
      versionNumber: 1,
      createdAt: "2026-10-23T00:00:00.000Z",
    });
    await expect(
      createRevision({
        scope: current,
        entityType: "codex_entry",
        entityId: "c1",
        content: "same",
        snapshotType: "manual",
      }),
    ).resolves.toBeNull();
  });

  it.each([
    "REVISION_WRITE_REFUSED:not-found",
    "Error: REVISION_WRITE_REFUSED:invalid-request",
  ])(
    "turns the typed refusal %s into null with a warn only",
    async (message) => {
      invokeMock.mockRejectedValueOnce(new Error(message));
      await expect(
        createRevision({
          scope: current,
          entityType: "scene",
          entityId: "gone",
          content: "X",
          snapshotType: "auto",
        }),
      ).resolves.toBeNull();
      expect(debugLog.warn).toHaveBeenCalledWith(
        "Revision",
        "version write refused",
        expect.anything(),
      );
    },
  );

  it("keeps other failures as failures", async () => {
    invokeMock.mockRejectedValueOnce(new Error("No workspace is open"));
    await expect(
      createRevision({
        scope: current,
        entityType: "scene",
        entityId: "s1",
        content: "X",
        snapshotType: "auto",
      }),
    ).rejects.toThrow("No workspace is open");
  });

  it("writes nothing once the captured workspace is no longer bound", async () => {
    await expect(
      createRevision({
        scope: stale,
        entityType: "scene",
        entityId: "s1",
        content: "X",
        snapshotType: "auto",
      }),
    ).resolves.toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("pruneRevisions", () => {
  it("sends revision_prune with the default keep count of 50", async () => {
    invokeMock.mockResolvedValueOnce({ deleted: 3 });
    await pruneRevisions(current, "snippet", "n1");
    expect(invokeMock.mock.calls).toEqual([
      [
        "revision_prune",
        {
          payload: {
            projectId: "p1",
            entityType: "snippet",
            entityId: "n1",
            keepCount: 50,
          },
        },
      ],
    ]);
  });

  it("swallows a typed refusal and skips a stale scope", async () => {
    invokeMock.mockRejectedValueOnce(
      new Error("REVISION_WRITE_REFUSED:not-found"),
    );
    await expect(
      pruneRevisions(current, "scene", "gone", 10),
    ).resolves.toBeUndefined();
    await pruneRevisions(stale, "scene", "s1", 10);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
