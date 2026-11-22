import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runTimelapseBodyWrite: vi.fn(),
  runTimelapseBodyReplacement: vi.fn(),
  runTimelapseEditorBodyWrite: vi.fn(),
  runTimelapseMutation: vi.fn(),
}));

vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));
vi.mock("./mentionRescanQueue", () => ({ enqueueRescan: vi.fn() }));
vi.mock("@/features/semantic-search/scheduler", () => ({
  scheduleCodexIndex: vi.fn(),
}));
vi.mock("@/features/ime/scheduler", () => ({
  scheduleImeExportRefresh: vi.fn(),
}));
vi.mock("./impactBaselineVisibility", () => ({
  markImpactBaselinePhasesRestricted: vi.fn(),
}));
vi.mock("@/lib/chatPersistenceDeletionGuard", () => ({
  chatPersistenceDeletionGuard: { assertDeletionAllowed: vi.fn() },
}));
vi.mock("@/lib/chatNavigationGuard", () => ({
  ChatAnchorDeletionBlockedError: class extends Error {},
  tryAcquireChatAnchorDeletionLease: vi.fn(),
}));
vi.mock("@/application/codex/codexAnchorLifecycle", () => ({
  notifyCodexAnchorDeletedIfRegistered: vi.fn(),
}));
vi.mock("@/features/foreshadow/normalizeForeshadowRow", () => ({
  normalizeForeshadowRow: vi.fn(),
}));
vi.mock("@/features/foreshadow/authoritativeRows", () => ({
  publishAuthoritativeForeshadowRows: vi.fn(),
}));
vi.mock("@/features/timelapse/bodyWriteMode", () => mocks);

import { updateCodexEntry } from "./api";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runTimelapseBodyWrite.mockResolvedValue(undefined);
  mocks.runTimelapseBodyReplacement.mockResolvedValue(undefined);
  mocks.runTimelapseEditorBodyWrite.mockResolvedValue(undefined);
  mocks.runTimelapseMutation.mockResolvedValue(undefined);
});

describe("updateCodexEntry preexisting-draft propagation", () => {
  it("passes the permit to the body-write path", async () => {
    await updateCodexEntry(
      "project-1",
      "codex-1",
      { content: "draft body" },
      { baseVersion: 4, preexistingDraft: true },
    );

    expect(mocks.runTimelapseBodyWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        content: "draft body",
        preexistingDraft: true,
      }),
      expect.any(Object),
    );
  });

  it("passes the permit to the general mutation path", async () => {
    await updateCodexEntry(
      "project-1",
      "codex-1",
      { summary: "draft summary" },
      { baseVersion: 4, preexistingDraft: true },
    );

    expect(mocks.runTimelapseMutation).toHaveBeenCalledWith(
      "project-1",
      expect.any(Function),
      { preexistingDraft: true },
    );
  });

  it("does not add a permit to ordinary body or general calls", async () => {
    await updateCodexEntry(
      "project-1",
      "codex-1",
      { content: "body" },
      {
        baseVersion: 4,
      },
    );
    await updateCodexEntry(
      "project-1",
      "codex-1",
      { summary: "summary" },
      {
        baseVersion: 4,
      },
    );

    const bodyInput = mocks.runTimelapseBodyWrite.mock.calls[0]?.[0];
    expect(bodyInput).not.toHaveProperty("preexistingDraft");
    expect(mocks.runTimelapseMutation).toHaveBeenCalledWith(
      "project-1",
      expect.any(Function),
      undefined,
    );
  });
});

describe("updateCodexEntry の自分の autosave（EAR-12）", () => {
  const capture = { commit: vi.fn(), release: vi.fn() };

  it("ownSaveCapture と content があれば fence でなく editor の hold を使う", async () => {
    await updateCodexEntry(
      "project-1",
      "codex-1",
      { content: "body" },
      { baseVersion: 4, ownSaveCapture: capture },
    );

    expect(mocks.runTimelapseBodyWrite).not.toHaveBeenCalled();
    expect(mocks.runTimelapseEditorBodyWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        documentIdentity: {
          projectId: "project-1",
          domain: "codex",
          entityType: "codex_entry",
          entityId: "codex-1",
        },
        capture,
      }),
      expect.any(Object),
    );
  });

  it("ownSaveCapture が無ければ従来の fence のまま（外部の書き換えの既定）", async () => {
    await updateCodexEntry(
      "project-1",
      "codex-1",
      { content: "body" },
      { baseVersion: 4 },
    );

    expect(mocks.runTimelapseEditorBodyWrite).not.toHaveBeenCalled();
    expect(mocks.runTimelapseBodyWrite).toHaveBeenCalledTimes(1);
  });

  it("content が無い更新は ownSaveCapture があっても hold を使わない", async () => {
    await updateCodexEntry(
      "project-1",
      "codex-1",
      { summary: "summary" },
      { baseVersion: 4, ownSaveCapture: capture },
    );

    expect(mocks.runTimelapseEditorBodyWrite).not.toHaveBeenCalled();
    expect(mocks.runTimelapseMutation).toHaveBeenCalledTimes(1);
  });

  it("preexistingDraft の permit も hold の経路へ渡す", async () => {
    await updateCodexEntry(
      "project-1",
      "codex-1",
      { content: "body" },
      { baseVersion: 4, ownSaveCapture: capture, preexistingDraft: true },
    );

    expect(mocks.runTimelapseEditorBodyWrite).toHaveBeenCalledWith(
      expect.objectContaining({ preexistingDraft: true }),
      expect.any(Object),
    );
  });
});
