import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/lib/tauri", () => ({ invoke: invokeMock }));

import { createScanStagingProject } from "./scanStagingProject";

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
});
