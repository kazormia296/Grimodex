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

describe("createScanStagingProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeMock.mockResolvedValue(undefined);
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
    await publishScanStagingProject("project-1");

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
});
