import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const scheduleImeExportRefreshMock = vi.fn();
const publishAuthoritativeForeshadowRowsMock = vi.fn();
let selectQueue: unknown[][] = [];

function takeSelectResult(): Promise<unknown[]> {
  return Promise.resolve(selectQueue.shift() ?? []);
}

vi.mock("@/db/client", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          then: (
            resolve: (value: unknown[]) => void,
            reject: (reason: unknown) => void,
          ) => takeSelectResult().then(resolve, reject),
        }),
      }),
    }),
  },
}));

vi.mock("@/lib/tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@/features/semantic-search/scheduler", () => ({
  scheduleCodexIndex: vi.fn(),
}));

vi.mock("@/features/ime/scheduler", () => ({
  scheduleImeExportRefresh: (...args: unknown[]) =>
    scheduleImeExportRefreshMock(...args),
}));

vi.mock("./impactBaselineVisibility", () => ({
  markImpactBaselinePhasesRestricted: vi.fn(),
}));

vi.mock("./mentionRescanQueue", () => ({ enqueueRescan: vi.fn() }));

vi.mock("@/features/foreshadow/normalizeForeshadowRow", () => ({
  normalizeForeshadowRow: (row: unknown) => row,
}));

vi.mock("@/features/foreshadow/authoritativeRows", () => ({
  publishAuthoritativeForeshadowRows: (...args: unknown[]) =>
    publishAuthoritativeForeshadowRowsMock(...args),
}));

import { updateCodexEntry } from "./api";
import { CodexVersionConflictError } from "./occ";

const currentEntry = {
  id: "e1",
  projectId: "p",
  version: 2,
  name: "A",
  aliases: null,
  excludedAliases: null,
  readings: '{"A":["a"]}',
};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({
    entityId: "e1",
    version: 3,
    changeEventUid: "native-event",
    maintenanceTransactionId: "native-transaction",
    undoJournalId: "native-journal",
    relatedForeshadows: [],
  });
  scheduleImeExportRefreshMock.mockReset();
  publishAuthoritativeForeshadowRowsMock.mockReset();
  selectQueue = [];
});

