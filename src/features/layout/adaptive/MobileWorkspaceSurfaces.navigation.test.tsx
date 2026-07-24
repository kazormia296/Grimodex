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
import { useChatStore } from "@/features/chat/chatStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { useEditorSessionStore } from "@/features/editor/editorSessionStore";
import { useInlineAiStore } from "@/features/editor/inlineAi/inlineAiStore";
import { useTabStore } from "@/features/editor/tabStore";
import { useSemanticNavStore } from "@/features/semantic-search/semanticNavStore";
import { useProjectStore } from "@/features/project/projectStore";
import { useTreeStore } from "@/features/tree/treeStore";
import i18n from "@/lib/i18n";
import { ConnectedMobileWorkspaceSurface } from "./MobileWorkspaceSurfaces";
import { useCompactNavigationStore } from "./compactNavigationStore";

const selectResult = vi.hoisted(() => vi.fn());
const toastInfo = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const getCodexEntry = vi.hoisted(() => vi.fn());
const originalCreateNode = useTreeStore.getState().createNode;
const originalDeleteNode = useTreeStore.getState().deleteNode;
const originalMoveNode = useTreeStore.getState().moveNode;
const originalCodexUpdate = useCodexStore.getState().update;
const originalCodexUpdateText = useCodexStore.getState().updateText;
const searchResult = vi.hoisted(
  (): {
    id: string;
    kind:
      | "lexical-scene"
      | "lexical-codex"
      | "lexical-snippet"
      | "semantic-chunk";
  } => ({
    id: "lexical-scene:scene-1",
    kind: "lexical-scene",
  }),
);

vi.mock("sonner", () => ({
  toast: {
    info: toastInfo,
    error: toastError,
    success: vi.fn(),
  },
}));

vi.mock("@/features/codex/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/codex/api")>();
  return { ...actual, getCodexEntry };
});

vi.mock("@/features/commandCenter/CommandCenterResultsPanel", () => ({
  CommandCenterResultsPanel: ({
    onItemSelect,
  }: {
    onItemSelect?: (item: {
      id: string;
      kind:
        | "lexical-scene"
        | "lexical-codex"
        | "lexical-snippet"
        | "semantic-chunk";
      title: string;
      subtitle: string;
      onSelect: () => void;
    }) => boolean | void;
  }) => {
    const item = {
      ...searchResult,
      title: "Search result",
      subtitle: "Result excerpt",
      onSelect: selectResult,
    };
    return (
      <button
        type="button"
        role="option"
        aria-selected="false"
        onClick={() => {
          if (onItemSelect?.(item) !== true) {
            item.onSelect();
          }
        }}
      >
        Search result
      </button>
    );
  },
}));

beforeEach(async () => {
  await i18n.changeLanguage("ja");
  getCodexEntry.mockReset();
  getCodexEntry.mockResolvedValue(undefined);
  useCompactNavigationStore.getState().reset();
  useCompactNavigationStore.getState().openSurface("search");
  useTreeStore.setState({
    createNode: originalCreateNode,
    deleteNode: originalDeleteNode,
    moveNode: originalMoveNode,
    activeSceneId: "scene-0",
    nodes: [
      { id: "scene-0", nodeType: "scene", title: "Zero" },
      { id: "scene-1", nodeType: "scene", title: "One" },
    ],
  } as never);
  useTabStore.setState({
    tabs: [{ nodeId: "scene-0", contentType: "scene", isPreview: false }],
    activeTabId: "scene-0",
    secondaryTabs: [],
    secondaryActiveTabId: null,
    secondaryGroupOpen: false,
    activeGroupIndex: 0,
  } as never);
  useEditorSessionStore.getState().resetForProject();
  useInlineAiStore.getState().reset();
  useSemanticNavStore.setState({ pendingJump: null });
  useCodexStore.setState({
    entries: [],
    pendingEntryId: null,
    selectedEntry: null,
    filterType: null,
    update: originalCodexUpdate,
    updateText: originalCodexUpdateText,
    ensureEntriesLoaded: vi.fn().mockResolvedValue(undefined),
  } as never);
  usePhaseStore.setState({ phasesByEntry: {} } as never);
  useProjectStore.setState({ currentProjectId: "project-mobile" } as never);
  useChatStore.setState({
    activeSceneId: "scene-0",
    chatScope: "scene",
    isStreaming: false,
    messages: [],
  } as never);
});

afterEach(() => {
  cleanup();
  selectResult.mockReset();
  toastInfo.mockReset();
  toastError.mockReset();
  getCodexEntry.mockReset();
  searchResult.id = "lexical-scene:scene-1";
  searchResult.kind = "lexical-scene";
  useInlineAiStore.getState().reset();
  useCompactNavigationStore.getState().reset();
});

