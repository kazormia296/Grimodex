// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { CodexQuickSection } from "./CodexQuickSection";

const entryAlice = {
  id: "e1",
  type: "character",
  name: "アリス",
  summary: "主人公",
  content: "{}",
  contextMode: "mentioned",
};

vi.mock("@/features/editor/codexHighlightStore", () => ({
  useCodexHighlightStore: (sel: (s: unknown) => unknown) =>
    sel({
      matchedEntryIds: ["e1"],
      typeColorMap: { character: { fg: "#6B7ADB" } },
    }),
}));
vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: Object.assign(
    (sel: (s: unknown) => unknown) =>
      sel({ entries: [entryAlice], sortOrder: "manual" }),
    { getState: () => ({ requestSelectEntry: vi.fn() }) },
  ),
}));
vi.mock("@/features/layout/layoutStore", () => ({
  useLayoutStore: Object.assign(() => undefined, {
    getState: () => ({ showPanel: vi.fn() }),
  }),
}));
const treeState = {
  pinnedCodexIds: [] as string[],
  togglePinnedCodex: vi.fn(),
  activeSceneId: "s2",
};
vi.mock("./treeStore", () => ({
  useTreeStore: Object.assign(
    (sel?: (s: typeof treeState) => unknown) =>
      sel ? sel(treeState) : treeState,
    { getState: () => treeState },
  ),
}));
const phaseState = {
  phasesByEntry: {
    e1: [
      {
        id: "p1",
        entryId: "e1",
        label: "第2幕",
        anchorNodeId: "s2",
        summaryOverride: "第2幕の姿",
        contentOverride: null,
        contextModeOverride: null,
      },
    ],
  },
  detailOverrides: {},
  globalSceneOrder: new Map([
    ["s1", 0],
    ["s2", 1],
    ["s3", 2],
  ]),
  loadPhasesForEntry: vi.fn().mockResolvedValue(undefined),
};
vi.mock("@/features/codex/phaseStore", () => ({
  usePhaseStore: Object.assign(
    (sel: (s: typeof phaseState) => unknown) => sel(phaseState),
    { getState: () => phaseState },
  ),
}));
vi.mock("@/features/foreshadow/api", () => ({
  listForeshadowsByCodexEntry: vi.fn().mockResolvedValue([
    {
      id: "f1",
      title: "王の正体",
      secret: true,
      abandoned: false,
      payoffConfirmed: false,
      payoffSceneId: "s3",
    },
  ]),
}));
vi.mock("@/features/codex/typeApi", () => ({
  listCodexTypes: vi.fn().mockResolvedValue([]),
  ensureBuiltinTypes: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "p1",
  getCurrentProjectLanguage: () => "ja",
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, opts?: { titles?: string }) =>
      opts?.titles ? `このシーン時点で未開示: ${opts.titles}` : k,
  }),
}));

// motion/react: AnimatePresence はアニメーションなしで即時描画
vi.mock("motion/react", async () => {
  const { createElement } = await import("react");
  type P = Record<string, unknown> & { children?: React.ReactNode };
  const el =
    (tag: string) =>
    ({ children, ...rest }: P) =>
      createElement(tag, rest, children);
  return {
    motion: { div: el("div"), span: el("span") },
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => children,
    useReducedMotion: () => false,
  };
});

// CodexCommandPalette: 表示されない状態でのみ使われるので最小スタブ
vi.mock("@/features/codex/components/CodexCommandPalette", () => ({
  CodexCommandPalette: () => null,
}));

// CodexQuickPopover: happy-dom では createPortal が空になるため最小スタブ
vi.mock("./CodexQuickPopover", () => ({
  CodexQuickPopover: () => null,
}));

describe("CodexQuickSection", () => {
  beforeEach(() => vi.clearAllMocks());
  it("phase チップ（第2幕）を行に常時表示する", async () => {
    render(<CodexQuickSection />);
    expect(await screen.findByText("第2幕")).toBeInTheDocument();
  });
  it("未開示の秘匿伏線がある行に ⚠（未開示）を表示する", async () => {
    render(<CodexQuickSection />);
    expect(
      await screen.findByTestId("codex-quick-spoiler-e1"),
    ).toBeInTheDocument();
  });
});
