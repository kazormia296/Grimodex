import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { WorkspaceViewportProvider } from "@/runtime/workspaceViewportContext";
import { emptySkipReport } from "./projectSnapshotScopes";
import { KNOWN_RESTORE_LOSS_KINDS } from "./restoreLossNotices";
import { changeUiLanguage } from "@/lib/i18n";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  preview: vi.fn(),
  restore: vi.fn(),
  remove: vi.fn(),
  reload: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
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

import { ProjectSnapshotModal } from "./ProjectSnapshotModal";

const snapshot = {
  id: "loss-layout-snapshot",
  name: "Layout Snapshot",
  description: null,
  entryCount: 3,
  createdAt: "2026-11-24T00:00:00.000Z",
  isStructural: true,
};
const allLosses = KNOWN_RESTORE_LOSS_KINDS.map((kind) => ({ kind, count: 3 }));

function restoreResult() {
  return {
    restoredCount: 3,
    safetySnapshotId: "safety-snapshot",
    format: "structural" as const,
    skipped: emptySkipReport(),
    dropped: allLosses,
    noOp: false,
  };
}

async function scrollToBottom(element: HTMLElement): Promise<void> {
  element.scrollTop = element.scrollHeight;
  await act(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      }),
  );
}

function expectInsidePhone(
  element: HTMLElement,
  height: number,
  width: number,
): void {
  const rect = element.getBoundingClientRect();
  expect(rect.left).toBeGreaterThanOrEqual(-1);
  expect(rect.right).toBeLessThanOrEqual(width + 1);
  expect(rect.bottom).toBeLessThanOrEqual(height + 1);
}

beforeEach(async () => {
  await page.viewport(320, 640);
  await changeUiLanguage("en");
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([snapshot]);
  mocks.preview.mockResolvedValue({
    structural: true,
    lossNotices: allLosses,
  });
  mocks.restore.mockResolvedValue(restoreResult());
  mocks.reload.mockResolvedValue(undefined);
});

afterEach(async () => {
  cleanup();
  await changeUiLanguage("ja");
  await page.viewport(1280, 800);
});

describe("ProjectSnapshotModal loss notice phone layout", () => {
  it("keeps confirm and result dialogs inside the viewport and scrollable", async () => {
    render(
      <WorkspaceViewportProvider profile="phone">
        <ProjectSnapshotModal open onClose={vi.fn()} />
      </WorkspaceViewportProvider>,
    );
    const row = await screen.findByText(snapshot.name);
    fireEvent.click(row.closest("button")!);
    fireEvent.click(
      screen.getByRole("button", { name: "Restore to this point" }),
    );

    const confirmDialog = await screen.findByRole("alertdialog", {
      name: "Restore Project",
    });
    expect(confirmDialog.scrollHeight).toBeGreaterThan(
      confirmDialog.clientHeight,
    );
    expectInsidePhone(confirmDialog, 640, 320);
    const confirmButton = screen.getByRole("button", {
      name: "Restore",
    });
    expect(confirmButton).toHaveClass("min-h-11", "w-full");
    // 全部の kind が並ぶ長い内容では、ボタンは最初は画面の外にあってよい。
    // 縦に動かして届くこと、横にはみ出さないことを固定する。
    await scrollToBottom(confirmDialog);
    expect(confirmDialog.scrollTop).toBeGreaterThan(0);
    expect(confirmDialog.scrollWidth).toBeLessThanOrEqual(
      confirmDialog.clientWidth + 1,
    );
    expectInsidePhone(confirmButton, 640, 320);

    fireEvent.click(confirmButton);
    const resultDialog = await screen.findByRole("alertdialog", {
      name: "Restore result",
    });
    expect(resultDialog.scrollHeight).toBeGreaterThan(
      resultDialog.clientHeight,
    );
    expectInsidePhone(resultDialog, 640, 320);
    const okButton = screen.getByRole("button", {
      name: "OK",
    });
    expect(okButton).toHaveClass("min-h-11", "w-full");
    await scrollToBottom(resultDialog);
    expect(resultDialog.scrollTop).toBeGreaterThan(0);
    expect(resultDialog.scrollWidth).toBeLessThanOrEqual(
      resultDialog.clientWidth + 1,
    );
    expectInsidePhone(okButton, 640, 320);
  });

  it("keeps the confirm and result actions visible without scrolling on a short wide viewport", async () => {
    await page.viewport(900, 600);
    render(
      <WorkspaceViewportProvider profile="wide">
        <ProjectSnapshotModal open onClose={vi.fn()} />
      </WorkspaceViewportProvider>,
    );
    const row = await screen.findByText(snapshot.name);
    fireEvent.click(row.closest("button")!);
    fireEvent.click(
      screen.getByRole("button", { name: "Restore to this point" }),
    );

    const confirmDialog = await screen.findByRole("alertdialog", {
      name: "Restore Project",
    });
    await screen.findByText(/Event participants/);
    // 件数が並んでダイアログは縦にスクロールするが、操作の行は動かさなくても見える。
    expect(confirmDialog.scrollHeight).toBeGreaterThan(
      confirmDialog.clientHeight,
    );
    expect(confirmDialog.scrollTop).toBe(0);
    const confirmButton = screen.getByRole("button", { name: "Restore" });
    expectInsidePhone(confirmButton, 600, 900);
    expect(confirmButton.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);

    fireEvent.click(confirmButton);
    const resultDialog = await screen.findByRole("alertdialog", {
      name: "Restore result",
    });
    expect(resultDialog.scrollHeight).toBeGreaterThan(
      resultDialog.clientHeight,
    );
    expect(resultDialog.scrollTop).toBe(0);
    const okButton = screen.getByRole("button", { name: "OK" });
    expectInsidePhone(okButton, 600, 900);
    expect(okButton.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
  });
});
