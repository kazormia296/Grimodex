// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

  it("opens the edit form directly and omits phase navigation", () => {
    const onSelectEntry = vi.fn();
    const onSaveEntry = vi.fn().mockResolvedValue(true);
    render(
      <PhoneCodexNavigator
        entries={
          [
            {
              id: "e1",
              name: "葵",
              type: "character",
              summary: "主人公",
              phases: [{ id: "p1", label: "手紙", anchorSceneId: "s1" }],
            },
          ] as unknown as React.ComponentProps<
            typeof PhoneCodexNavigator
          >["entries"]
        }
        onSelectEntry={onSelectEntry}
        onSaveEntry={onSaveEntry}
      />,
    );

    fireEvent.click(screen.getByText("葵"));

    expect(onSelectEntry).toHaveBeenCalledWith("e1");
    expect(screen.getByRole("combobox", { name: "Type" })).toHaveValue(
      "character",
    );
    expect(screen.getByRole("textbox", { name: "Summary" })).toHaveValue(
      "主人公",
    );
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Phases" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Open anchor scene" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "‹ Back to Codex" }));
    expect(screen.getByText("葵")).toBeInTheDocument();
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
    expect(screen.getByRole("textbox", { name: "Summary" })).toHaveValue(
      "主人公",
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "‹ Back to Codex" }));
    expect(onClearSelection).toHaveBeenCalledOnce();
  });

  it("edits the minimum safe Codex fields and saves them explicitly", async () => {
    const onSaveEntry = vi.fn().mockResolvedValue(true);
    render(
      <PhoneCodexNavigator
        {...({
          entries: [
            {
              id: "e1",
              name: "葵",
              type: "character",
              summary: "主人公",
            },
          ],
          entryTypes: [
            { value: "character", label: "Character" },
            { value: "location", label: "Location" },
          ],
          selectedEntryId: "e1",
          onSaveEntry,
        } as React.ComponentProps<typeof PhoneCodexNavigator>)}
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Type" }), {
      target: { value: "location" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Summary" }), {
      target: { value: "  New summary  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onSaveEntry).toHaveBeenCalledWith("e1", {
        type: "location",
        summary: "New summary",
      });
    });
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Type" })).toHaveValue(
      "location",
    );
    expect(screen.getByRole("textbox", { name: "Summary" })).toHaveValue(
      "New summary",
    );
  });

  it("keeps the Codex form and draft when saving returns false", async () => {
    const onSaveEntry = vi.fn().mockResolvedValue(false);
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
        entryTypes={[
          { value: "character", label: "Character" },
          { value: "location", label: "Location" },
        ]}
        selectedEntryId="e1"
        onSaveEntry={onSaveEntry}
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Type" }), {
      target: { value: "location" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Summary" }), {
      target: { value: "保存待ちの要約" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save",
    );
    expect(screen.getByRole("combobox", { name: "Type" })).toHaveValue(
      "location",
    );
    expect(screen.getByRole("textbox", { name: "Summary" })).toHaveValue(
      "保存待ちの要約",
    );
  });

  it("keeps the Codex form and draft when saving rejects", async () => {
    const onSaveEntry = vi.fn().mockRejectedValue(new Error("save failed"));
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
        onSaveEntry={onSaveEntry}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Summary" }), {
      target: { value: "再試行する要約" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save",
    );
    expect(screen.getByRole("textbox", { name: "Summary" })).toHaveValue(
      "再試行する要約",
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("does not discard a dirty Codex draft when the selected entry refreshes", () => {
    const onSaveEntry = vi.fn().mockResolvedValue(true);
    const entryTypes = [
      { value: "character", label: "Character" },
      { value: "location", label: "Location" },
    ];
    const { rerender } = render(
      <PhoneCodexNavigator
        entries={[
          {
            id: "e1",
            name: "葵",
            type: "character",
            summary: "主人公",
          },
        ]}
        entryTypes={entryTypes}
        selectedEntryId="e1"
        onSaveEntry={onSaveEntry}
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Type" }), {
      target: { value: "location" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Summary" }), {
      target: { value: "編集中の要約" },
    });

    rerender(
      <PhoneCodexNavigator
        entries={[
          {
            id: "e1",
            name: "葵",
            type: "character",
            summary: "外部更新された要約",
          },
        ]}
        entryTypes={entryTypes}
        selectedEntryId="e1"
        onSaveEntry={onSaveEntry}
      />,
    );

    expect(screen.getByRole("combobox", { name: "Type" })).toHaveValue(
      "location",
    );
    expect(screen.getByRole("textbox", { name: "Summary" })).toHaveValue(
      "編集中の要約",
    );
  });

  it("ignores an old save completion after switching to and editing another entry", async () => {
    let resolveFirstSave: ((saved: boolean) => void) | undefined;
    const onSaveEntry = vi.fn((entryId: string) =>
      entryId === "e1"
        ? new Promise<boolean>((resolve) => {
            resolveFirstSave = resolve;
          })
        : Promise.resolve(true),
    );
    const entries = [
      {
        id: "e1",
        name: "葵",
        type: "character",
        summary: "主人公",
      },
      {
        id: "e2",
        name: "港",
        type: "location",
        summary: "第二幕の舞台",
      },
    ];
    const entryTypes = [
      { value: "character", label: "Character" },
      { value: "location", label: "Location" },
    ];
    const { rerender } = render(
      <PhoneCodexNavigator
        entries={entries}
        entryTypes={entryTypes}
        selectedEntryId="e1"
        onSaveEntry={onSaveEntry}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Summary" }), {
      target: { value: "葵の新要約" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    rerender(
      <PhoneCodexNavigator
        entries={entries}
        entryTypes={entryTypes}
        selectedEntryId="e2"
        onSaveEntry={onSaveEntry}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Summary" }), {
      target: { value: "港の編集中要約" },
    });

    await act(async () => {
      resolveFirstSave?.(true);
      await Promise.resolve();
    });

    expect(screen.getByRole("textbox", { name: "Summary" })).toHaveValue(
      "港の編集中要約",
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("prevents read-only Codex edits and preserves an existing draft", () => {
    const onSaveEntry = vi.fn().mockResolvedValue(true);
    const entry = {
      id: "e1",
      name: "葵",
      type: "character",
      summary: "主人公",
    };
    const { rerender } = render(
      <PhoneCodexNavigator
        entries={[entry]}
        selectedEntryId="e1"
        onSaveEntry={onSaveEntry}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Summary" }), {
      target: { value: "ロック中も残す要約" },
    });

    rerender(
      <PhoneCodexNavigator
        entries={[entry]}
        selectedEntryId="e1"
        onSaveEntry={onSaveEntry}
        readOnly
      />,
    );

    const summary = screen.getByRole("textbox", { name: "Summary" });
    expect(summary).toHaveValue("ロック中も残す要約");
    expect(summary).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.submit(
      screen.getByRole("button", { name: "Save" }).closest("form")!,
    );
    expect(onSaveEntry).not.toHaveBeenCalled();
    expect(summary).toHaveValue("ロック中も残す要約");
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

  it("lists past chats, switches sessions, and starts a new chat", () => {
    const onSelectSession = vi.fn();
    const onCreateSession = vi.fn();
    render(
      <PhoneChatSurface
        {...({
          messages: [],
          sessions: [
            { id: "chat-1", title: "Opening ideas" },
            { id: "chat-2", title: "Climax review" },
          ],
          activeSessionId: "chat-1",
          onSelectSession,
          onCreateSession,
          onSend: vi.fn(),
        } as React.ComponentProps<typeof PhoneChatSurface>)}
      />,
    );

    const history = screen.getByRole("combobox", { name: "Past chats" });
    expect(screen.getByRole("option", { name: "Opening ideas" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Climax review" })).toBeTruthy();
    fireEvent.change(history, { target: { value: "chat-2" } });
    expect(onSelectSession).toHaveBeenCalledWith("chat-2");
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(onCreateSession).toHaveBeenCalledOnce();
  });

  it("locks chat-session mutations while AI is generating", () => {
    render(
      <PhoneChatSurface
        {...({
          messages: [],
          sessions: [{ id: "chat-1", title: "Opening ideas" }],
          activeSessionId: "chat-1",
          onSelectSession: vi.fn(),
          onCreateSession: vi.fn(),
          onSend: vi.fn(),
          disabled: true,
        } as React.ComponentProps<typeof PhoneChatSurface>)}
      />,
    );

    expect(screen.getByRole("combobox", { name: "Past chats" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "New chat" })).toBeDisabled();
  });

  it("keeps the draft while message history is loading and locks every chat action", () => {
    const onSelectSession = vi.fn();
    const onCreateSession = vi.fn();
    const onSend = vi.fn();
    const props = {
      messages: [],
      sessions: [{ id: "chat-1", title: "Opening ideas" }],
      activeSessionId: "chat-1",
      onSelectSession,
      onCreateSession,
      onSend,
    } satisfies React.ComponentProps<typeof PhoneChatSurface>;
    const { rerender } = render(<PhoneChatSurface {...props} />);
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "keep this draft" } });

    rerender(<PhoneChatSurface {...props} isLoadingMessages />);

    expect(screen.getByRole("combobox", { name: "Past chats" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "New chat" })).toBeDisabled();
    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.submit(
      screen.getByRole("button", { name: "Send" }).closest("form")!,
    );
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue("keep this draft");

    rerender(<PhoneChatSurface {...props} isLoadingMessages={false} />);
    expect(input).toBeEnabled();
    expect(input).toHaveValue("keep this draft");

    rerender(<PhoneChatSurface {...props} isLoadingSessions />);
    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(input).toHaveValue("keep this draft");

    rerender(<PhoneChatSurface {...props} isLoadingSessions={false} />);
    expect(input).toBeEnabled();
    expect(input).toHaveValue("keep this draft");
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
