// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/features/editor/beat/sceneBeatPovStore", () => ({
  useSceneBeatPovStore: vi.fn((sel: (s: unknown) => unknown) =>
    sel({ povIdsByScene: {} }),
  ),
}));

vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: vi.fn((sel: (s: unknown) => unknown) => sel({ entries: [] })),
}));

vi.mock("@/features/layout/layoutStore", () => ({
  useLayoutStore: { getState: vi.fn(() => ({ showPanel: vi.fn() })) },
}));

import { useSceneBeatPovStore } from "@/features/editor/beat/sceneBeatPovStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { GridCardPovChips } from "../GridCardPovChips";

const mockBeatPovStore = useSceneBeatPovStore as unknown as {
  mockImplementation: (
    fn: (selector: (s: unknown) => unknown) => unknown,
  ) => void;
};
const mockCodexStore = useCodexStore as unknown as {
  mockImplementation: (
    fn: (selector: (s: unknown) => unknown) => unknown,
  ) => void;
};

function makeState(
  povIdsByScene: Record<string, string[]>,
  entries: { id: string; name: string }[] = [],
) {
  mockBeatPovStore.mockImplementation((sel) => sel({ povIdsByScene }));
  mockCodexStore.mockImplementation((sel) => sel({ entries }));
}

beforeEach(() => {
  vi.clearAllMocks();
  makeState({});
});

describe("GridCardPovChips", () => {
  it("POV なし → null をレンダリング", () => {
    const { container } = render(
      <GridCardPovChips sceneId="s1" scenePovCharacterId={null} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("scene POV あり → チップ表示", () => {
    makeState({}, [{ id: "c1", name: "アリス" }]);
    render(<GridCardPovChips sceneId="s1" scenePovCharacterId="c1" />);
    expect(screen.getByText("アリス")).toBeDefined();
  });

  it("beat POV のみ → チップ表示", () => {
    makeState({ s1: ["c2"] }, [{ id: "c2", name: "ボブ" }]);
    render(<GridCardPovChips sceneId="s1" scenePovCharacterId={null} />);
    expect(screen.getByText("ボブ")).toBeDefined();
  });
});
