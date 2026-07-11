import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, isElectronMock, isTauriMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isElectronMock: vi.fn(),
  isTauriMock: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  invoke: invokeMock,
  isTauri: isTauriMock,
}));

vi.mock("@/lib/shell", () => ({
  isElectron: isElectronMock,
}));

import { extractCodexCandidates } from "./candidateExtractor";

describe("extractCodexCandidates native shell gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isTauriMock.mockReturnValue(false);
    isElectronMock.mockReturnValue(false);
  });

  it("Electron では NAPI invoke へ projectId と minCount を渡す", async () => {
    isElectronMock.mockReturnValue(true);
    invokeMock.mockResolvedValue([
      {
        surface: "円明",
        lemma: "円明",
        count: 2,
        firstSceneId: "scene-1",
        context: "円明は走った。",
      },
    ]);

    await expect(extractCodexCandidates("project-1", 3)).resolves.toEqual([
      expect.objectContaining({ surface: "円明", count: 2 }),
    ]);
    expect(invokeMock).toHaveBeenCalledWith("extract_codex_candidates", {
      projectId: "project-1",
      minCount: 3,
    });
  });

  it("ブラウザでは空配列を返して invoke しない", async () => {
    await expect(extractCodexCandidates("project-1")).resolves.toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("Electron の native エラーは従来どおり空配列へ縮退する", async () => {
    isElectronMock.mockReturnValue(true);
    invokeMock.mockRejectedValue("No workspace is open");

    await expect(extractCodexCandidates("project-1")).resolves.toEqual([]);
  });
});
