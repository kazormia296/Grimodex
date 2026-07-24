// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceViewportProvider } from "@/runtime/workspaceViewportContext";
import { ProjectSnapshotModal } from "./ProjectSnapshotModal";

const mocks = vi.hoisted(() => ({
  listProjectSnapshots: vi.fn(),
  restoreProjectSnapshot: vi.fn(),
  deleteProjectSnapshot: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/features/editor/inlineAi/pendingGuard", () => ({
  guardInlineAiPending: () => false,
}));

vi.mock("@/components/ui/animated-overlay", () => ({
  AnimatedOverlay: ({
    open,
    children,
    className,
  }: {
    open: boolean;
    children: React.ReactNode;
    className?: string;
  }) => (open ? <div className={className}>{children}</div> : null),
}));

vi.mock("./projectSnapshotApi", () => ({
  createProjectSnapshot: vi.fn(),
  listProjectSnapshots: mocks.listProjectSnapshots,
  restoreProjectSnapshot: mocks.restoreProjectSnapshot,
  deleteProjectSnapshot: mocks.deleteProjectSnapshot,
}));

describe("ProjectSnapshotModal phone confirms", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listProjectSnapshots.mockResolvedValue([
      {
        id: "snapshot-1",
        name: "Mobile Snapshot",
        description: null,
        entryCount: 3,
        createdAt: "2026-07-24T12:00:00.000Z",
        isStructural: true,
      },
    ]);
  });

  it("uses safe, scrollable alert dialogs for restore and delete confirms", async () => {
    render(
      <WorkspaceViewportProvider profile="phone">
        <ProjectSnapshotModal open onClose={vi.fn()} />
      </WorkspaceViewportProvider>,
    );

    const snapshotName = await screen.findByText("Mobile Snapshot");
    fireEvent.click(snapshotName.closest("button")!);
    const restoreAction = screen.getByRole("button", {
      name: "snapshot.restore",
    });
    restoreAction.focus();
    fireEvent.click(restoreAction);

    const restoreDialog = await screen.findByRole("alertdialog", {
      name: "snapshot.restoreTitle",
    });
    expect(restoreDialog).toHaveAccessibleDescription(
      "snapshot.restoreDesc snapshot.restoreDescSub",
    );
    expect(restoreDialog.className).toContain(
      "h-[var(--visual-viewport-height,100dvh)]",
    );
    expect(restoreDialog.className).toContain("overflow-y-auto");
    expect(restoreDialog.className).toContain(
      "pb-[max(1rem,env(safe-area-inset-bottom))]",
    );
    expect(screen.getByRole("button", { name: "snapshot.cancel" })).toHaveClass(
      "min-h-11",
    );
    expect(
      screen.getByRole("button", { name: "snapshot.restoreConfirm" }),
    ).toHaveClass("min-h-11");
    await waitFor(() => {
      expect(restoreDialog).toContainElement(
        document.activeElement as HTMLElement,
      );
    });

    fireEvent.keyDown(document.activeElement ?? restoreDialog, {
      key: "Escape",
    });
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(
        screen.getByRole("button", { name: "snapshot.restore" }),
      ).toHaveFocus();
    });

    const deleteAction = screen.getByRole("button", {
      name: "snapshot.delete",
    });
    deleteAction.focus();
    fireEvent.click(deleteAction);
    const deleteDialog = await screen.findByRole("alertdialog", {
      name: "snapshot.deleteTitle",
    });
    expect(deleteDialog).toHaveAccessibleDescription("snapshot.deleteDesc");
    expect(deleteDialog.className).toContain(
      "pt-[max(1rem,env(safe-area-inset-top))]",
    );
    expect(
      screen.getByRole("button", { name: "snapshot.deleteConfirm" }),
    ).toHaveClass("min-h-11");

    fireEvent.keyDown(document.activeElement ?? deleteDialog, {
      key: "Escape",
    });
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(
        screen.getByRole("button", { name: "snapshot.delete" }),
      ).toHaveFocus();
    });
  });
});