describe("updateCodexEntry OCC (base_version)", () => {
  it("baseVersion 一致で typed writer を呼び、永続化後の version を返す", async () => {
    const content = JSON.stringify({
      type: "doc",
      content: [{ type: "text", text: "x" }],
    });
    selectQueue.push(
      [currentEntry],
      [{ ...currentEntry, version: 3, content }],
    );

    const result = await updateCodexEntry(
      "p",
      "e1",
      { content },
      { baseVersion: 2 },
    );

    expect(invokeMock).toHaveBeenCalledWith("agent_codex_update", {
      payload: expect.objectContaining({
        projectId: "p",
        entryId: "e1",
        surface: "manual",
        baseVersion: 2,
        content,
        canonicalPayload: {
          fields: ["content"],
          diffs: {
            content: {
              segments: [[1, "x"]],
            },
          },
        },
      }),
    });
    expect(result?.version).toBe(3);
    expect(result?.__writeReceipt).toEqual({
      changeEventUid: "native-event",
      maintenanceTransactionId: "native-transaction",
      undoJournalId: "native-journal",
    });
    expect(Object.keys(result ?? {})).not.toContain("__writeReceipt");
    expect(JSON.stringify(result)).not.toContain("__writeReceipt");
  });

  it("publishes linked Foreshadow dirty rows returned by the same native write", async () => {
    const relatedForeshadows = [
      { id: "foreshadow-b", projectId: "p", version: 4 },
      { id: "foreshadow-a", projectId: "p", version: 7 },
    ];
    invokeMock.mockResolvedValueOnce({
      entityId: "e1",
      version: 3,
      changeEventUid: "native-event",
      maintenanceTransactionId: "native-transaction",
      undoJournalId: "native-journal",
      relatedForeshadows,
    });
    selectQueue.push(
      [currentEntry],
      [{ ...currentEntry, version: 3, name: "B" }],
    );

    await updateCodexEntry("p", "e1", { name: "B" });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(publishAuthoritativeForeshadowRowsMock).toHaveBeenCalledWith(
      relatedForeshadows,
    );
  });

  it("typed writer の CAS 失敗を CodexVersionConflictError に変換する", async () => {
    selectQueue.push([currentEntry]);
    invokeMock.mockRejectedValueOnce(new Error("Codex version conflict"));

    await expect(
      updateCodexEntry("p", "e1", { content: "x" }, { baseVersion: 1 }),
    ).rejects.toBeInstanceOf(CodexVersionConflictError);
  });

  it("別プロジェクトを含む未検出行は undefined のまま返す", async () => {
    selectQueue.push([]);

    const result = await updateCodexEntry(
      "p",
      "e1",
      { content: "x" },
      { baseVersion: 2 },
    );

    expect(result).toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("baseVersion 省略時も pre-read した version で typed OCC writer を呼ぶ", async () => {
    selectQueue.push(
      [currentEntry],
      [{ ...currentEntry, version: 3, content: "x" }],
    );

    const result = await updateCodexEntry("p", "e1", { content: "x" });

    expect(invokeMock).toHaveBeenCalledWith("agent_codex_update", {
      payload: expect.objectContaining({
        projectId: "p",
        entryId: "e1",
        baseVersion: 2,
        content: "x",
      }),
    });
    expect(result?.version).toBe(3);
  });

  it("baseSurface が pre-read surface と一致すれば typed writer へ進む", async () => {
    selectQueue.push([currentEntry], [{ ...currentEntry, version: 3 }]);

    await updateCodexEntry(
      "p",
      "e1",
      { readings: '{"A":["a"],"B":["b"]}' },
      {
        baseVersion: 2,
        baseSurface: {
          name: "A",
          aliases: null,
          excludedAliases: null,
          readings: '{"A":["a"]}',
        },
      },
    );

    expect(invokeMock).toHaveBeenCalledWith("agent_codex_update", {
      payload: expect.objectContaining({
        entryId: "e1",
        baseVersion: 2,
        readings: '{"A":["a"],"B":["b"]}',
      }),
    });
  });

  it("baseSurface.readings が stale なら native write 前に conflict にする", async () => {
    selectQueue.push([{ ...currentEntry, readings: '{"A":["updated"]}' }]);

    await expect(
      updateCodexEntry(
        "p",
        "e1",
        { readings: '{"A":["a"]}' },
        {
          baseVersion: 2,
          baseSurface: {
            name: "A",
            aliases: null,
            excludedAliases: null,
            readings: null,
          },
        },
      ),
    ).rejects.toBeInstanceOf(CodexVersionConflictError);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("baseSurface の name / aliases / excludedAliases の stale 値も conflict にする", async () => {
    selectQueue.push([{ ...currentEntry, aliases: '["current"]' }]);

    await expect(
      updateCodexEntry(
        "p",
        "e1",
        { aliases: '["next"]' },
        {
          baseVersion: 2,
          baseSurface: {
            name: "A",
            aliases: null,
            excludedAliases: null,
            readings: '{"A":["a"]}',
          },
        },
      ),
    ).rejects.toBeInstanceOf(CodexVersionConflictError);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("updateCodexEntry IME refresh trigger", () => {
  const relevantPatches: Array<
    [string, Parameters<typeof updateCodexEntry>[2]]
  > = [
    ["type", { type: "character" }],
    ["name", { name: "changed" }],
    ["aliases", { aliases: "[]" }],
    ["excludedAliases", { excludedAliases: "[]" }],
    ["readings", { readings: "{}" }],
    ["contextMode", { contextMode: "hidden" }],
  ];

  it.each(relevantPatches)(
    "refreshes after a successful %s typed mutation",
    async (_, patch) => {
      selectQueue.push([currentEntry], [{ ...currentEntry, version: 3 }]);

      await updateCodexEntry("p", "e1", patch);

      expect(invokeMock).toHaveBeenCalledWith("agent_codex_update", {
        payload: expect.objectContaining({
          projectId: "p",
          entryId: "e1",
          baseVersion: 2,
        }),
      });
      expect(scheduleImeExportRefreshMock).toHaveBeenCalledWith("p");
    },
  );

  it("does not refresh for content-only mutations", async () => {
    selectQueue.push(
      [currentEntry],
      [{ ...currentEntry, version: 3, content: "x" }],
    );

    await updateCodexEntry("p", "e1", { content: "x" });

    expect(scheduleImeExportRefreshMock).not.toHaveBeenCalled();
  });

  it("does not refresh when no row was updated", async () => {
    selectQueue.push([]);

    await updateCodexEntry("p", "e1", { name: "changed" });

    expect(scheduleImeExportRefreshMock).not.toHaveBeenCalled();
  });
});
