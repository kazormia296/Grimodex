import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/lib/tauri", () => ({ invoke: invokeMock }));

import {
  createScanStagingProject,
  publishScanStagingProject,
} from "./scanStagingProject";
import { createCanonicalWriteContext } from "@/features/native-writes/writeContext";

const publishReceipt = {
  projectId: "project-1",
  semanticEpochId: "epoch-1",
  __writeReceipt: {
    changeEventUid: "event-1",
    maintenanceTransactionId: "tx-1",
    undoJournalId: null,
  },
};

describe("createScanStagingProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeMock.mockResolvedValue(JSON.stringify(publishReceipt));
  });

  it("creates the project and hidden marker in one native transaction", async () => {
    await createScanStagingProject({
      id: "project-1",
      title: "Imported novel",
      language: "en",
    });

    expect(invokeMock).toHaveBeenCalledOnce();
    const [command, payload] = invokeMock.mock.calls[0]!;
    expect(command).toBe("scan_staging_project_create");
    expect(payload).toMatchObject({
      payload: {
        id: "project-1",
        title: "Imported novel",
        language: "en",
        createdAt: expect.any(String),
      },
    });
  });

  it("publishes through the typed Scan writer with exact import authority", async () => {
    const context = createCanonicalWriteContext(
      "import",
      undefined,
      "scan-publish-request-authority",
    );
    invokeMock.mockResolvedValue(
      JSON.stringify({
        ...publishReceipt,
        __writeReceipt: {
          ...publishReceipt.__writeReceipt,
          changeEventUid: context.eventUid,
        },
      }),
    );
    await publishScanStagingProject("project-1", context);

    expect(invokeMock).toHaveBeenCalledOnce();
    const [command, payload] = invokeMock.mock.calls[0]!;
    expect(command).toBe("scan_staging_project_publish");
    expect(payload).toMatchObject({
      payload: {
        projectId: "project-1",
        origin: "import",
        authorityRoute: "import-apply",
        caller: "import-session",
        controls: expect.arrayContaining([
          "import-policy",
          "source-package-evidence",
          "typed-writer",
          "occ",
          "change-event",
          "change-feed",
        ]),
        originalTransactionId: null,
        undoJournalId: null,
      },
    });
  });

  it("replays the exact canonical publish request after an ambiguous outcome", async () => {
    const context = createCanonicalWriteContext(
      "import",
      undefined,
      "scan-publish-request-1",
    );
    invokeMock
      .mockRejectedValueOnce({ outcome: "unknown" })
      .mockResolvedValueOnce(
        JSON.stringify({
          ...publishReceipt,
          __writeReceipt: {
            ...publishReceipt.__writeReceipt,
            changeEventUid: context.eventUid,
          },
        }),
      );
    const expectedReceipt = {
      ...publishReceipt,
      __writeReceipt: {
        ...publishReceipt.__writeReceipt,
        changeEventUid: context.eventUid,
      },
    };

    const result = await publishScanStagingProject("project-1", context);

    expect(result).toEqual(expectedReceipt);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock.mock.calls[0]?.[0]).toBe("scan_staging_project_publish");
    expect(invokeMock.mock.calls[1]?.[0]).toBe("scan_staging_project_publish");
    expect(invokeMock.mock.calls[1]?.[1]).toEqual(
      invokeMock.mock.calls[0]?.[1],
    );
  });

  it("propagates an explicit native failure without replaying", async () => {
    const knownFailure = Object.assign(
      new Error("native publish rolled back"),
      {
        outcome: "failed" as const,
      },
    );
    invokeMock.mockRejectedValueOnce(knownFailure);

    await expect(publishScanStagingProject("project-1")).rejects.toBe(
      knownFailure,
    );
    expect(invokeMock).toHaveBeenCalledOnce();
  });

  it("retains ambiguity when the replay cannot acknowledge the first attempt", async () => {
    const replayFailure = Object.assign(new Error("replay response failed"), {
      outcome: "failed" as const,
    });
    invokeMock
      .mockRejectedValueOnce({ outcome: "unknown" })
      .mockRejectedValueOnce(replayFailure);

    await expect(publishScanStagingProject("project-1")).rejects.toMatchObject({
      outcome: "unknown",
    });
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock.mock.calls[1]?.[1]).toEqual(
      invokeMock.mock.calls[0]?.[1],
    );
  });
});
