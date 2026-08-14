import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const limitMock = vi.fn();
let selectQueue: unknown[][] = [];

function takeSelectResult(): Promise<unknown[]> {
  return Promise.resolve(selectQueue.shift() ?? []);
}

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

vi.mock("@/lib/tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { createDefinition, updateDefinition, upsertValue } from "./detailApi";
import {
  DetailDefinitionVersionConflictError,
  DetailValueVersionConflictError,
} from "./detailOcc";

const definition = {
  id: "d1",
  projectId: "p1",
  typeSlug: "character",
  name: "年齢",
  fieldType: "dropdown",
  fieldConfig: '{"options":["主人公","脇役"]}',
  sortOrder: 1,
  includeInContext: 0,
  version: 2,
};

const existingValue = {
  id: "v1",
  entryId: "e1",
  definitionId: "d1",
  value: "主人公",
  version: 2,
};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  limitMock.mockReset();
  selectQueue = [];
});

describe("detailApi OCC", () => {
  it("createDefinition uses the typed writer and returns persisted version 0", async () => {
    selectQueue.push([{ ...definition, version: 0 }]);

    const created = await createDefinition({
      id: "d1",
      projectId: "p1",
      typeSlug: "character",
      name: "年齢",
    });

    expect(invokeMock).toHaveBeenCalledWith("agent_codex_mutate", {
      payload: expect.objectContaining({
        operation: "detail.definition.create",
        projectId: "p1",
        surface: "manual",
        definitionId: "d1",
        typeSlug: "character",
        name: "年齢",
      }),
    });
    expect(limitMock).toHaveBeenCalledWith(1);
    expect(created.version).toBe(0);
  });

  it("passes an optional semantic binding through the definition writer", async () => {
    selectQueue.push([{ ...definition, version: 0 }]);

    await createDefinition({
      id: "d1",
      projectId: "p1",
      typeSlug: "character",
      name: "Role",
      semanticBinding: {
        id: "binding-1",
        facetKey: "role.current",
        projectionKind: "enum",
        temporalPolicy: "base-and-phase",
        source: "preset",
        confirmed: false,
      },
    });

    expect(invokeMock).toHaveBeenCalledWith("agent_codex_mutate", {
      payload: expect.objectContaining({
        operation: "detail.definition.create",
        definitionId: "d1",
        semanticBinding: {
          id: "binding-1",
          facetKey: "role.current",
          projectionKind: "enum",
          temporalPolicy: "base-and-phase",
          source: "preset",
          confirmed: false,
        },
      }),
    });
  });

  it("preserves an explicit import write context for definition creation", async () => {
    selectQueue.push([{ ...definition, version: 0 }]);
    const writeContext = {
      requestId: "import-definition-request",
      sessionId: "import-session",
      eventUid: "import-definition-event",
      origin: "import" as const,
      authorityRoute: "import-apply" as const,
      caller: "import-session",
      controls: [
        "import-policy",
        "source-package-evidence",
        "typed-writer",
        "occ",
        "change-event",
        "change-feed",
      ] as const,
      provenance: null,
      writesAuthorityProtectedField: false,
      originalTransactionId: null,
      undoJournalId: null,
    };

    await createDefinition(
      {
        id: "d1",
        projectId: "p1",
        typeSlug: "character",
        name: "Role",
      },
      { writeContext },
    );

    expect(invokeMock).toHaveBeenCalledWith("agent_codex_mutate", {
      payload: expect.objectContaining(writeContext),
    });
  });

  it("updateDefinition sends baseVersion and returns the persisted CAS bump", async () => {
    selectQueue.push(
      [definition],
      [{ ...definition, version: 3, includeInContext: 1 }],
    );

    const updated = await updateDefinition(
      "d1",
      { includeInContext: 1 },
      { baseVersion: 2 },
    );

    expect(invokeMock).toHaveBeenCalledWith("agent_codex_mutate", {
      payload: expect.objectContaining({
        operation: "detail.definition.update",
        projectId: "p1",
        definitionId: "d1",
        baseVersion: 2,
        includeInContext: 1,
      }),
    });
    expect(updated?.version).toBe(3);
  });

  it("updateDefinition maps a typed writer conflict", async () => {
    selectQueue.push([definition]);
    invokeMock.mockRejectedValueOnce(
      new Error("Detail definition version conflict"),
    );

    await expect(
      updateDefinition("d1", { name: "x" }, { baseVersion: 1 }),
    ).rejects.toBeInstanceOf(DetailDefinitionVersionConflictError);
  });

  it("upsertValue pre-reads entry ownership and returns the inserted version", async () => {
    selectQueue.push(
      [definition],
      [],
      [{ projectId: "p1" }],
      [{ ...existingValue, version: 1 }],
    );

    const saved = await upsertValue("e1", "d1", "主人公");

    expect(limitMock).toHaveBeenCalledWith(1);
    expect(invokeMock).toHaveBeenCalledWith("agent_codex_mutate", {
      payload: expect.objectContaining({
        operation: "detail.value.upsert",
        projectId: "p1",
        entryId: "e1",
        definitionId: "d1",
        value: "主人公",
      }),
    });
    expect(saved.version).toBe(1);
  });

  it("upsertValue sends baseVersion and returns the persisted CAS bump", async () => {
    selectQueue.push(
      [definition],
      [existingValue],
      [{ projectId: "p1" }],
      [{ ...existingValue, value: "脇役", version: 3 }],
    );

    const saved = await upsertValue("e1", "d1", "脇役", {
      baseVersion: 2,
    });

    expect(limitMock).toHaveBeenCalledWith(1);
    expect(invokeMock).toHaveBeenCalledWith("agent_codex_mutate", {
      payload: expect.objectContaining({
        operation: "detail.value.upsert",
        projectId: "p1",
        entryId: "e1",
        definitionId: "d1",
        value: "脇役",
        baseVersion: 2,
      }),
    });
    expect(saved.version).toBe(3);
  });

  it("preserves an explicit import write context for value creation", async () => {
    selectQueue.push(
      [definition],
      [],
      [{ projectId: "p1" }],
      [{ ...existingValue, version: 1 }],
    );
    const writeContext = {
      requestId: "import-value-request",
      sessionId: "import-session",
      eventUid: "import-value-event",
      origin: "import" as const,
      authorityRoute: "import-apply" as const,
      caller: "import-session",
      controls: [
        "import-policy",
        "source-package-evidence",
        "typed-writer",
        "occ",
        "change-event",
        "change-feed",
      ] as const,
      provenance: null,
      writesAuthorityProtectedField: false,
      originalTransactionId: null,
      undoJournalId: null,
    };

    await upsertValue("e1", "d1", "主人公", { writeContext });

    expect(invokeMock).toHaveBeenCalledWith("agent_codex_mutate", {
      payload: expect.objectContaining(writeContext),
    });
  });

  it("upsertValue maps a stale typed writer conflict", async () => {
    selectQueue.push(
      [definition],
      [{ ...existingValue, version: 4 }],
      [{ projectId: "p1" }],
    );
    invokeMock.mockRejectedValueOnce(
      new Error("Detail value version conflict"),
    );

    await expect(
      upsertValue("e1", "d1", "主人公", { baseVersion: 2 }),
    ).rejects.toBeInstanceOf(DetailValueVersionConflictError);
  });

  it("upsertValue rejects updates without baseVersion before ownership lookup", async () => {
    selectQueue.push([definition], [existingValue]);

    await expect(upsertValue("e1", "d1", "主人公")).rejects.toBeInstanceOf(
      DetailValueVersionConflictError,
    );
    expect(limitMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
