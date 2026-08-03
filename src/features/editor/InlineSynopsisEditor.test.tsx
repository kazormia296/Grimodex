// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { flushQuiescenceProviderStage } from "@/lib/quiescenceProviders";
import { _resetPendingSynopsisSavesForTests } from "./pendingSynopsisSaves";

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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  updateSynopsis.mockReset();
  updateSynopsis.mockResolvedValue(undefined);
  _resetPendingSynopsisSavesForTests();
});

afterEach(() => {
  _resetPendingSynopsisSavesForTests();
});

describe("InlineSynopsisEditor — click-to-edit mode", () => {
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

  it("flushes a virtualized unmount and strict quiescence waits for it", async () => {
    const write = deferred<void>();
    updateSynopsis.mockReturnValueOnce(write.promise);
    const user = userEvent.setup();
    const { unmount } = render(
      <InlineSynopsisEditor nodeId="s1" synopsis="Original" />,
    );
    await user.click(screen.getByText("Original"));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Draft before scroll" },
    });

    unmount();
    expect(updateSynopsis).toHaveBeenCalledTimes(1);
    expect(updateSynopsis).toHaveBeenCalledWith("s1", "Draft before scroll");

    let settled = false;
    const flush = flushQuiescenceProviderStage("scoped-mutations").then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    write.resolve();
    await flush;
    expect(settled).toBe(true);
  });

  it("does not double-save when blur is immediately followed by unmount", async () => {
    const write = deferred<void>();
    updateSynopsis.mockReturnValueOnce(write.promise);
    const user = userEvent.setup();
    const { unmount } = render(
      <InlineSynopsisEditor nodeId="s1" synopsis="Original" />,
    );
    await user.click(screen.getByText("Original"));
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "Latest value" } });

    fireEvent.blur(textarea);
    expect(updateSynopsis).toHaveBeenCalledTimes(1);
    unmount();
    expect(updateSynopsis).toHaveBeenCalledTimes(1);

    write.resolve();
    await flushQuiescenceProviderStage("scoped-mutations");
    expect(updateSynopsis).toHaveBeenCalledTimes(1);
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

  it("flushes its pending edit on unmount", async () => {
    const { unmount } = render(
      <InlineSynopsisEditor nodeId="s1" synopsis="Original" alwaysEditing />,
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Updated before unmount" },
    });
    expect(updateSynopsis).not.toHaveBeenCalled();

    unmount();

    await waitFor(() =>
      expect(updateSynopsis).toHaveBeenCalledWith(
        "s1",
        "Updated before unmount",
      ),
    );
    expect(updateSynopsis).toHaveBeenCalledTimes(1);
  });

  it("keeps a newer local edit when an older save updates the prop", async () => {
    const firstWrite = deferred<void>();
    updateSynopsis
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValueOnce(undefined);
    const { rerender } = render(
      <InlineSynopsisEditor nodeId="s1" synopsis="Original" alwaysEditing />,
    );
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "First value" } });
    fireEvent.blur(textarea);
    expect(updateSynopsis).toHaveBeenCalledWith("s1", "First value");

    fireEvent.change(textarea, { target: { value: "Latest value" } });
    rerender(
      <InlineSynopsisEditor nodeId="s1" synopsis="First value" alwaysEditing />,
    );
    expect(screen.getByRole("textbox")).toHaveValue("Latest value");

    const flush = flushQuiescenceProviderStage("scoped-mutations");
    firstWrite.resolve();
    await flush;

    expect(updateSynopsis.mock.calls).toEqual([
      ["s1", "First value"],
      ["s1", "Latest value"],
    ]);
  });
});
