// @vitest-environment happy-dom
import { render } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { describe, expect, it, vi } from "vitest";
import { FindReplaceBar } from "./FindReplaceBar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("lucide-react", () => ({ X: () => null }));

function createEditor(): Editor {
  return {
    isDestroyed: false,
    commands: {
      clearFind: vi.fn(() => true),
      setFindQuery: vi.fn(() => true),
      setFindOptions: vi.fn(() => true),
      findNext: vi.fn(() => true),
      findPrev: vi.fn(() => true),
      replaceOne: vi.fn(() => true),
      replaceAll: vi.fn(() => true),
    },
    storage: {
      findReplace: {
        query: "",
        caseSensitive: false,
        useRegex: false,
        currentIndex: 0,
        matches: [],
        regexError: false,
      },
    },
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Editor;
}

describe("FindReplaceBar editor lifecycle", () => {
  it("clears decorations from the previous editor when the active editor changes", () => {
    const firstEditor = createEditor();
    const secondEditor = createEditor();
    const { rerender } = render(
      <FindReplaceBar
        editor={firstEditor}
        open
        showReplace={false}
        onClose={vi.fn()}
      />,
    );

    expect(firstEditor.commands.clearFind).not.toHaveBeenCalled();

    rerender(
      <FindReplaceBar
        editor={secondEditor}
        open
        showReplace={false}
        onClose={vi.fn()}
      />,
    );

    expect(firstEditor.commands.clearFind).toHaveBeenCalledTimes(1);
    expect(secondEditor.commands.clearFind).not.toHaveBeenCalled();
  });
});
