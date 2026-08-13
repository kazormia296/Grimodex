import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockInvoke, mockSessionId } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockSessionId: vi.fn(() => "integrity-session"),
}));

vi.mock("@/lib/tauri", () => ({ invoke: mockInvoke }));
vi.mock("@/features/timelapse/recorder", () => ({
  getRecorderSessionId: mockSessionId,
}));

import { checkProjectIntegrity, repairProjectIntegrity } from "./integrityApi";

describe("project integrity Native API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scopes the read-only check to the active project", async () => {
    mockInvoke.mockResolvedValueOnce({
      orphanedCodexSources: 0,
      orphanedSnippetSources: 0,
      orphanedSnippetScenes: 0,
    });

    await checkProjectIntegrity("project-a");

    expect(mockInvoke).toHaveBeenCalledWith("integrity_check", {
      projectId: "project-a",
    });
  });

  it("retains the exact repair identity after an unknown outcome and rotates after success", async () => {
    mockInvoke
      .mockRejectedValueOnce({ outcome: "unknown" })
      .mockResolvedValueOnce({
        codexSourcesFixed: 1,
        snippetSourcesFixed: 0,
        snippetScenesFixed: 0,
      })
      .mockResolvedValueOnce({
        codexSourcesFixed: 0,
        snippetSourcesFixed: 0,
        snippetScenesFixed: 0,
      });

    await expect(repairProjectIntegrity("project-a")).rejects.toEqual({
      outcome: "unknown",
    });
    await repairProjectIntegrity("project-a");
    await repairProjectIntegrity("project-a");

    const first = mockInvoke.mock.calls[0]?.[1].payload;
    const retry = mockInvoke.mock.calls[1]?.[1].payload;
    const next = mockInvoke.mock.calls[2]?.[1].payload;
    expect(retry).toEqual(first);
    expect(first).toMatchObject({
      projectId: "project-a",
      sessionId: "integrity-session",
      eventUid: first.requestId,
    });
    expect(next.requestId).not.toBe(first.requestId);
    expect(next.eventUid).toBe(next.requestId);
  });

  it("releases a definitely failed request before the next explicit attempt", async () => {
    mockInvoke
      .mockRejectedValueOnce({ outcome: "failed" })
      .mockResolvedValueOnce({
        codexSourcesFixed: 0,
        snippetSourcesFixed: 0,
        snippetScenesFixed: 0,
      });

    await expect(repairProjectIntegrity("project-b")).rejects.toEqual({
      outcome: "failed",
    });
    await repairProjectIntegrity("project-b");

    expect(mockInvoke.mock.calls[1]?.[1].payload.requestId).not.toBe(
      mockInvoke.mock.calls[0]?.[1].payload.requestId,
    );
  });
});
