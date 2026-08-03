// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { CodexEntry } from "../api";
import { buildSceneTimeIndex } from "../context/sceneTimeIndex";
import { DetailsTab } from "./DetailsTab";
import { flushAllAutoSaves } from "@/hooks/useAutoSave";
import { useEditorSessionStore } from "@/features/editor/editorSessionStore";
import { useExternalWriteStore } from "@/features/concurrency/externalWriteStore";
import { announcePersistedBinding } from "@/features/editor/editorSaveRegistry";
import { createEditorInstanceId } from "@/features/editor/document/documentKey";

vi.mock("./CodexContentEditor", () => ({
  CodexContentEditor: ({
    content,
    readOnly,
    onContentChange,
    onExternalSync,
    liveDocumentKey,
  }: {
    content: string;
    readOnly?: boolean;
    onContentChange: (content: string) => void;
    onExternalSync?: (content: string) => void;
    liveDocumentKey?: unknown;
  }) => (
    <>
      <div
        data-testid="mock-codex-content-editor"
        data-read-only={String(Boolean(readOnly))}
        data-live-document-key={JSON.stringify(liveDocumentKey)}
      />
      <output data-testid="mock-content-value">{content}</output>
      <button
        data-testid="mock-content-change"
        onClick={() => onContentChange("phase content changed")}
      >
        change
      </button>
      <button
        data-testid="mock-external-content"
        onClick={() => onExternalSync?.("peer phase content")}
      >
        external
      </button>
    </>
  ),
}));

vi.mock("./DetailsSection", () => ({
  DetailsSection: () => <div data-testid="mock-details-section" />,
}));

vi.mock("./PhaseIndicator", () => ({
  PhaseIndicator: () => <div data-testid="mock-phase-indicator" />,
}));

vi.mock("@/features/editor/ExternalEditConflictBanner", () => ({
  ExternalEditConflictBanner: (props: {
    onKeepMine?: () => void | Promise<void>;
    onReload?: () => void | Promise<void>;
  }) => (
    <div>
      <button
        data-testid="phase-keep-mine"
        onClick={() => void props.onKeepMine?.()}
      >
        keep
      </button>
      <button
        data-testid="phase-reload"
        onClick={() => void props.onReload?.()}
      >
        reload
      </button>
    </div>
  ),
}));

const phase = {
  id: "phase-1",
  entryId: "entry-1",
  label: "Preview",
  anchorNodeId: "scene-1",
  summaryOverride: "Preview summary",
  contentOverride: '{"type":"doc","content":[]}',
  contextModeOverride: null,
  version: 3,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const phaseState = {
  phasesByEntry: { "entry-1": [phase] },
  detailOverrides: {},
  sceneTimeIndex: buildSceneTimeIndex([
    {
      id: "scene-1",
      projectId: "project-1",
      parentId: null,
      nodeType: "scene" as const,
      title: "Scene",
      synopsis: null,
      intent: null,
      sortOrder: "a0",
      status: null,
      storyTimeOrder: null,
      storyTimeLabel: null,
      povCharacterId: null,
      locationId: null,
      charCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ]),
  resolutionMode: "reading" as const,
  updatePhase: vi.fn(),
  loadPhasesForEntry: vi.fn(async () => {}),
};

vi.mock("../phaseStore", () => {
  const usePhaseStore = (selector: (state: typeof phaseState) => unknown) =>
    selector(phaseState);
  return {
    usePhaseStore: Object.assign(usePhaseStore, {
      getState: () => phaseState,
    }),
  };
});

const codexState: {
  previewPhaseByEntry: Record<string, string | null>;
  setPreviewPhase: ReturnType<typeof vi.fn>;
} = {
  previewPhaseByEntry: { "entry-1": phase.id },
  setPreviewPhase: vi.fn(),
};

vi.mock("../codexStore", () => ({
  useCodexStore: (selector: (state: typeof codexState) => unknown) =>
    selector(codexState),
}));

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: (selector: (state: { activeSceneId: string }) => unknown) =>
    selector({ activeSceneId: "scene-1" }),
}));

