// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  act,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  InlineSynopsisEditor,
  type InlineSynopsisEditorHandle,
} from "./InlineSynopsisEditor";
import { createRef } from "react";

const updateSynopsis = vi.fn().mockResolvedValue(undefined);

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ updateSynopsis }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => {
      const map: Record<string, string> = {
        "scenes.noSynopsis": "No synopsis",
      };
      return map[key] ?? fallback ?? key;
    },
  }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

describe("InlineSynopsisEditor — click-to-edit mode", () => {
  beforeEach(() => vi.clearAllMocks());

  it("displays synopsis text when provided", () => {
    render(<InlineSynopsisEditor nodeId="s1" synopsis="A hero departs." />);
    expect(screen.getByText("A hero departs.")).toBeInTheDocument();
  });

  it("displays placeholder when synopsis is null", () => {
    render(<InlineSynopsisEditor nodeId="s1" synopsis={null} />);
    expect(screen.getByText("No synopsis")).toBeInTheDocument();
  });

  it("enters edit mode on click", async () => {
    const user = userEvent.setup();
    render(<InlineSynopsisEditor nodeId="s1" synopsis="A hero departs." />);
    await user.click(screen.getByText("A hero departs."));
    expect(screen.getByRole("textbox")).toHaveValue("A hero departs.");
  });

  it("saves and exits on blur", async () => {
    const user = userEvent.setup();
    render(<InlineSynopsisEditor nodeId="s1" synopsis="A hero departs." />);
    await user.click(screen.getByText("A hero departs."));
    const ta = screen.getByRole("textbox");
    await user.clear(ta);
    await user.type(ta, "The hero returns.");
    await user.tab();
    await waitFor(() =>
      expect(updateSynopsis).toHaveBeenCalledWith("s1", "The hero returns."),
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("cancels and reverts on Escape", async () => {
    const user = userEvent.setup();
    render(<InlineSynopsisEditor nodeId="s1" synopsis="A hero departs." />);
    await user.click(screen.getByText("A hero departs."));
    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "Changed text");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText("A hero departs.")).toBeInTheDocument();
    expect(updateSynopsis).not.toHaveBeenCalled();
  });

  it("saves and exits on Enter (non-IME)", async () => {
    const user = userEvent.setup();
    render(<InlineSynopsisEditor nodeId="s1" synopsis="A hero departs." />);
    await user.click(screen.getByText("A hero departs."));
    const ta = screen.getByRole("textbox");
    await user.clear(ta);
    await user.type(ta, "The hero returns.");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(updateSynopsis).toHaveBeenCalledWith("s1", "The hero returns."),
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("does not call updateSynopsis when text is unchanged", async () => {
    const user = userEvent.setup();
    render(<InlineSynopsisEditor nodeId="s1" synopsis="A hero departs." />);
    await user.click(screen.getByText("A hero departs."));
    await user.tab();
    expect(updateSynopsis).not.toHaveBeenCalled();
  });

  it("suppresses Enter save during IME composition", async () => {
    const user = userEvent.setup();
    render(<InlineSynopsisEditor nodeId="s1" synopsis="Hello" />);
    await user.click(screen.getByText("Hello"));
    const ta = screen.getByRole("textbox");
    // Use fireEvent to trigger React's synthetic compositionstart handler
    fireEvent.compositionStart(ta);
    await user.keyboard("{Enter}");
    // Still in editing mode, no save
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(updateSynopsis).not.toHaveBeenCalled();
  });

  it("notifies onEditingChange when editing state changes", async () => {
    const user = userEvent.setup();
    const onEditingChange = vi.fn();
    render(
      <InlineSynopsisEditor
        nodeId="s1"
        synopsis="Text"
        onEditingChange={onEditingChange}
      />,
    );
    await user.click(screen.getByText("Text"));
    expect(onEditingChange).toHaveBeenCalledWith(true);
    await user.tab();
    await waitFor(() => expect(onEditingChange).toHaveBeenCalledWith(false));
  });

  it("exposes startEditing via ref", async () => {
    const ref = createRef<InlineSynopsisEditorHandle>();
    render(<InlineSynopsisEditor ref={ref} nodeId="s1" synopsis="Original" />);
    act(() => ref.current?.startEditing());
    expect(screen.getByRole("textbox")).toHaveValue("Original");
  });
});

describe("InlineSynopsisEditor — doubleClick trigger", () => {
  it("only enters edit mode on double click", async () => {
    const user = userEvent.setup();
    render(
      <InlineSynopsisEditor
        nodeId="s1"
        synopsis="Text"
        triggerOn="doubleClick"
      />,
    );
    await user.click(screen.getByText("Text"));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await user.dblClick(screen.getByText("Text"));
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });
});

describe("InlineSynopsisEditor — alwaysEditing mode", () => {
  it("renders textarea immediately without click", () => {
    render(<InlineSynopsisEditor nodeId="s1" synopsis="Text" alwaysEditing />);
    expect(screen.getByRole("textbox")).toHaveValue("Text");
  });

  it("Enter key adds newline instead of saving", async () => {
    const user = userEvent.setup();
    render(<InlineSynopsisEditor nodeId="s1" synopsis="Line1" alwaysEditing />);
    const ta = screen.getByRole("textbox");
    await user.click(ta);
    await user.keyboard("{Enter}");
    // textarea still visible
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    // updateSynopsis not called (debounce not fired yet)
    expect(updateSynopsis).not.toHaveBeenCalled();
  });

  it("syncs when synopsis prop changes externally", async () => {
    const { rerender } = render(
      <InlineSynopsisEditor nodeId="s1" synopsis="Initial" alwaysEditing />,
    );
    expect(screen.getByRole("textbox")).toHaveValue("Initial");
    rerender(
      <InlineSynopsisEditor
        nodeId="s1"
        synopsis="AI generated"
        alwaysEditing
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("textbox")).toHaveValue("AI generated"),
    );
  });

  it("flushes save on blur without exiting", async () => {
    const user = userEvent.setup();
    render(
      <InlineSynopsisEditor nodeId="s1" synopsis="Original" alwaysEditing />,
    );
    const ta = screen.getByRole("textbox");
    await user.clear(ta);
    await user.type(ta, "Updated");
    await user.tab();
    await waitFor(() =>
      expect(updateSynopsis).toHaveBeenCalledWith("s1", "Updated"),
    );
    // textarea still rendered (alwaysEditing)
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });
});
