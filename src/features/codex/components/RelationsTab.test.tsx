// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CodexEntry } from "../api";

// i18n: return the key so we can assert on stable identifiers.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const { entriesHolder } = vi.hoisted(() => ({
  entriesHolder: { entries: [] as CodexEntry[] },
}));
vi.mock("../codexStore", () => ({
  useCodexStore: (
    selector: (s: {
      entries: CodexEntry[];
      loadEntries: () => Promise<void>;
    }) => unknown,
  ) =>
    selector({
      entries: entriesHolder.entries,
      loadEntries: vi.fn().mockResolvedValue(undefined),
    }),
}));

// RelationSection (階層/親子) async deps — keep them inert on mount.
vi.mock("../relationApi", () => ({
  listDismissedRelationIds: vi.fn().mockResolvedValue([]),
  dismissRelation: vi.fn(),
  undismissRelation: vi.fn(),
  setParentRelation: vi.fn(),
}));
vi.mock("../rustMatcher", () => ({
  findMentionedEntriesAsync: vi.fn().mockResolvedValue([]),
}));
vi.mock("../prosemirrorTextExtractor", () => ({
  extractPlainText: () => "",
}));
vi.mock("@/store/globalHistoryStore", () => ({
  useGlobalHistoryStore: {
    getState: () => ({ isReplaying: false, push: vi.fn() }),
  },
}));

// CodexTypedRelationsSection (関係/対人) async deps.
vi.mock("../codexRelationApi", () => ({
  listCodexRelationsForEntry: vi.fn().mockResolvedValue([]),
  deleteCodexRelation: vi.fn(),
  createCodexRelation: vi.fn(),
  findCodexRelationExact: vi.fn().mockResolvedValue(undefined),
}));

import { RelationsTab } from "./RelationsTab";

function makeEntry(id: string, name: string): CodexEntry {
  return {
    id,
    projectId: "p1",
    parentId: null,
    type: "character",
    name,
    content: "{}",
    childrenBudget: "compact",
  } as unknown as CodexEntry;
}

const self = makeEntry("e1", "主人公");

beforeEach(() => {
  vi.clearAllMocks();
  entriesHolder.entries = [self];
});

describe("RelationsTab", () => {
  it("renders 階層(親子) and 関係(対人) as distinct sections with their own descriptions", async () => {
    render(
      <RelationsTab
        entry={self}
        childrenBudget="compact"
        onChildrenBudgetChange={() => {}}
      />,
    );

    expect(await screen.findByText("codex.relation.title")).toBeInTheDocument();
    expect(
      screen.getByText("codex.relation.hierarchyDesc"),
    ).toBeInTheDocument();
    expect(screen.getByText("codex.relation.typedTitle")).toBeInTheDocument();
    expect(screen.getByText("codex.relation.typedDesc")).toBeInTheDocument();
  });

  it("places the children-context budget inside the 階層(親子) group, before 関係(対人)", async () => {
    render(
      <RelationsTab
        entry={self}
        childrenBudget="compact"
        onChildrenBudgetChange={() => {}}
      />,
    );

    const hierarchyTitle = await screen.findByText("codex.relation.title");
    const budgetLabel = screen.getByText("codex.childrenBudget.label");
    const relationTitle = screen.getByText("codex.relation.typedTitle");

    // DOM order must be: 階層 heading → children budget → 関係 heading,
    // so the budget reads as part of the hierarchy section, not the relations.
    expect(
      hierarchyTitle.compareDocumentPosition(budgetLabel) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      budgetLabel.compareDocumentPosition(relationTitle) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
