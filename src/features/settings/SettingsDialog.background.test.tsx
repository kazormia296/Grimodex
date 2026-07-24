// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBackgroundStudioStore } from "@/features/editor/background/backgroundStudioStore";
import { SettingsDialog } from "./SettingsDialog";

const mocks = vi.hoisted(() => ({
  loadAll: vi.fn(),
  flushPending: vi.fn().mockResolvedValue(undefined),
  initFromSettings: vi.fn(),
  requestLayerAutoFollowSync: vi.fn(),
}));

vi.mock("./settingsStore", () => ({
  useSettingsStore: () => ({
    loadAll: mocks.loadAll,
    flushPending: mocks.flushPending,
  }),
}));
vi.mock("@/features/editor/cursorSettingsStore", () => ({
  useCursorSettingsStore: {
    getState: () => ({
      initFromSettings: mocks.initFromSettings,
      requestLayerAutoFollowSync: mocks.requestLayerAutoFollowSync,
    }),
  },
}));
vi.mock("@/features/attribution/attributionStore", () => ({
  useAttributionStore: {
    getState: () => ({ initFromSettings: mocks.initFromSettings }),
  },
}));
vi.mock("@/features/post-effect/annotationStore", () => ({
  useAnnotationStore: {
    getState: () => ({ initFromSettings: mocks.initFromSettings }),
  },
}));
vi.mock("@/features/editor/codexHighlightStore", () => ({
  useCodexHighlightStore: {
    getState: () => ({ initFromSettings: mocks.initFromSettings }),
  },
}));
vi.mock("@/components/ui/animated-overlay", () => ({
  AnimatedOverlay: ({
    open,
    children,
    className,
    testId,
  }: {
    open: boolean;
    children: React.ReactNode;
    className?: string;
    testId?: string;
  }) =>
    open ? (
      <div className={className} data-testid={testId}>
        {children}
      </div>
    ) : null,
}));
vi.mock("./CategoryNav", () => ({
  CategoryNav: ({ phoneWorkspace }: { phoneWorkspace?: boolean }) => (
    <nav
      data-testid="settings-category-nav"
      data-phone-workspace={phoneWorkspace ? "true" : "false"}
    />
  ),
}));
vi.mock("./categories/DisplayCategory", () => ({
  DisplayCategory: ({
    onOpenBackgroundStudio,
  }: {
    onOpenBackgroundStudio?: () => void;
  }) => (
    <button type="button" onClick={onOpenBackgroundStudio}>
      Open background studio
    </button>
  ),
}));

describe("SettingsDialog Background Studio handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.flushPending.mockResolvedValue(undefined);
    useBackgroundStudioStore.setState({ open: false });
  });

  it("flushes and closes Settings before opening Background Studio", async () => {
    const onClose = vi.fn();
    render(<SettingsDialog open onClose={onClose} initialCategory="display" />);

    fireEvent.click(
      screen.getByRole("button", { name: "Open background studio" }),
    );

    await waitFor(() => {
      expect(mocks.flushPending).toHaveBeenCalledOnce();
      expect(onClose).toHaveBeenCalledOnce();
      expect(useBackgroundStudioStore.getState().open).toBe(true);
    });
  });

  it("uses a full-viewport, single-column shell for phone settings", () => {
    render(
      <SettingsDialog
        open
        onClose={vi.fn()}
        initialCategory="display"
        phoneWorkspace
      />,
    );

    const dialog = screen.getByTestId("settings-dialog");
    expect(dialog.className).toContain(
      "h-[var(--visual-viewport-height,100dvh)]",
    );
    expect(dialog.className).toContain("w-screen");
    expect(dialog.className).toContain("min-w-0");
    expect(dialog.className).not.toContain("min-w-[480px]");
    expect(dialog.className).toContain("pt-[env(safe-area-inset-top)]");
    expect(dialog.className).toContain("pr-[env(safe-area-inset-right)]");
    expect(dialog.className).toContain("pb-[env(safe-area-inset-bottom)]");
    expect(dialog.className).toContain("pl-[env(safe-area-inset-left)]");
    expect(screen.getByTestId("settings-category-nav")).toHaveAttribute(
      "data-phone-workspace",
      "true",
    );
    expect(screen.getByTestId("settings-content").className).toContain(
      "overflow-x-hidden",
    );
  });

  it("keeps the desktop settings bounds without phone safe-area padding", () => {
    render(<SettingsDialog open onClose={vi.fn()} initialCategory="display" />);

    const dialog = screen.getByTestId("settings-dialog");
    expect(dialog.className).toContain("h-[600px]");
    expect(dialog.className).toContain("min-w-[480px]");
    expect(dialog.className).not.toContain("safe-area-inset");
  });
});
