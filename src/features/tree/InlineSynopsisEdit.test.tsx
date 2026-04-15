// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InlineSynopsisEdit } from "./InlineSynopsisEdit";

const updateSynopsis = vi.fn().mockResolvedValue(undefined);

vi.mock("./treeStore", () => ({
  useTreeStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ updateSynopsis }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        "scenes.noSynopsis": "No synopsis",
      };
      return map[key] ?? key;
    },
  }),
}));

describe("InlineSynopsisEdit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("displays synopsis text when provided", () => {
    render(
      <InlineSynopsisEdit
        nodeId="scene-1"
        synopsis="A hero departs."
        depth={1}
      />,
    );
    expect(screen.getByText("A hero departs.")).toBeInTheDocument();
  });

  it("displays placeholder when synopsis is null", () => {
    render(<InlineSynopsisEdit nodeId="scene-1" synopsis={null} depth={1} />);
    expect(screen.getByText("No synopsis")).toBeInTheDocument();
  });

  it("enters edit mode on click", async () => {
    const user = userEvent.setup();
    render(
      <InlineSynopsisEdit
        nodeId="scene-1"
        synopsis="A hero departs."
        depth={1}
      />,
    );

    await user.click(screen.getByText("A hero departs."));
    const textarea = screen.getByRole("textbox");
    expect(textarea).toBeInTheDocument();
    expect(textarea).toHaveValue("A hero departs.");
  });

  it("enters edit mode when clicking placeholder", async () => {
    const user = userEvent.setup();
    render(<InlineSynopsisEdit nodeId="scene-1" synopsis={null} depth={1} />);

    await user.click(screen.getByText("No synopsis"));
    const textarea = screen.getByRole("textbox");
    expect(textarea).toBeInTheDocument();
    expect(textarea).toHaveValue("");
  });

  it("saves and exits edit mode on blur", async () => {
    const user = userEvent.setup();
    render(
      <InlineSynopsisEdit
        nodeId="scene-1"
        synopsis="A hero departs."
        depth={1}
      />,
    );

    await user.click(screen.getByText("A hero departs."));
    const textarea = screen.getByRole("textbox");
    await user.clear(textarea);
    await user.type(textarea, "The hero returns.");
    await user.tab(); // blur

    await waitFor(() => {
      expect(updateSynopsis).toHaveBeenCalledWith(
        "scene-1",
        "The hero returns.",
      );
    });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("cancels and reverts on Escape", async () => {
    const user = userEvent.setup();
    render(
      <InlineSynopsisEdit
        nodeId="scene-1"
        synopsis="A hero departs."
        depth={1}
      />,
    );

    await user.click(screen.getByText("A hero departs."));
    const textarea = screen.getByRole("textbox");
    await user.clear(textarea);
    await user.type(textarea, "Changed text");
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText("A hero departs.")).toBeInTheDocument();
    expect(updateSynopsis).not.toHaveBeenCalled();
  });

  it("saves and exits on Enter (without Shift)", async () => {
    const user = userEvent.setup();
    render(
      <InlineSynopsisEdit
        nodeId="scene-1"
        synopsis="A hero departs."
        depth={1}
      />,
    );

    await user.click(screen.getByText("A hero departs."));
    const textarea = screen.getByRole("textbox");
    await user.clear(textarea);
    await user.type(textarea, "The hero returns.");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(updateSynopsis).toHaveBeenCalledWith(
        "scene-1",
        "The hero returns.",
      );
    });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("does not call updateSynopsis when text is unchanged", async () => {
    const user = userEvent.setup();
    render(
      <InlineSynopsisEdit
        nodeId="scene-1"
        synopsis="A hero departs."
        depth={1}
      />,
    );

    await user.click(screen.getByText("A hero departs."));
    await user.tab(); // blur without changing

    expect(updateSynopsis).not.toHaveBeenCalled();
  });

  it("stops event propagation to prevent tree interactions", async () => {
    const user = userEvent.setup();
    const outerClick = vi.fn();
    const outerMouseDown = vi.fn();

    render(
      // biome-ignore lint/a11y/useKeyWithClickEvents: test wrapper
      <div onClick={outerClick} onMouseDown={outerMouseDown}>
        <InlineSynopsisEdit
          nodeId="scene-1"
          synopsis="A hero departs."
          depth={1}
        />
      </div>,
    );

    await user.click(screen.getByText("A hero departs."));
    expect(outerClick).not.toHaveBeenCalled();
    expect(outerMouseDown).not.toHaveBeenCalled();
  });
});
