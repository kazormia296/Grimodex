// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/features/editor/inlineAi/pendingGuard", () => ({
  guardInlineAiPending: () => false,
}));

import { toast } from "sonner";
import { ExternalEditConflictBanner } from "./ExternalEditConflictBanner";
import { AlreadyNotifiedSaveError } from "@/features/editor/document/saveErrors";
import { useExternalWriteStore } from "@/features/concurrency/externalWriteStore";

function renderBanner(onKeepMine: () => Promise<void>) {
  act(() => {
    useExternalWriteStore.getState().pushConflict({
      sceneId: "node-1",
      domain: "codex",
      opType: "update",
      entityId: "node-1",
    });
  });
  render(
    <ExternalEditConflictBanner nodeId="node-1" onKeepMine={onKeepMine} />,
  );
}

describe("ExternalEditConflictBanner の失敗 toast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useExternalWriteStore.getState().clear();
  });

  it("AlreadyNotifiedSaveError（store が通知済み）では toast を重ねない。cause があっても文面を変えない", async () => {
    renderBanner(() =>
      Promise.reject(
        new AlreadyNotifiedSaveError("snippet save not persisted", {
          cause: new Error("WORKSPACE_QUARANTINED: fenced"),
        }),
      ),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("external-edit-keep"));
    });
    expect(toast.error).not.toHaveBeenCalled();
    // 解消できていないので conflict は残る。
    expect(useExternalWriteStore.getState().conflicts).toHaveLength(1);
  });

  it("ほかの error は従来どおり autoSave.failed の toast を出す", async () => {
    renderBanner(() => Promise.reject(new Error("boom")));
    await act(async () => {
      fireEvent.click(screen.getByTestId("external-edit-keep"));
    });
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toContain("boom");
  });
});
