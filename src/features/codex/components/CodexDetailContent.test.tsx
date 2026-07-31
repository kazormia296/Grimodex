// @vitest-environment happy-dom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexEntry } from "../api";
import { getCodexEntry } from "../api";
import { inferReadings } from "../codexYomi";
import { useCodexStore } from "../codexStore";
import { useEditorSessionStore } from "@/features/editor/editorSessionStore";
import { useExternalWriteStore } from "@/features/concurrency/externalWriteStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import {
  awaitPendingEditorWrites,
  hasUnresolvedEditorChanges,
} from "@/lib/editorQuiescence";
import { flushAllAutoSaves } from "@/hooks/useAutoSave";
import { CodexDetailContent } from "./CodexDetailContent";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, getCodexEntry: vi.fn() };
});

vi.mock("../codexYomi", () => ({
  inferReadings: vi.fn(() => Promise.resolve(new Map())),
}));

vi.mock("../tagApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tagApi")>();
  return {
    ...actual,
    listEntryTags: vi.fn(() => Promise.resolve([])),
  };
});

vi.mock("@/features/revision/api", () => ({
  createRevision: vi.fn(() => Promise.resolve(null)),
  pruneRevisions: vi.fn(() => Promise.resolve()),
}));

vi.mock("./CodexEntryHeader", () => ({
  CodexEntryHeader: (props: {
    name: string;
    type: string;
    aliases: string[];
    readings: Record<string, string[]>;
    onNameChange: (value: string) => void;
    onNameCommit: () => void;
    onPrimaryReadingCommit: (value: string) => void;
    onTypeChange: (value: "location") => void;
    onAliasesChange: (value: string[]) => void;
  }) => (
    <div>
      <input
        data-testid="draft-name"
        value={props.name}
        onChange={(event) => props.onNameChange(event.currentTarget.value)}
      />
      <output data-testid="draft-type">{props.type}</output>
      <output data-testid="draft-aliases">{props.aliases.join(",")}</output>
      <button data-testid="commit-name" onClick={props.onNameCommit}>
        commit name
      </button>
      <output data-testid="draft-primary-reading">
        {props.readings[props.name]?.[0] ?? ""}
      </output>
      <button
        data-testid="commit-primary-reading"
        onClick={() => props.onPrimaryReadingCommit("せつなあらた")}
      >
        commit reading
      </button>
      <button
        data-testid="clear-primary-reading"
        onClick={() => props.onPrimaryReadingCommit("")}
      >
        clear reading
      </button>
      <button
        data-testid="change-type"
        onClick={() => props.onTypeChange("location")}
      >
        type
      </button>
      <button
        data-testid="change-aliases"
        onClick={() => props.onAliasesChange(["local-alias"])}
      >
        aliases
      </button>
      <button
        data-testid="change-kanji-aliases"
        onClick={() => props.onAliasesChange(["剣聖"])}
      >
        kanji aliases
      </button>
    </div>
  ),
}));

vi.mock("./DetailTabs", () => ({
  DetailTabs: () => null,
}));

vi.mock("./DetailsTab", () => ({
  DetailsTab: (props: {
    summary: string;
    entry: CodexEntry;
    onSummaryChange: (value: string) => void;
  }) => (
    <div>
      <textarea
        data-testid="draft-summary"
        value={props.summary}
        onChange={(event) => props.onSummaryChange(event.currentTarget.value)}
      />
      <output data-testid="draft-content">{props.entry.content}</output>
    </div>
  ),
}));

vi.mock("./CodexEditLockBanner", () => ({
  CodexEditLockBanner: () => null,
}));

vi.mock("./RelationsTab", () => ({ RelationsTab: () => null }));
vi.mock("./TrackingTab", () => ({
  TrackingTab: (props: { onEstimateReadings: () => void }) => (
    <button data-testid="estimate-readings" onClick={props.onEstimateReadings}>
      estimate
    </button>
  ),
}));
vi.mock("./MentionsTab", () => ({ MentionsTab: () => null }));
vi.mock("./ResearchTab", () => ({ ResearchTab: () => null }));
vi.mock("./TimelineTab", () => ({ TimelineTab: () => null }));
vi.mock("./ForeshadowTab", () => ({ ForeshadowTab: () => null }));
vi.mock("./ConsistencyTab", () => ({ ConsistencyTab: () => null }));

vi.mock("@/features/editor/ExternalEditConflictBanner", () => ({
  ExternalEditConflictBanner: (props: {
    onKeepMine?: () => void | Promise<void>;
    onReload?: () => void | Promise<void>;
  }) => (
    <div>
      <button data-testid="keep-mine" onClick={() => void props.onKeepMine?.()}>
        keep
      </button>
      <button data-testid="reload" onClick={() => void props.onReload?.()}>
        reload
      </button>
    </div>
  ),
}));

