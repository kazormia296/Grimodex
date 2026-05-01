// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const mockAddPin = vi.fn().mockResolvedValue(undefined);
const mockRemovePin = vi.fn().mockResolvedValue(undefined);
const mockLoadPinsForScene = vi.fn().mockResolvedValue(undefined);

vi.mock("@/features/codex/sceneCodexPinsStore", () => ({
  useSceneCodexPinsStore: vi.fn((sel: (s: unknown) => unknown) =>
    sel({
      pinsByScene: {},
      loadPinsForScene: mockLoadPinsForScene,
      addPin: mockAddPin,
      removePin: mockRemovePin,
    }),
  ),
}));

vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: vi.fn((sel: (s: unknown) => unknown) => sel({ entries: [] })),
}));

vi.mock("@/features/codex/components/PinEntryDialog", () => ({
  PinEntryDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="pin-dialog" /> : null,
}));

vi.mock("@/features/layout/layoutStore", () => ({
  useLayoutStore: { getState: vi.fn(() => ({ showPanel: vi.fn() })) },
}));

import { useSceneCodexPinsStore } from "@/features/codex/sceneCodexPinsStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { GridCardChips } from "../GridCardChips";

const mockPinsStore = useSceneCodexPinsStore as unknown as {
  mockImplementation: (
    fn: (selector: (s: unknown) => unknown) => unknown,
  ) => void;
};
const mockCodexStore = useCodexStore as unknown as {
  mockImplementation: (
    fn: (selector: (s: unknown) => unknown) => unknown,
  ) => void;
};

function makePinsState(
  pinsByScene: Record<string, string[]>,
  entries: { id: string; name: string; type: string }[] = [],
) {
  mockPinsStore.mockImplementation((sel) =>
    sel({
      pinsByScene,
      loadPinsForScene: mockLoadPinsForScene,
      addPin: mockAddPin,
      removePin: mockRemovePin,
    }),
  );
  mockCodexStore.mockImplementation((sel) => sel({ entries }));
}

beforeEach(() => {
  vi.clearAllMocks();
  makePinsState({});
});

describe("GridCardChips", () => {
  it("editable=false でピンなし → null をレンダリング", () => {
    const { container } = render(
      <GridCardChips sceneId="s1" editable={false} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("editable=true でピンなし → '+' ボタンを表示", () => {
    render(<GridCardChips sceneId="s1" editable />);
    expect(screen.getByTitle("Codex を紐付け")).toBeDefined();
  });

  it("ピンあり → エントリ名をチップ表示", () => {
    makePinsState({ s1: ["e1"] }, [
      { id: "e1", name: "アリス", type: "character" },
    ]);
    render(<GridCardChips sceneId="s1" editable />);
    expect(screen.getByText("アリス")).toBeDefined();
  });

  it("compact=true → MAX_CHIPS=3 を超えたピンは overflow 表示", () => {
    const ids = ["e1", "e2", "e3", "e4", "e5"];
    const entries = ids.map((id) => ({
      id,
      name: `Entry-${id}`,
      type: "lore",
    }));
    makePinsState({ s1: ids }, entries);
    render(<GridCardChips sceneId="s1" editable compact />);
    expect(screen.getByText("+2")).toBeDefined();
  });

  it("compact=false → MAX_CHIPS=5 を超えたピンは overflow 表示", () => {
    const ids = ["e1", "e2", "e3", "e4", "e5", "e6", "e7"];
    const entries = ids.map((id) => ({
      id,
      name: `Entry-${id}`,
      type: "lore",
    }));
    makePinsState({ s1: ids }, entries);
    render(<GridCardChips sceneId="s1" editable compact={false} />);
    expect(screen.getByText("+2")).toBeDefined();
  });

  it("'+' クリックで PinEntryDialog が開く", () => {
    render(<GridCardChips sceneId="s1" editable />);
    expect(screen.queryByTestId("pin-dialog")).toBeNull();
    fireEvent.click(screen.getByTitle("Codex を紐付け"));
    expect(screen.getByTestId("pin-dialog")).toBeDefined();
  });
});