describe("ConnectedMobileWorkspaceSurface", () => {
  it("keeps the phone projection unchanged when scene creation fails", async () => {
    const createNode = vi.fn().mockRejectedValue(new Error("create failed"));
    useCompactNavigationStore.getState().openSurface("scenes");
    useTreeStore.setState({
      createNode,
      nodes: [
        {
          id: "scene-0",
          nodeType: "scene",
          title: "Zero",
          parentId: null,
          sortOrder: "a0",
        },
      ],
    } as never);
    const tabsBefore = useTabStore.getState().tabs;
    const secondaryTabsBefore = useTabStore.getState().secondaryTabs;

    render(
      <ConnectedMobileWorkspaceSurface
        surface="scenes"
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "シーンを追加" }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "操作を完了できませんでした。もう一度お試しください。",
      ),
    );
    expect(useTreeStore.getState().activeSceneId).toBe("scene-0");
    expect(useChatStore.getState().activeSceneId).toBe("scene-0");
    expect(useCompactNavigationStore.getState().activeSurface).toBe("scenes");
    expect(useTabStore.getState().tabs).toBe(tabsBefore);
    expect(useTabStore.getState().secondaryTabs).toBe(secondaryTabsBefore);
  });

  it("reports rejected move and delete actions without unhandled promises", async () => {
    const moveNode = vi.fn().mockRejectedValue(new Error("move failed"));
    const deleteNode = vi.fn().mockRejectedValue(new Error("delete failed"));
    useCompactNavigationStore.getState().openSurface("scenes");
    useTreeStore.setState({
      moveNode,
      deleteNode,
      nodes: [
        {
          id: "scene-0",
          nodeType: "scene",
          title: "Zero",
          parentId: null,
          sortOrder: "a0",
        },
        {
          id: "scene-1",
          nodeType: "scene",
          title: "One",
          parentId: null,
          sortOrder: "a1",
        },
      ],
    } as never);

    render(
      <ConnectedMobileWorkspaceSurface
        surface="scenes"
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Oneの操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "上へ移動" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(moveNode).toHaveBeenCalledWith("scene-1", null, null);

    fireEvent.click(screen.getByRole("button", { name: "Oneの操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "削除" }));
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(2));
    expect(deleteNode).toHaveBeenCalledWith("scene-1");
  });

  it("creates a phone scene with history but without desktop rename/reveal intent", async () => {
    const createNode = vi.fn().mockResolvedValue({
      id: "scene-new",
      nodeType: "scene",
      parentId: null,
    });
    const tabsBefore = useTabStore.getState().tabs;
    useTreeStore.setState({
      createNode,
      nodes: [
        {
          id: "scene-0",
          nodeType: "scene",
          title: "Zero",
          parentId: null,
          sortOrder: "a0",
        },
        {
          id: "scene-1",
          nodeType: "scene",
          title: "One",
          parentId: null,
          sortOrder: "a1",
        },
      ],
    } as never);

    render(
      <ConnectedMobileWorkspaceSurface
        surface="scenes"
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "シーンを追加" }));

    expect(createNode).toHaveBeenCalledWith({
      nodeType: "scene",
      parentId: null,
      afterId: "scene-0",
      interaction: "mobile",
    });
    await waitFor(() =>
      expect(useTreeStore.getState().activeSceneId).toBe("scene-new"),
    );
    expect(useCompactNavigationStore.getState().activeSurface).toBe("editor");
    expect(useTabStore.getState().tabs).toBe(tabsBefore);
  });

  it("opens a scene directly without adding or replacing desktop tabs", async () => {
    useTabStore.setState({
      secondaryTabs: [
        { nodeId: "scene-1", contentType: "scene", isPreview: false },
      ],
      secondaryActiveTabId: "scene-1",
      secondaryGroupOpen: true,
      activeGroupIndex: 0,
    } as never);
    const tabsBefore = useTabStore.getState().tabs;
    const secondaryTabsBefore = useTabStore.getState().secondaryTabs;
    render(
      <ConnectedMobileWorkspaceSurface
        surface="search"
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(
      await screen.findByRole("option", { name: "Search result" }),
    );

    expect(selectResult).not.toHaveBeenCalled();
    expect(useTreeStore.getState().activeSceneId).toBe("scene-1");
    expect(useChatStore.getState().activeSceneId).toBe("scene-1");
    expect(useCompactNavigationStore.getState().activeSurface).toBe("editor");
    expect(useEditorSessionStore.getState().focusRequests).toEqual({
      0: false,
      1: true,
    });
    expect(useTabStore.getState().tabs).toBe(tabsBefore);
    expect(useTabStore.getState().secondaryTabs).toBe(secondaryTabsBefore);
    expect(useTabStore.getState().activeGroupIndex).toBe(0);
  });

  it("routes Codex hits to Codex and leaves unsupported snippets in Search", async () => {
    getCodexEntry.mockReturnValue(new Promise(() => undefined));
    const tabsBefore = useTabStore.getState().tabs;
    searchResult.id = "lexical-codex:codex-1";
    searchResult.kind = "lexical-codex";
    const { rerender } = render(
      <ConnectedMobileWorkspaceSurface
        surface="search"
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(
      await screen.findByRole("option", { name: "Search result" }),
    );
    expect(useCodexStore.getState().pendingEntryId).toBe("codex-1");
    expect(useCompactNavigationStore.getState().activeSurface).toBe("codex");
    expect(useTabStore.getState().tabs).toBe(tabsBefore);

    useCompactNavigationStore.getState().openSurface("search");
    useCodexStore.setState({ pendingEntryId: null });
    searchResult.id = "lexical-snippet:snippet-1";
    searchResult.kind = "lexical-snippet";
    rerender(
      <ConnectedMobileWorkspaceSurface
        surface="search"
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole("option", { name: "Search result" }),
    );
    expect(toastInfo).toHaveBeenCalledOnce();
    expect(useCompactNavigationStore.getState().activeSurface).toBe("search");
    expect(useTabStore.getState().tabs).toBe(tabsBefore);
    expect(selectResult).not.toHaveBeenCalled();
  });

  it("does not let a late Codex search fetch replace a newer phone selection", async () => {
    let resolveSearch: ((entry: Record<string, unknown>) => void) | undefined;
    getCodexEntry.mockReturnValue(
      new Promise((resolve) => {
        resolveSearch = resolve;
      }),
    );
    const newerEntry = {
      id: "codex-newer",
      projectId: "project-mobile",
      type: "character",
      name: "新しい選択",
    };
    useCodexStore.setState({ entries: [newerEntry] } as never);
    usePhaseStore.setState({
      phasesByEntry: { "codex-newer": [] },
    } as never);
    searchResult.id = "lexical-codex:codex-late";
    searchResult.kind = "lexical-codex";
    const { rerender } = render(
      <ConnectedMobileWorkspaceSurface
        surface="search"
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole("option", { name: "Search result" }),
    );
    rerender(
      <ConnectedMobileWorkspaceSurface
        surface="codex"
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByText("新しい選択"));
    expect(useCodexStore.getState().pendingEntryId).toBeNull();
    expect(useCodexStore.getState().selectedEntry?.id).toBe("codex-newer");

    await act(async () => {
      resolveSearch?.({
        id: "codex-late",
        projectId: "project-mobile",
        type: "location",
        name: "遅い結果",
      });
      await Promise.resolve();
    });
    expect(useCodexStore.getState().selectedEntry?.id).toBe("codex-newer");
  });

  it("does not clear a newer Codex selection when an older fetch rejects", async () => {
    let rejectSearch: ((error: Error) => void) | undefined;
    getCodexEntry.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectSearch = reject;
      }),
    );
    const newerEntry = {
      id: "codex-newer",
      projectId: "project-mobile",
      type: "character",
      name: "新しい選択",
    };
    useCodexStore.setState({ entries: [newerEntry] } as never);
    usePhaseStore.setState({
      phasesByEntry: { "codex-newer": [] },
    } as never);
    searchResult.id = "lexical-codex:codex-late";
    searchResult.kind = "lexical-codex";
    const { rerender } = render(
      <ConnectedMobileWorkspaceSurface
        surface="search"
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole("option", { name: "Search result" }),
    );
    rerender(
      <ConnectedMobileWorkspaceSurface
        surface="codex"
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByText("新しい選択"));

    await act(async () => {
      rejectSearch?.(new Error("late failure"));
      await Promise.resolve();
    });

    expect(useCodexStore.getState().pendingEntryId).toBeNull();
    expect(useCodexStore.getState().selectedEntry?.id).toBe("codex-newer");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("opens a filtered-out Codex hit by id and renders its phone detail", async () => {
    const filteredEntry = {
      id: "codex-filtered",
      projectId: "project-mobile",
      type: "character",
      name: "葵",
      summary: "主人公",
    };
    getCodexEntry.mockResolvedValue(filteredEntry);
    useCodexStore.setState({
      entries: [],
      filterType: "location",
      ensureEntriesLoaded: vi.fn().mockResolvedValue(undefined),
    } as never);
    usePhaseStore.setState({
      phasesByEntry: { "codex-filtered": [] },
    } as never);
    searchResult.id = "lexical-codex:codex-filtered";
    searchResult.kind = "lexical-codex";
    const { rerender } = render(
      <ConnectedMobileWorkspaceSurface
        surface="search"
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(
      await screen.findByRole("option", { name: "Search result" }),
    );
    await waitFor(() =>
      expect(useCodexStore.getState().selectedEntry?.id).toBe("codex-filtered"),
    );
    expect(useCodexStore.getState().pendingEntryId).toBeNull();

    rerender(
      <ConnectedMobileWorkspaceSurface
        surface="codex"
        onOpenSettings={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "葵" }),
    ).toBeInTheDocument();
    expect(screen.getByText("主人公")).toBeInTheDocument();
  });

  it("persists phone Codex type and summary edits through their canonical store paths", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const updateText = vi.fn().mockResolvedValue(undefined);
    const entry = {
      id: "codex-edit",
      projectId: "project-mobile",
      type: "character",
      name: "葵",
      summary: "主人公",
    };
    useCodexStore.setState({
      entries: [entry],
      selectedEntry: entry,
      types: [
        { slug: "character", label: "キャラクター" },
        { slug: "location", label: "場所" },
      ],
      update,
      updateText,
    } as never);
    usePhaseStore.setState({
      phasesByEntry: { "codex-edit": [] },
    } as never);

    render(
      <ConnectedMobileWorkspaceSurface
        surface="codex"
        onOpenSettings={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    fireEvent.change(screen.getByRole("combobox", { name: "種別" }), {
      target: { value: "location" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "要約" }), {
      target: { value: "新しい要約" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith("codex-edit", {
        type: "location",
      });
      expect(updateText).toHaveBeenCalledWith("codex-edit", {
        summary: "新しい要約",
      });
    });
  });

  it("clears a Codex request when the search result no longer exists", async () => {
    searchResult.id = "lexical-codex:codex-gone";
    searchResult.kind = "lexical-codex";
    render(
      <ConnectedMobileWorkspaceSurface
        surface="search"
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(
      await screen.findByRole("option", { name: "Search result" }),
    );

    await waitFor(() =>
      expect(useCodexStore.getState().pendingEntryId).toBeNull(),
    );
    expect(toastInfo).toHaveBeenCalledOnce();
    expect(useCompactNavigationStore.getState().activeSurface).toBe("codex");
  });

  it("clears the matching Codex request and reports a fetch failure", async () => {
    getCodexEntry.mockRejectedValue(new Error("load failed"));
    searchResult.id = "lexical-codex:codex-failed";
    searchResult.kind = "lexical-codex";
    render(
      <ConnectedMobileWorkspaceSurface
        surface="search"
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(
      await screen.findByRole("option", { name: "Search result" }),
    );

    await waitFor(() =>
      expect(useCodexStore.getState().pendingEntryId).toBeNull(),
    );
    expect(useCodexStore.getState().selectedEntry).toBeNull();
    expect(toastError).toHaveBeenCalledWith(
      "検索結果を開けませんでした。もう一度お試しください。",
    );
  });

  it("uses the localized Search surface name", () => {
    render(
      <ConnectedMobileWorkspaceSurface
        surface="search"
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByRole("region", { name: "検索" })).toBeInTheDocument();
  });

  it("queues a semantic jump before opening its scene without hidden tabs", async () => {
    const tabsBefore = useTabStore.getState().tabs;
    searchResult.id = "semantic-chunk:scene-1:0:12";
    searchResult.kind = "semantic-chunk";
    render(
      <ConnectedMobileWorkspaceSurface
        surface="search"
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(
      await screen.findByRole("option", { name: "Search result" }),
    );

    expect(selectResult).not.toHaveBeenCalled();
    expect(useSemanticNavStore.getState().pendingJump).toEqual({
      sceneId: "scene-1",
      chunkText: "Result excerpt",
    });
    expect(useTreeStore.getState().activeSceneId).toBe("scene-1");
    expect(useCompactNavigationStore.getState().activeSurface).toBe("editor");
    expect(useTabStore.getState().tabs).toBe(tabsBefore);
  });

  it("leaves scene, surface, focus, and chat untouched while inline AI is pending", async () => {
    useInlineAiStore.setState({ status: "diffShown" });
    render(
      <ConnectedMobileWorkspaceSurface
        surface="search"
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(
      await screen.findByRole("option", { name: "Search result" }),
    );

    expect(useTreeStore.getState().activeSceneId).toBe("scene-0");
    expect(useChatStore.getState().activeSceneId).toBe("scene-0");
    expect(useCompactNavigationStore.getState().activeSurface).toBe("search");
    expect(useEditorSessionStore.getState().focusRequests).toEqual({
      0: false,
      1: false,
    });
    expect(toastInfo).toHaveBeenCalledOnce();
  });
});
