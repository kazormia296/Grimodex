// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceViewportProvider } from "@/runtime/workspaceViewportContext";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { emptySkipReport } from "./projectSnapshotScopes";
import { ProjectSnapshotModal } from "./ProjectSnapshotModal";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  preview: vi.fn(),
  restore: vi.fn(),
  remove: vi.fn(),
  reload: vi.fn(),
  flush: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${options.count}`,
  }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: mocks.toastError, info: vi.fn() },
}));
vi.mock("@/hooks/useAutoSave", () => ({
  flushAllAutoSaves: mocks.flush,
}));
vi.mock("@/features/editor/inlineAi/pendingGuard", () => ({
  guardInlineAiPending: () => false,
}));
vi.mock("@/lib/rendererReload", () => ({
  reloadRendererAfterReleasingGpuSurfaces: mocks.reload,
}));
vi.mock("@/components/ui/animated-overlay", () => ({
  AnimatedOverlay: ({
    open,
    children,
  }: {
    open: boolean;
    children: React.ReactNode;
  }) => (open ? <div data-testid="snapshot-list">{children}</div> : null),
}));
vi.mock("./projectSnapshotApi", () => ({
  createProjectSnapshot: vi.fn(),
  listProjectSnapshots: mocks.list,
  previewProjectSnapshotRestoreLoss: mocks.preview,
  restoreProjectSnapshot: mocks.restore,
  deleteProjectSnapshot: mocks.remove,
}));

const snapshot = {
  id: "loss-preview-snapshot",
  name: "Loss Preview Snapshot",
  description: null,
  entryCount: 3,
  createdAt: "2026-11-24T00:00:00.000Z",
  isStructural: true,
};

function restoreResult(
  overrides: Partial<{
    dropped: Array<{ kind: string; count: number }>;
    noOp: boolean;
  }> = {},
) {
  return {
    restoredCount: 3,
    safetySnapshotId: "safety-snapshot",
    format: "structural" as const,
    skipped: emptySkipReport(),
    dropped: [],
    noOp: false,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function openRestoreConfirm(
  isStructural = true,
): Promise<{ onClose: ReturnType<typeof vi.fn> }> {
  const onClose = vi.fn();
  mocks.list.mockResolvedValue([{ ...snapshot, isStructural }]);
  render(
    <WorkspaceViewportProvider profile="phone">
      <ProjectSnapshotModal open onClose={onClose} />
    </WorkspaceViewportProvider>,
  );
  const row = await screen.findByText(snapshot.name);
  fireEvent.click(row.closest("button")!);
  fireEvent.click(screen.getByRole("button", { name: "snapshot.restore" }));
  await screen.findByRole("alertdialog", { name: "snapshot.restoreTitle" });
  return { onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  useGlobalHistoryStore.getState().clear();
  mocks.list.mockResolvedValue([snapshot]);
  mocks.preview.mockResolvedValue({ structural: true, lossNotices: [] });
  mocks.restore.mockResolvedValue(restoreResult());
  mocks.reload.mockResolvedValue(undefined);
  mocks.flush.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ProjectSnapshotModal restore loss notices", () => {
  it("flushes pending autosaves before restoring", async () => {
    await openRestoreConfirm();
    fireEvent.click(
      screen.getByRole("button", { name: "snapshot.restoreConfirm" }),
    );

    await waitFor(() => expect(mocks.restore).toHaveBeenCalledOnce());
    expect(mocks.flush).toHaveBeenCalledOnce();
    expect(mocks.flush.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.restore.mock.invocationCallOrder[0],
    );
    await waitFor(() => expect(mocks.reload).toHaveBeenCalledOnce());
  });

  it("keeps the confirmation open after a flush failure and allows retry", async () => {
    mocks.flush
      .mockRejectedValueOnce(new Error("autosave failed"))
      .mockResolvedValueOnce(undefined);
    await openRestoreConfirm();
    const confirmButton = screen.getByRole("button", {
      name: "snapshot.restoreConfirm",
    });

    fireEvent.click(confirmButton);
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "snapshot.restoreFlushFailed",
      ),
    );
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(
      screen.getByRole("alertdialog", { name: "snapshot.restoreTitle" }),
    ).toBeInTheDocument();
    expect(confirmButton).toBeEnabled();

    fireEvent.click(confirmButton);
    await waitFor(() => expect(mocks.restore).toHaveBeenCalledOnce());
    expect(mocks.flush).toHaveBeenCalledTimes(2);
  });

  it("treats a flush that never settles as a failure after the time limit, and allows retry", async () => {
    // 保存が resolve も reject もしないと、「復元中」のまま確認の画面が固まる。上限（30 秒）を
    // 超えたら失敗として扱い、復元を中止して、確認を開いたまま再試行できるようにする。
    // 2 回目の flush を即時に resolve させるのは、「1 回目の後に保存が回復した」場合の表現である
    // （止まったままなら、実物の 2 回目も同じ drain を待ち、また上限で中止する）。
    mocks.flush
      .mockReturnValueOnce(new Promise<void>(() => {}))
      .mockResolvedValueOnce(undefined);
    await openRestoreConfirm();
    const confirmButton = screen.getByRole("button", {
      name: "snapshot.restoreConfirm",
    });

    vi.useFakeTimers();
    fireEvent.click(confirmButton);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_999);
    });
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(confirmButton).toBeDisabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.toastError).toHaveBeenCalledWith(
      "snapshot.restoreFlushFailed",
    );
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(
      screen.getByRole("alertdialog", { name: "snapshot.restoreTitle" }),
    ).toBeInTheDocument();
    expect(confirmButton).toBeEnabled();
    vi.useRealTimers();

    fireEvent.click(confirmButton);
    await waitFor(() => expect(mocks.restore).toHaveBeenCalledOnce());
    expect(mocks.flush).toHaveBeenCalledTimes(2);
  });

  it("counts on open, debounces changed scopes, and reuses cached scope results", async () => {
    mocks.preview
      .mockResolvedValueOnce({ structural: true, lossNotices: [] })
      .mockResolvedValueOnce({
        structural: true,
        lossNotices: [{ kind: "map_edges", count: 2 }],
      });
    await openRestoreConfirm();
    vi.useFakeTimers();
    expect(mocks.preview).toHaveBeenCalledTimes(1);
    await act(async () => Promise.resolve());

    fireEvent.click(
      screen.getByRole("checkbox", { name: "snapshot.scopeCodex" }),
    );
    expect(
      screen.getByText("snapshot.loss.previewLoading"),
    ).toBeInTheDocument();
    await act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(mocks.preview).toHaveBeenCalledTimes(1);
    await act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(mocks.preview).toHaveBeenCalledTimes(2);
    await act(async () => Promise.resolve());
    expect(
      screen.getByText(/snapshot.loss.kind.map_edges/),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("checkbox", { name: "snapshot.scopeCodex" }),
    );
    await act(async () => Promise.resolve());
    expect(mocks.preview).toHaveBeenCalledTimes(2);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "snapshot.scopeCodex" }),
    );
    expect(
      screen.getByText(/snapshot.loss.kind.map_edges/),
    ).toBeInTheDocument();
    expect(mocks.preview).toHaveBeenCalledTimes(2);
  });

  it("ignores an older preview response after a newer scope request", async () => {
    const oldRequest = deferred<{
      structural: boolean;
      lossNotices: Array<{ kind: string; count: number }>;
    }>();
    const newRequest = deferred<{
      structural: boolean;
      lossNotices: Array<{ kind: string; count: number }>;
    }>();
    mocks.preview
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise);
    await openRestoreConfirm();
    vi.useFakeTimers();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "snapshot.scopeCodex" }),
    );
    await act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(mocks.preview).toHaveBeenCalledTimes(2);

    await act(async () => {
      newRequest.resolve({
        structural: true,
        lossNotices: [{ kind: "map_edges", count: 2 }],
      });
      await newRequest.promise;
    });
    await act(async () => {
      oldRequest.resolve({
        structural: true,
        lossNotices: [{ kind: "scene_labels", count: 9 }],
      });
      await oldRequest.promise;
    });
    expect(
      screen.getByText(/snapshot.loss.kind.map_edges/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/snapshot.loss.kind.scene_labels/)).toBeNull();
  });

  it("cancels pending timers and responses when the confirmation closes or unmounts", async () => {
    const pending = deferred<{
      structural: boolean;
      lossNotices: Array<{ kind: string; count: number }>;
    }>();
    const afterReopen = deferred<{
      structural: boolean;
      lossNotices: Array<{ kind: string; count: number }>;
    }>();
    mocks.preview
      .mockReturnValueOnce(pending.promise)
      .mockReturnValueOnce(afterReopen.promise);
    await openRestoreConfirm();
    vi.useFakeTimers();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "snapshot.scopeCodex" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "snapshot.cancel" }));
    await act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(mocks.preview).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "snapshot.restore" }));
    screen.getByRole("alertdialog", { name: "snapshot.restoreTitle" });
    expect(mocks.preview).toHaveBeenCalledTimes(2);
    cleanup();
    await act(async () => {
      pending.resolve({
        structural: true,
        lossNotices: [{ kind: "phase_anchor", count: 8 }],
      });
      afterReopen.resolve({ structural: true, lossNotices: [] });
      await Promise.all([pending.promise, afterReopen.promise]);
    });
  });

  it("hides zero losses and renders reset-only and unknown kinds", async () => {
    mocks.preview.mockResolvedValueOnce({ structural: true, lossNotices: [] });
    await openRestoreConfirm();
    await act(async () => Promise.resolve());
    expect(screen.queryByText("snapshot.loss.previewHeading")).toBeNull();

    cleanup();
    mocks.preview.mockResolvedValueOnce({
      structural: true,
      lossNotices: [{ kind: "scene_scope_bindings_reset", count: 2 }],
    });
    await openRestoreConfirm();
    expect(
      await screen.findByText("snapshot.loss.resetPreview:2"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/snapshot.loss.kind\./)).toBeNull();

    cleanup();
    mocks.preview.mockResolvedValueOnce({
      structural: true,
      lossNotices: [{ kind: "future_kind", count: 3 }],
    });
    await openRestoreConfirm();
    expect(
      await screen.findByText("snapshot.loss.other:3"),
    ).toBeInTheDocument();
  });

  it("separates reset settings from lost links in preview and result", async () => {
    const scenarios = [
      {
        notices: [{ kind: "map_edges", count: 2 }],
        hasLost: true,
        hasReset: false,
        noOp: true,
        previewHeading: "snapshot.loss.previewHeading",
        resultDescription: "snapshot.loss.resultNoOp",
      },
      {
        notices: [{ kind: "scene_scope_bindings_reset", count: 3 }],
        hasLost: false,
        hasReset: true,
        noOp: true,
        previewHeading: "snapshot.loss.previewResetHeading",
        resultDescription: "snapshot.loss.resultResetOnlyDescription",
      },
      {
        notices: [
          { kind: "map_edges", count: 2 },
          { kind: "scene_scope_bindings_reset", count: 3 },
        ],
        hasLost: true,
        hasReset: true,
        noOp: false,
        previewHeading: "snapshot.loss.previewHeading",
        resultDescription: "snapshot.loss.resultDescription",
      },
    ] as const;

    for (const scenario of scenarios) {
      cleanup();
      mocks.preview.mockResolvedValueOnce({
        structural: true,
        lossNotices: [...scenario.notices],
      });
      mocks.restore.mockResolvedValueOnce(
        restoreResult({ dropped: [...scenario.notices], noOp: scenario.noOp }),
      );
      await openRestoreConfirm();

      await screen.findByRole("heading", { name: scenario.previewHeading });
      expect(screen.getByText("snapshot.loss.previewNote")).toBeInTheDocument();
      const previewList = screen.queryByRole("list");
      if (scenario.hasLost) {
        expect(previewList).toBeInTheDocument();
        expect(
          screen.getByText(/snapshot.loss.kind.map_edges/),
        ).toBeInTheDocument();
      } else {
        expect(previewList).toBeNull();
      }
      const previewReset = screen.queryByText("snapshot.loss.resetPreview:3");
      if (scenario.hasReset) {
        expect(previewReset).toBeInTheDocument();
        expect(previewReset?.tagName).toBe("P");
        expect(previewReset?.closest("ul")).toBeNull();
      } else {
        expect(previewReset).toBeNull();
      }

      fireEvent.click(
        screen.getByRole("button", { name: "snapshot.restoreConfirm" }),
      );
      const resultDialog = await screen.findByRole("alertdialog", {
        name: "snapshot.loss.resultHeading",
      });
      expect(screen.getByText(scenario.resultDescription)).toBeInTheDocument();
      const resultList = screen.queryByRole("list");
      if (scenario.hasLost) {
        expect(resultList).toBeInTheDocument();
        expect(
          screen.getByText(/snapshot.loss.kind.map_edges/),
        ).toBeInTheDocument();
      } else {
        expect(resultList).toBeNull();
      }
      const resultReset = screen.queryByText("snapshot.loss.resetResult:3");
      if (scenario.hasReset) {
        expect(resultReset).toBeInTheDocument();
        expect(resultReset?.tagName).toBe("P");
        expect(resultReset?.closest("ul")).toBeNull();
      } else {
        expect(resultReset).toBeNull();
      }
      expect(resultDialog).toBeInTheDocument();
    }
  });

  it("keeps restore enabled after a preview failure and skips preview for legacy snapshots", async () => {
    mocks.preview.mockRejectedValueOnce(new Error("preview unavailable"));
    await openRestoreConfirm();
    expect(
      await screen.findByText("snapshot.loss.previewError"),
    ).toBeInTheDocument();
    const restoreButton = screen.getByRole("button", {
      name: "snapshot.restoreConfirm",
    });
    expect(restoreButton).toBeEnabled();
    fireEvent.click(restoreButton);
    await waitFor(() => expect(mocks.restore).toHaveBeenCalledOnce());
    await waitFor(() => expect(mocks.reload).toHaveBeenCalledOnce());

    cleanup();
    mocks.preview.mockClear();
    await openRestoreConfirm(false);
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(
      screen.getByText("snapshot.restoreScopeLegacyNote"),
    ).toBeInTheDocument();
  });

  it("keeps the result dialog open until dismissed and reloads once for each close path", async () => {
    for (const closePath of ["ok", "escape", "outside"] as const) {
      cleanup();
      mocks.reload.mockClear();
      mocks.restore.mockResolvedValueOnce(
        restoreResult({
          dropped: [{ kind: "phase_anchor", count: 1 }],
          noOp: true,
        }),
      );
      const { onClose } = await openRestoreConfirm();
      fireEvent.click(
        screen.getByRole("button", { name: "snapshot.restoreConfirm" }),
      );
      const resultDialog = await screen.findByRole("alertdialog", {
        name: "snapshot.loss.resultHeading",
      });
      expect(screen.getByText("snapshot.loss.resultNoOp")).toBeInTheDocument();
      expect(
        screen.queryByRole("alertdialog", { name: "snapshot.restoreTitle" }),
      ).toBeNull();
      expect(screen.queryByTestId("snapshot-list")).toBeNull();
      expect(mocks.reload).not.toHaveBeenCalled();

      if (closePath === "ok") {
        fireEvent.click(
          screen.getByRole("button", { name: "snapshot.loss.resultOk" }),
        );
      } else if (closePath === "escape") {
        fireEvent.keyDown(document.activeElement ?? resultDialog, {
          key: "Escape",
        });
      } else {
        const overlay = document.querySelector('[data-state="open"]');
        expect(overlay).not.toBeNull();
        fireEvent.pointerDown(overlay!, {
          button: 0,
          pointerType: "mouse",
          isPrimary: true,
        });
        fireEvent.pointerUp(overlay!, {
          button: 0,
          pointerType: "mouse",
          isPrimary: true,
        });
        fireEvent.click(overlay!);
      }
      await waitFor(() => {
        expect(onClose, `closePath=${closePath}`).toHaveBeenCalledOnce();
        expect(mocks.reload).toHaveBeenCalledOnce();
      });
    }
  });

  it("shows the snapshot list again after closing and reopening a loss result", async () => {
    const onClose = vi.fn();
    mocks.restore.mockResolvedValueOnce(
      restoreResult({ dropped: [{ kind: "phase_anchor", count: 1 }] }),
    );
    const view = render(
      <WorkspaceViewportProvider profile="phone">
        <ProjectSnapshotModal open onClose={onClose} />
      </WorkspaceViewportProvider>,
    );
    const row = await screen.findByText(snapshot.name);
    fireEvent.click(row.closest("button")!);
    fireEvent.click(screen.getByRole("button", { name: "snapshot.restore" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "snapshot.restoreConfirm" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "snapshot.loss.resultOk" }),
    );

    view.rerender(
      <WorkspaceViewportProvider profile="phone">
        <ProjectSnapshotModal open={false} onClose={onClose} />
      </WorkspaceViewportProvider>,
    );
    view.rerender(
      <WorkspaceViewportProvider profile="phone">
        <ProjectSnapshotModal open onClose={onClose} />
      </WorkspaceViewportProvider>,
    );

    expect(await screen.findByTestId("snapshot-list")).toBeInTheDocument();
  });

  it("reloads exactly once when the parent closes or unmounts while the result is shown", async () => {
    for (const how of ["open-false", "unmount"] as const) {
      cleanup();
      mocks.reload.mockClear();
      mocks.restore.mockResolvedValueOnce(
        restoreResult({ dropped: [{ kind: "phase_anchor", count: 1 }] }),
      );
      const onClose = vi.fn();
      const view = render(
        <WorkspaceViewportProvider profile="phone">
          <ProjectSnapshotModal open onClose={onClose} />
        </WorkspaceViewportProvider>,
      );
      const row = await screen.findByText(snapshot.name);
      fireEvent.click(row.closest("button")!);
      fireEvent.click(screen.getByRole("button", { name: "snapshot.restore" }));
      fireEvent.click(
        await screen.findByRole("button", { name: "snapshot.restoreConfirm" }),
      );
      await screen.findByRole("alertdialog", {
        name: "snapshot.loss.resultHeading",
      });
      expect(mocks.reload).not.toHaveBeenCalled();

      if (how === "open-false") {
        view.rerender(
          <WorkspaceViewportProvider profile="phone">
            <ProjectSnapshotModal open={false} onClose={onClose} />
          </WorkspaceViewportProvider>,
        );
      } else {
        // 本番の親は条件付き render で、閉じるのは unmount。
        view.unmount();
      }
      await waitFor(() => expect(mocks.reload, how).toHaveBeenCalledOnce());
      await act(async () => Promise.resolve());
      expect(mocks.reload, how).toHaveBeenCalledOnce();
    }
  });

  it("does not reload a second time when the parent unmounts after OK", async () => {
    mocks.restore.mockResolvedValueOnce(
      restoreResult({ dropped: [{ kind: "phase_anchor", count: 1 }] }),
    );
    const onClose = vi.fn();
    const view = render(
      <WorkspaceViewportProvider profile="phone">
        <ProjectSnapshotModal open onClose={onClose} />
      </WorkspaceViewportProvider>,
    );
    const row = await screen.findByText(snapshot.name);
    fireEvent.click(row.closest("button")!);
    fireEvent.click(screen.getByRole("button", { name: "snapshot.restore" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "snapshot.restoreConfirm" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "snapshot.loss.resultOk" }),
    );
    await waitFor(() => expect(mocks.reload).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => Promise.resolve());
    expect(mocks.reload).toHaveBeenCalledOnce();
  });

  it("drops the pre-restore undo history once a restore succeeds, so Ctrl+Z cannot replay it while the result is shown", async () => {
    const undo = vi.fn().mockResolvedValue(undefined);
    useGlobalHistoryStore.getState().push({
      kind: "scenes",
      label: "Edit scene",
      undo,
      redo: vi.fn().mockResolvedValue(undefined),
    });
    expect(useGlobalHistoryStore.getState().canUndo).toBe(true);
    mocks.restore.mockResolvedValueOnce(
      restoreResult({ dropped: [{ kind: "phase_anchor", count: 1 }] }),
    );
    await openRestoreConfirm();
    fireEvent.click(
      screen.getByRole("button", { name: "snapshot.restoreConfirm" }),
    );
    await screen.findByRole("alertdialog", {
      name: "snapshot.loss.resultHeading",
    });

    // 結果の画面が出ている間に Ctrl+Z が来ても、復元前の履歴は再生されない。
    await useGlobalHistoryStore.getState().undo();
    expect(undo).not.toHaveBeenCalled();
    expect(useGlobalHistoryStore.getState().canUndo).toBe(false);
  });

  it("keeps the undo history when the restore fails", async () => {
    useGlobalHistoryStore.getState().push({
      kind: "scenes",
      label: "Edit scene",
      undo: vi.fn().mockResolvedValue(undefined),
      redo: vi.fn().mockResolvedValue(undefined),
    });
    mocks.restore.mockRejectedValueOnce(new Error("restore failed"));
    await openRestoreConfirm();
    fireEvent.click(
      screen.getByRole("button", { name: "snapshot.restoreConfirm" }),
    );
    await waitFor(() => expect(mocks.restore).toHaveBeenCalledOnce());
    await act(async () => Promise.resolve());
    expect(useGlobalHistoryStore.getState().canUndo).toBe(true);
  });

  it("does not recount while restore is running", async () => {
    let finishRestore!: (value: ReturnType<typeof restoreResult>) => void;
    mocks.restore.mockReturnValueOnce(
      new Promise((resolve) => {
        finishRestore = resolve;
      }),
    );
    await openRestoreConfirm();
    expect(mocks.preview).toHaveBeenCalledOnce();
    fireEvent.click(
      screen.getByRole("button", { name: "snapshot.restoreConfirm" }),
    );
    await waitFor(() => expect(mocks.restore).toHaveBeenCalledOnce());
    expect(
      screen
        .getAllByRole("checkbox")
        .every((checkbox) => (checkbox as HTMLInputElement).disabled),
    ).toBe(true);
    expect(mocks.preview).toHaveBeenCalledOnce();
    await act(async () => {
      finishRestore(restoreResult());
    });
  });
});

describe("ProjectSnapshotModal approval loss count (SRD/1 RD6)", () => {
  it("says how many proposals lose their approval when Native counts one or more", async () => {
    mocks.preview.mockResolvedValue({
      structural: true,
      lossNotices: [],
      approvalLossCount: 3,
    });
    await openRestoreConfirm();
    expect(
      await screen.findByTestId("snapshot-restore-approval-loss"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "snapshot.restoreConfirm" }),
    ).toBeEnabled();
  });

  it("says nothing for zero, or when an older Native build does not say", async () => {
    mocks.preview.mockResolvedValue({
      structural: true,
      lossNotices: [],
      approvalLossCount: 0,
    });
    await openRestoreConfirm();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "snapshot.restoreConfirm" }),
      ).toBeEnabled(),
    );
    expect(
      screen.queryByTestId("snapshot-restore-approval-loss"),
    ).not.toBeInTheDocument();

    cleanup();
    mocks.preview.mockResolvedValue({
      structural: true,
      lossNotices: [],
      approvalLossCount: null,
    });
    await openRestoreConfirm();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "snapshot.restoreConfirm" }),
      ).toBeEnabled(),
    );
    expect(
      screen.queryByTestId("snapshot-restore-approval-loss"),
    ).not.toBeInTheDocument();
  });

  it("cannot restore while counting", async () => {
    const pending = deferred<{
      structural: boolean;
      lossNotices: never[];
      approvalLossCount: number;
    }>();
    mocks.preview.mockReturnValueOnce(pending.promise);
    await openRestoreConfirm();
    const button = screen.getByRole("button", {
      name: "snapshot.restoreConfirm",
    });
    expect(button).toBeDisabled();
    await act(async () => {
      pending.resolve({
        structural: true,
        lossNotices: [],
        approvalLossCount: 2,
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(button).toBeEnabled());
    expect(
      screen.getByTestId("snapshot-restore-approval-loss"),
    ).toBeInTheDocument();
  });

  it("says it could not check, and still lets the author restore, when the read fails", async () => {
    mocks.preview.mockRejectedValueOnce(new Error("context unavailable"));
    await openRestoreConfirm();
    expect(
      await screen.findByTestId("snapshot-restore-approval-loss-unknown"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("snapshot-restore-approval-loss"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "snapshot.restoreConfirm" }),
    ).toBeEnabled();
  });

  it("recounts for the chosen scopes: no body, no count", async () => {
    mocks.preview.mockImplementation(
      async (_snapshotId: string, scopes: ReadonlySet<string>) => ({
        structural: true,
        lossNotices: [],
        approvalLossCount: scopes.has("body") ? 4 : 0,
      }),
    );
    await openRestoreConfirm();
    expect(
      await screen.findByTestId("snapshot-restore-approval-loss"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "snapshot.scopeBody" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByTestId("snapshot-restore-approval-loss"),
      ).not.toBeInTheDocument(),
    );
  });
});
