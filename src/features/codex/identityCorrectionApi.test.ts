import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, writeContextMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  writeContextMock: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({ invoke: invokeMock }));
vi.mock("@/features/native-writes/writeContext", () => ({
  createCanonicalWriteContext: writeContextMock,
}));

import {
  createIdentityCorrectionRule,
  listIdentityCorrectionRules,
  retireIdentityCorrectionRule,
  supersedeIdentityCorrectionRule,
} from "./identityCorrectionApi";

const writeContext = {
  requestId: "request-1",
  sessionId: "session-1",
  writerSessionId: "session-1",
  eventUid: "event-1",
  origin: "human" as const,
  authorityRoute: "human-direct" as const,
  caller: "human-ui",
  controls: [],
  provenance: null,
  writesAuthorityProtectedField: false,
  originalTransactionId: null,
  undoJournalId: null,
};

describe("identityCorrectionApi", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    writeContextMock.mockReset().mockReturnValue(writeContext);
  });

  it("maps list and revision writes to their typed IPC commands", async () => {
    const row = { id: "revision-1", project_id: "project-1" };
    const fields = {
      kind: "must-link-surface" as const,
      scopeKind: "any" as const,
      surfaceText: "Mika",
      entryId: "entry-1",
    };
    invokeMock
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce(row);

    await expect(listIdentityCorrectionRules("project-1")).resolves.toEqual([
      row,
    ]);
    await createIdentityCorrectionRule("project-1", fields);
    await supersedeIdentityCorrectionRule("project-1", "revision-1", fields);
    await retireIdentityCorrectionRule("project-1", "revision-2");

    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      "identity_correction_rules_list",
      { projectId: "project-1" },
    );
    const createPayload = {
      ...writeContext,
      projectId: "project-1",
      fields,
      context: { sessionId: "session-1" },
    };
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "identity_correction_rule_create",
      { payload: createPayload },
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      3,
      "identity_correction_rule_supersede",
      {
        previousRevisionId: "revision-1",
        payload: createPayload,
      },
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      4,
      "identity_correction_rule_retire",
      {
        payload: {
          ...writeContext,
          projectId: "project-1",
          previousRevisionId: "revision-2",
          context: { sessionId: "session-1" },
        },
      },
    );
  });
});
