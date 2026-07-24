// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { PhoneChatSurface } from "./PhoneChatSurface";
import { PhoneCodexNavigator } from "./PhoneCodexNavigator";
import { PhoneMoreSurface } from "./PhoneMoreSurface";
import { PhoneSceneNavigator } from "./PhoneSceneNavigator";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("ja");
});

describe("phone surfaces", () => {
  it("searches scenes and exposes non-drag context actions", () => {
    const onOpen = vi.fn();
    const onAction = vi.fn();
    render(
      <PhoneSceneNavigator
        scenes={[
          { id: "s1", title: "Opening" },
          { id: "s2", title: "Climax", nodeType: "note" },
        ]}
        onOpenScene={onOpen}
        onSceneAction={onAction}
      />,
    );
    expect(screen.queryByRole("heading", { name: "Scenes" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Search scenes and notes"), {
      target: { value: "climax" },
    });
    expect(screen.getByText("Climax")).toBeTruthy();
    expect(screen.queryByText("Opening")).toBeNull();
    fireEvent.click(screen.getByLabelText("Climax actions"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move up" }));
    expect(onAction).toHaveBeenCalledWith("s2", "move-up");
    expect(screen.queryByRole("menuitem", { name: "Duplicate" })).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: "Move to chapter" }),
    ).toBeNull();
  });

  it("navigates Codex detail and phase anchor", () => {
    const onOpenAnchor = vi.fn();
    const onSelectEntry = vi.fn();
    render(
      <PhoneCodexNavigator
        entries={[
          {
            id: "e1",
            name: "葵",
            type: "character",
            phases: [{ id: "p1", label: "手紙", anchorSceneId: "s1" }],
          },
        ]}
        onOpenAnchor={onOpenAnchor}
        onSelectEntry={onSelectEntry}
      />,
    );
    fireEvent.click(screen.getByText("葵"));
    expect(onSelectEntry).toHaveBeenCalledWith("e1");
    fireEvent.click(screen.getByRole("button", { name: "Open anchor scene" }));
    expect(onOpenAnchor).toHaveBeenCalledWith("s1");
  });

  it("shows a Codex result selected outside the phone navigator", () => {
    const onClearSelection = vi.fn();
    render(
      <PhoneCodexNavigator
        entries={[
          {
            id: "e1",
            name: "葵",
            type: "character",
            summary: "主人公",
          },
        ]}
        selectedEntryId="e1"
        onClearSelection={onClearSelection}
      />,
    );

    expect(screen.getByRole("heading", { name: "葵" })).toBeInTheDocument();
    expect(screen.getByText("主人公")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "‹ Back to Codex" }));
    expect(onClearSelection).toHaveBeenCalledOnce();
  });

  it("keeps the composer visible and sends a trimmed message", () => {
    const onSend = vi.fn();
    const { container } = render(
      <PhoneChatSurface messages={[]} onSend={onSend} />,
    );
    expect(container.querySelector("form")?.className).not.toContain(
      "keyboard-inset",
    );
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "  hello  " },
    });
    fireEvent.submit(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("hello");
  });

  it("keeps an unconfigured AI draft while blocking button and form submission", () => {
    const onSend = vi.fn();
    const { rerender } = render(
      <PhoneChatSurface
        messages={[]}
        onSend={onSend}
        sendDisabled
        disabledHint="AI is not configured"
      />,
    );
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "  keep this draft  " } });

    const send = screen.getByRole("button", { name: "Send" });
    expect(input).not.toBeDisabled();
    expect(send).toBeDisabled();
    fireEvent.submit(send.closest("form")!);
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue("  keep this draft  ");

    rerender(
      <PhoneChatSurface messages={[]} onSend={onSend} sendDisabled={false} />,
    );
    expect(input).toHaveValue("  keep this draft  ");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("keep this draft");
  });

  it("exposes project actions that move out of the hidden desktop header", () => {
    const onOpenSearch = vi.fn();
    const onOpenSettings = vi.fn();
    const onOpenImport = vi.fn();
    const onOpenExport = vi.fn();
    const onContinueInGrimodex = vi.fn();

    render(
      <PhoneMoreSurface
        onOpenSearch={onOpenSearch}
        onOpenSettings={onOpenSettings}
        onOpenImport={onOpenImport}
        onOpenExport={onOpenExport}
        onContinueInGrimodex={onContinueInGrimodex}
        workspaceControls={<div>Workspace controls</div>}
      />,
    );

    expect(screen.getByRole("region", { name: "More" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "More" })).toBeNull();
    expect(screen.getByText("Workspace controls")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Search this project" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Import…" }));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Continue writing in Grimodex" }),
    );

    expect(onOpenSearch).toHaveBeenCalledOnce();
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(onOpenImport).toHaveBeenCalledOnce();
    expect(onOpenExport).toHaveBeenCalledOnce();
    expect(onContinueInGrimodex).toHaveBeenCalledOnce();
  });
});