const INITIAL_ENTRY: CodexEntry = {
  id: "codex-1",
  projectId: "project-1",
  parentId: null,
  type: "character",
  name: "Initial",
  summary: "Initial summary",
  content: "initial-content",
  icon: null,
  aliases: "[]",
  excludedAliases: "[]",
  readings: null,
  tagsCache: null,
  contextMode: "mentioned",
  childrenBudget: "compact",
  sourceChatMessageId: null,
  notes: null,
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const originalUpdate = useCodexStore.getState().update;
const originalUpdateText = useCodexStore.getState().updateText;
const mockGetCodexEntry = vi.mocked(getCodexEntry);
const mockInferReadings = vi.mocked(inferReadings);

describe("CodexDetailContent draft integrity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({ projectLanguage: "ja" });
    useEditorSessionStore.getState().resetForProject();
    useExternalWriteStore.getState().clear();
    useCodexStore.setState({
      entries: [INITIAL_ENTRY],
      selectedEntry: INITIAL_ENTRY,
      update: vi.fn(async () => ({ persisted: true, version: 2 })),
      updateText: vi.fn(async () => ({ persisted: true, version: 2 })),
    });
    mockGetCodexEntry.mockResolvedValue(INITIAL_ENTRY);
  });

  it("does not estimate readings automatically when a name is committed", async () => {
    render(<CodexDetailContent entry={INITIAL_ENTRY} onDelete={vi.fn()} />);

    fireEvent.change(screen.getByTestId("draft-name"), {
      target: { value: "刹那" },
    });
    fireEvent.click(screen.getByTestId("commit-name"));
    await act(async () => {
      await awaitPendingEditorWrites();
      await Promise.resolve();
    });

    expect(mockInferReadings).not.toHaveBeenCalled();
  });

  it("does not estimate readings automatically when an alias is added", async () => {
    render(<CodexDetailContent entry={INITIAL_ENTRY} onDelete={vi.fn()} />);

    fireEvent.click(screen.getByTestId("change-kanji-aliases"));
    await act(async () => {
      await awaitPendingEditorWrites();
      await Promise.resolve();
    });

    expect(mockInferReadings).not.toHaveBeenCalled();
  });

  it("estimates missing readings when the AI estimate button is used", async () => {
    render(
      <CodexDetailContent
        entry={{ ...INITIAL_ENTRY, name: "刹那" }}
        onDelete={vi.fn()}
        initialTab="tracking"
      />,
    );

    fireEvent.click(screen.getByTestId("estimate-readings"));

    await waitFor(() => expect(mockInferReadings).toHaveBeenCalledTimes(1));
    expect(mockInferReadings).toHaveBeenCalledWith([
      expect.objectContaining({
        id: INITIAL_ENTRY.id,
        surfaces: ["刹那"],
      }),
    ]);
  });

  it("saves a hero reading edit while preserving alternate and alias readings", async () => {
    const entry: CodexEntry = {
      ...INITIAL_ENTRY,
      name: "刹那",
      aliases: '["剣聖"]',
      readings:
        '{"刹那":["せつな","せちな"],"剣聖":["けんせい"]}',
    };
    const update = vi.fn(async () => ({ persisted: true, version: 2 }));
    useCodexStore.setState({ entries: [entry], selectedEntry: entry, update });

    render(<CodexDetailContent entry={entry} onDelete={vi.fn()} />);
    fireEvent.click(screen.getByTestId("commit-primary-reading"));

    await act(async () => {
      await awaitPendingEditorWrites();
    });

    expect(screen.getByTestId("draft-primary-reading")).toHaveTextContent(
      "せつなあらた",
    );
    expect(update).toHaveBeenCalledWith(
      entry.id,
      {
        readings:
          '{"刹那":["せつなあらた","せちな"],"剣聖":["けんせい"]}',
      },
      { baseVersion: 1 },
    );
  });

  it("promotes an alternate when the hero representative reading is cleared", async () => {
    const entry: CodexEntry = {
      ...INITIAL_ENTRY,
      name: "刹那",
      readings: '{"刹那":["せつな","せちな"]}',
    };
    const update = vi.fn(async () => ({ persisted: true, version: 2 }));
    useCodexStore.setState({ entries: [entry], selectedEntry: entry, update });

    render(<CodexDetailContent entry={entry} onDelete={vi.fn()} />);
    fireEvent.click(screen.getByTestId("clear-primary-reading"));

    await act(async () => {
      await awaitPendingEditorWrites();
    });

    expect(screen.getByTestId("draft-primary-reading")).toHaveTextContent(
      "せちな",
    );
    expect(update).toHaveBeenCalledWith(
      entry.id,
      { readings: '{"刹那":["せちな"]}' },
      { baseVersion: 1 },
    );
  });

  afterEach(async () => {
    await flushAllAutoSaves().catch(() => {});
    useCodexStore.setState({
      update: originalUpdate,
      updateText: originalUpdateText,
    });
    useEditorSessionStore.getState().resetForProject();
    useExternalWriteStore.getState().clear();
  });

  it("does not replace dirty drafts when the store refreshes the same id", async () => {
    const { rerender } = render(
      <CodexDetailContent entry={INITIAL_ENTRY} onDelete={vi.fn()} />,
    );

    fireEvent.change(screen.getByTestId("draft-name"), {
      target: { value: "Local name" },
    });
    fireEvent.change(screen.getByTestId("draft-summary"), {
      target: { value: "Local summary" },
    });
    fireEvent.click(screen.getByTestId("change-type"));
    fireEvent.click(screen.getByTestId("change-aliases"));

    const refreshed: CodexEntry = {
      ...INITIAL_ENTRY,
      name: "Store name",
      summary: "Store summary",
      type: "item",
      aliases: JSON.stringify(["store-alias"]),
      content: "store-content",
      version: 8,
    };
    rerender(<CodexDetailContent entry={refreshed} onDelete={vi.fn()} />);

    expect(screen.getByTestId("draft-name")).toHaveValue("Local name");
    expect(screen.getByTestId("draft-summary")).toHaveValue("Local summary");
    expect(screen.getByTestId("draft-type")).toHaveTextContent("location");
    expect(screen.getByTestId("draft-aliases")).toHaveTextContent(
      "local-alias",
    );
    expect(screen.getByTestId("draft-content")).toHaveTextContent(
      "initial-content",
    );
    expect(hasUnresolvedEditorChanges()).toBe(true);
  });

  it("initializes a fresh draft when the document identity changes", async () => {
    const { rerender } = render(
      <CodexDetailContent entry={INITIAL_ENTRY} onDelete={vi.fn()} />,
    );
    fireEvent.change(screen.getByTestId("draft-name"), {
      target: { value: "Local name" },
    });

    const nextEntry: CodexEntry = {
      ...INITIAL_ENTRY,
      id: "codex-2",
      name: "Next entry",
      summary: "Next summary",
      content: "next-content",
      aliases: JSON.stringify(["next-alias"]),
      version: 4,
    };
    rerender(<CodexDetailContent entry={nextEntry} onDelete={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByTestId("draft-name")).toHaveValue("Next entry"),
    );
    expect(screen.getByTestId("draft-summary")).toHaveValue("Next summary");
    expect(screen.getByTestId("draft-content")).toHaveTextContent(
      "next-content",
    );
    expect(screen.getByTestId("draft-aliases")).toHaveTextContent("next-alias");
  });

  it("keeps a failed structural patch dirty after a text save and rebases it on Keep Mine", async () => {
    const update = vi
      .fn()
      .mockResolvedValueOnce({ persisted: false, version: 0 })
      .mockResolvedValueOnce({ persisted: true, version: 11 });
    let textVersion = 11;
    const updateText = vi.fn(async () => ({
      persisted: true,
      version: ++textVersion,
    }));
    useCodexStore.setState({ update, updateText });
    mockGetCodexEntry.mockResolvedValue({ ...INITIAL_ENTRY, version: 10 });

    render(<CodexDetailContent entry={INITIAL_ENTRY} onDelete={vi.fn()} />);

    fireEvent.click(screen.getByTestId("change-type"));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByTestId("draft-summary"), {
      target: { value: "Local summary" },
    });
    await act(async () => {
      await flushAllAutoSaves();
    });

    expect(updateText).toHaveBeenCalled();
    expect(hasUnresolvedEditorChanges()).toBe(true);

    fireEvent.click(screen.getByTestId("keep-mine"));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls[1]).toEqual([
      INITIAL_ENTRY.id,
      { type: "location" },
      { baseVersion: 10 },
    ]);
  });

  it("discards a pending structural patch only after persisted reload succeeds", async () => {
    const update = vi.fn(async () => ({ persisted: false, version: 0 }));
    useCodexStore.setState({ update });
    const reloaded: CodexEntry = {
      ...INITIAL_ENTRY,
      type: "lore",
      name: "Persisted winner",
      summary: "Persisted summary",
      content: "persisted-content",
      version: 7,
    };
    mockGetCodexEntry.mockResolvedValue(reloaded);

    render(<CodexDetailContent entry={INITIAL_ENTRY} onDelete={vi.fn()} />);
    fireEvent.click(screen.getByTestId("change-type"));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId("reload"));
    act(() => {
      useExternalWriteStore.getState().bumpReloadNonce({
        kind: "codex",
        id: INITIAL_ENTRY.id,
        phaseId: null,
      });
    });
    await waitFor(() =>
      expect(screen.getByTestId("draft-name")).toHaveValue("Persisted winner"),
    );
    expect(screen.getByTestId("draft-content")).toHaveTextContent(
      "persisted-content",
    );

    fireEvent.click(screen.getByTestId("keep-mine"));
    await waitFor(() => expect(mockGetCodexEntry).toHaveBeenCalledTimes(2));
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("tracks structural writes until workspace quiescence can observe completion", async () => {
    let resolveWrite:
      | ((value: { persisted: true; version: number }) => void)
      | undefined;
    const update = vi.fn(
      () =>
        new Promise<{ persisted: true; version: number }>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    useCodexStore.setState({ update });

    render(<CodexDetailContent entry={INITIAL_ENTRY} onDelete={vi.fn()} />);
    fireEvent.click(screen.getByTestId("change-type"));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));

    let settled = false;
    const quiesce = awaitPendingEditorWrites().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveWrite?.({ persisted: true, version: 2 });
    await quiesce;
    expect(settled).toBe(true);
  });
});
