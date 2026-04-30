// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DndContext } from "@dnd-kit/core";
import { useUnplacedBeatsStore } from "@/features/editor/beat/unplacedBeatsStore";
import type { UnplacedBeat } from "@/features/editor/beat/unplacedBeatsStore";
import { UnplacedBeatItem } from "./UnplacedBeatItem";

vi.mock("@tiptap/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tiptap/react")>();
  return {
    ...actual,
    useEditor: vi.fn(() => null),
    EditorContent: vi.fn(() => <div data-testid="editor-content" />),
  };
});

const BEAT: UnplacedBeat = {
  id: "u1",
  beatType: "free",
  pov: null,
  collapsed: false,
  content: [],
};

function Wrapper({ beat }: { beat: UnplacedBeat }) {
  return (
    <DndContext>
      <UnplacedBeatItem
        sceneId="s1"
        beat={beat}
        mainEditor={null}
        setMentionPopup={vi.fn()}
      />
    </DndContext>
  );
}

beforeEach(() => {
  useUnplacedBeatsStore.setState({ sceneBeats: { s1: [BEAT] } });
});

describe("UnplacedBeatItem — beat type selector", () => {
  it("type chip shows the current beat type", async () => {
    render(<Wrapper beat={BEAT} />);
    const chip = screen.getByTestId("unplaced-beat-type-chip-u1");
    expect(chip.getAttribute("data-beat-type")).toBe("free");
  });

  it("clicking type chip opens dropdown with all beat types", async () => {
    render(<Wrapper beat={BEAT} />);
    const chip = screen.getByTestId("unplaced-beat-type-chip-u1");
    await act(async () => {
      await userEvent.click(chip);
    });
    // all 6 types should appear
    for (const bt of [
      "free",
      "summary",
      "guided",
      "dialogue",
      "setting",
      "micro",
    ]) {
      expect(
        screen.getByTestId(`unplaced-beat-type-option-${BEAT.id}-${bt}`),
      ).toBeTruthy();
    }
  });

  it("selecting a type updates the store", async () => {
    render(<Wrapper beat={BEAT} />);
    const chip = screen.getByTestId("unplaced-beat-type-chip-u1");
    await act(async () => {
      await userEvent.click(chip);
    });
    const option = screen.getByTestId(
      `unplaced-beat-type-option-${BEAT.id}-dialogue`,
    );
    await act(async () => {
      await userEvent.click(option);
    });

    const beats = useUnplacedBeatsStore.getState().sceneBeats["s1"];
    expect(beats?.[0]?.beatType).toBe("dialogue");
  });
});