const entry: CodexEntry = {
  id: "entry-1",
  projectId: "project-1",
  parentId: null,
  type: "character",
  name: "Alice",
  summary: "Base summary",
  content: '{"type":"doc","content":[]}',
  icon: null,
  aliases: null,
  excludedAliases: null,
  readings: null,
  tagsCache: null,
  contextMode: "mentioned",
  childrenBudget: "compact",
  sourceChatMessageId: null,
  notes: null,
  version: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("DetailsTab Phase preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    codexState.previewPhaseByEntry = { "entry-1": phase.id };
    phaseState.phasesByEntry = { "entry-1": [{ ...phase }] };
    phaseState.updatePhase.mockReset();
    phaseState.loadPhasesForEntry.mockReset();
    phaseState.loadPhasesForEntry.mockResolvedValue(undefined);
    useEditorSessionStore.getState().resetForProject();
    useExternalWriteStore.getState().clear();
  });

  afterEach(async () => {
    useExternalWriteStore.getState().clear();
    await flushAllAutoSaves().catch(() => {});
    useEditorSessionStore.getState().resetForProject();
  });

  it("forces the content editor read-only while previewing an exact Phase", () => {
    render(
      <DetailsTab
        entry={entry}
        summary={entry.summary ?? ""}
        onSummaryChange={vi.fn()}
        onContentChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId("mock-codex-content-editor")).toHaveAttribute(
      "data-read-only",
      "true",
    );
  });

  it("serializes Phase summary/content with the loaded and returned versions", async () => {
    codexState.previewPhaseByEntry = {};
    phaseState.updatePhase
      .mockResolvedValueOnce({ ...phase, version: 4 })
      .mockResolvedValueOnce({ ...phase, version: 5 });
    render(
      <DetailsTab
        entry={entry}
        summary={entry.summary ?? ""}
        onSummaryChange={vi.fn()}
        onContentChange={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByDisplayValue("Preview summary"), {
      target: { value: "phase summary changed" },
    });
    await act(async () => {
      await flushAllAutoSaves();
    });
    fireEvent.click(screen.getByTestId("mock-content-change"));
    await act(async () => {
      await flushAllAutoSaves();
    });

    expect(phaseState.updatePhase).toHaveBeenNthCalledWith(
      1,
      "phase-1",
      { summaryOverride: "phase summary changed" },
      { baseVersion: 3 },
    );
    expect(phaseState.updatePhase).toHaveBeenNthCalledWith(
      2,
      "phase-1",
      { contentOverride: "phase content changed" },
      { baseVersion: 4 },
    );
  });

  it("uses the exact Phase DocumentKey for live sync and dirty tracking", async () => {
    codexState.previewPhaseByEntry = {};
    phaseState.updatePhase.mockResolvedValue({ ...phase, version: 4 });
    render(
      <DetailsTab
        entry={entry}
        summary={entry.summary ?? ""}
        onSummaryChange={vi.fn()}
        onContentChange={vi.fn()}
      />,
    );

    const phaseDocumentKey = {
      kind: "codex" as const,
      id: entry.id,
      phaseId: phase.id,
    };
    expect(
      screen
        .getByTestId("mock-codex-content-editor")
        .getAttribute("data-live-document-key"),
    ).toBe(JSON.stringify(phaseDocumentKey));

    fireEvent.click(screen.getByTestId("mock-content-change"));
    expect(
      useEditorSessionStore.getState().isDocumentDirty(phaseDocumentKey),
    ).toBe(true);
    expect(
      useEditorSessionStore.getState().isDocumentDirty({
        kind: "codex",
        id: entry.id,
        phaseId: null,
      }),
    ).toBe(false);

    await act(async () => {
      await flushAllAutoSaves();
    });
    expect(
      useEditorSessionStore.getState().isDocumentDirty(phaseDocumentKey),
    ).toBe(false);
  });

  it("drops an older Phase debounce snapshot when the exact peer body takes ownership", async () => {
    codexState.previewPhaseByEntry = {};
    phaseState.updatePhase.mockResolvedValue({ ...phase, version: 5 });
    render(
      <DetailsTab
        entry={entry}
        summary={entry.summary ?? ""}
        onSummaryChange={vi.fn()}
        onContentChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("mock-content-change"));
    fireEvent.click(screen.getByTestId("mock-external-content"));
    act(() => {
      announcePersistedBinding(
        { kind: "codex", id: entry.id, phaseId: phase.id },
        createEditorInstanceId("peer"),
        {
          kind: "codex",
          id: entry.id,
          phaseId: phase.id,
          loadedVersion: 4,
        },
      );
    });
    fireEvent.change(screen.getByDisplayValue("Preview summary"), {
      target: { value: "summary after peer body" },
    });

    await act(async () => {
      await flushAllAutoSaves();
    });

    expect(phaseState.updatePhase).toHaveBeenCalledTimes(1);
    expect(phaseState.updatePhase).toHaveBeenCalledWith(
      phase.id,
      { summaryOverride: "summary after peer body" },
      { baseVersion: 4 },
    );
  });

  it("pauses the exact Phase autosaves while its external conflict is unresolved", async () => {
    codexState.previewPhaseByEntry = {};
    phaseState.updatePhase.mockResolvedValue({ ...phase, version: 4 });
    render(
      <DetailsTab
        entry={entry}
        summary={entry.summary ?? ""}
        onSummaryChange={vi.fn()}
        onContentChange={vi.fn()}
      />,
    );

    const phaseDocumentKey = {
      kind: "codex" as const,
      id: entry.id,
      phaseId: phase.id,
    };
    await act(async () => {
      useExternalWriteStore.getState().pushConflict({
        documentKey: phaseDocumentKey,
        sceneId: entry.id,
        domain: "codex",
        opType: "phase.update",
        entityId: phase.id,
      });
      await Promise.resolve();
    });
    fireEvent.change(screen.getByDisplayValue("Preview summary"), {
      target: { value: "paused draft" },
    });

    await expect(flushAllAutoSaves()).rejects.toThrow(
      "unresolved external edit conflict",
    );
    expect(phaseState.updatePhase).not.toHaveBeenCalled();
    expect(
      useEditorSessionStore.getState().isDocumentDirty(phaseDocumentKey),
    ).toBe(true);

    await act(async () => {
      useExternalWriteStore.getState().shiftConflict(phaseDocumentKey);
      await Promise.resolve();
    });
    await act(async () => {
      await flushAllAutoSaves();
    });
    expect(phaseState.updatePhase).toHaveBeenCalledOnce();
  });

  it("active Phase が変わっても旧 Phase conflict の queued draft を再開しない", async () => {
    codexState.previewPhaseByEntry = {};
    const { rerender } = render(
      <DetailsTab
        entry={entry}
        summary={entry.summary ?? ""}
        onSummaryChange={vi.fn()}
        onContentChange={vi.fn()}
      />,
    );
    const phaseDocumentKey = {
      kind: "codex" as const,
      id: entry.id,
      phaseId: phase.id,
    };
    fireEvent.change(screen.getByDisplayValue("Preview summary"), {
      target: { value: "phase-1 draft" },
    });
    act(() => {
      useExternalWriteStore.getState().pushConflict({
        documentKey: phaseDocumentKey,
        sceneId: entry.id,
        domain: "codex",
        opType: "phase.update",
        entityId: phase.id,
      });
    });

    phaseState.phasesByEntry = {
      "entry-1": [
        {
          ...phase,
          id: "phase-2",
          label: "Phase 2",
          summaryOverride: "phase-2 summary",
          version: 10,
        },
      ],
    };
    rerender(
      <DetailsTab
        entry={entry}
        summary={entry.summary ?? ""}
        onSummaryChange={vi.fn()}
        onContentChange={vi.fn()}
      />,
    );

    await expect(flushAllAutoSaves()).rejects.toThrow(
      "unresolved external edit conflict",
    );
    expect(phaseState.updatePhase).not.toHaveBeenCalled();
    expect(screen.getByTestId("phase-keep-mine")).toBeInTheDocument();
  });

  it("rebases Keep Mine on the refreshed Phase version before resuming autosave", async () => {
    codexState.previewPhaseByEntry = {};
    phaseState.updatePhase.mockResolvedValue({ ...phase, version: 9 });
    phaseState.loadPhasesForEntry.mockImplementation(async () => {
      phaseState.phasesByEntry = {
        "entry-1": [{ ...phase, version: 8 }],
      };
    });
    render(
      <DetailsTab
        entry={entry}
        summary={entry.summary ?? ""}
        onSummaryChange={vi.fn()}
        onContentChange={vi.fn()}
      />,
    );

    const phaseDocumentKey = {
      kind: "codex" as const,
      id: entry.id,
      phaseId: phase.id,
    };
    fireEvent.change(screen.getByDisplayValue("Preview summary"), {
      target: { value: "local winner" },
    });
    act(() => {
      useExternalWriteStore.getState().pushConflict({
        documentKey: phaseDocumentKey,
        sceneId: entry.id,
        domain: "codex",
        opType: "phase.update",
        entityId: phase.id,
      });
    });
    fireEvent.click(screen.getByTestId("phase-keep-mine"));
    await waitFor(() =>
      expect(phaseState.loadPhasesForEntry).toHaveBeenCalledWith(entry.id),
    );

    act(() => {
      useExternalWriteStore.getState().shiftConflict(phaseDocumentKey);
    });
    await act(async () => {
      await flushAllAutoSaves();
    });

    expect(phaseState.updatePhase).toHaveBeenCalledWith(
      phase.id,
      { summaryOverride: "local winner" },
      { baseVersion: 8 },
    );
    expect(
      useEditorSessionStore.getState().isDocumentDirty(phaseDocumentKey),
    ).toBe(false);
  });

  it("reload discards the Phase draft only after applying refreshed content and version", async () => {
    codexState.previewPhaseByEntry = {};
    phaseState.loadPhasesForEntry.mockImplementation(async () => {
      phaseState.phasesByEntry = {
        "entry-1": [
          {
            ...phase,
            summaryOverride: "persisted winner",
            contentOverride: "persisted phase content",
            version: 8,
          },
        ],
      };
    });
    render(
      <DetailsTab
        entry={entry}
        summary={entry.summary ?? ""}
        onSummaryChange={vi.fn()}
        onContentChange={vi.fn()}
      />,
    );

    const phaseDocumentKey = {
      kind: "codex" as const,
      id: entry.id,
      phaseId: phase.id,
    };
    fireEvent.change(screen.getByDisplayValue("Preview summary"), {
      target: { value: "discard me" },
    });
    fireEvent.click(screen.getByTestId("mock-content-change"));
    act(() => {
      useExternalWriteStore.getState().pushConflict({
        documentKey: phaseDocumentKey,
        sceneId: entry.id,
        domain: "codex",
        opType: "phase.update",
        entityId: phase.id,
      });
    });

    fireEvent.click(screen.getByTestId("phase-reload"));
    act(() => {
      useExternalWriteStore.getState().bumpReloadNonce(phaseDocumentKey);
    });

    await waitFor(() =>
      expect(screen.getByDisplayValue("persisted winner")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("mock-content-value")).toHaveTextContent(
      "persisted phase content",
    );
    expect(useExternalWriteStore.getState().conflicts).toHaveLength(0);
    expect(
      useEditorSessionStore.getState().isDocumentDirty(phaseDocumentKey),
    ).toBe(false);

    await act(async () => {
      await flushAllAutoSaves();
    });
    expect(phaseState.updatePhase).not.toHaveBeenCalled();
  });

  it("reload accepts an externally deleted Phase and releases its dirty conflict", async () => {
    codexState.previewPhaseByEntry = {};
    phaseState.loadPhasesForEntry.mockImplementation(async () => {
      phaseState.phasesByEntry = { "entry-1": [] };
    });
    render(
      <DetailsTab
        entry={entry}
        summary={entry.summary ?? ""}
        onSummaryChange={vi.fn()}
        onContentChange={vi.fn()}
      />,
    );
    const phaseDocumentKey = {
      kind: "codex" as const,
      id: entry.id,
      phaseId: phase.id,
    };
    fireEvent.change(screen.getByDisplayValue("Preview summary"), {
      target: { value: "discard deleted phase draft" },
    });
    act(() => {
      useExternalWriteStore.getState().pushConflict({
        documentKey: phaseDocumentKey,
        sceneId: entry.id,
        domain: "codex",
        opType: "phase.delete",
        entityId: phase.id,
      });
    });

    fireEvent.click(screen.getByTestId("phase-reload"));
    act(() => {
      useExternalWriteStore.getState().bumpReloadNonce(phaseDocumentKey);
    });

    await waitFor(() =>
      expect(useExternalWriteStore.getState().conflicts).toHaveLength(0),
    );
    expect(
      useEditorSessionStore.getState().isDocumentDirty(phaseDocumentKey),
    ).toBe(false);
    await act(async () => {
      await flushAllAutoSaves();
    });
    expect(phaseState.updatePhase).not.toHaveBeenCalled();
  });
});
