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
  }: {
    open: boolean;
    children: React.ReactNode;
  }) => (open ? <div>{children}</div> : null),
}));
vi.mock("./CategoryNav", () => ({ CategoryNav: () => null }));
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
});
