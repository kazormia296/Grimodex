// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { CodexEntry } from "../api";
import type { CodexRelationRow } from "../codexRelationApi";

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
  useCodexStore: (selector: (s: { entries: CodexEntry[] }) => unknown) =>
    selector({ entries: entriesHolder.entries }),
}));

const { listForEntryMock, deleteMock, createMock, findExactMock } = vi.hoisted(
  () => ({
    listForEntryMock: vi.fn(),
    deleteMock: vi.fn(),
    createMock: vi.fn(),
    findExactMock: vi.fn(),
  }),
);
vi.mock("../codexRelationApi", () => ({
  listCodexRelationsForEntry: listForEntryMock,
  deleteCodexRelation: deleteMock,
  createCodexRelation: createMock,
  findCodexRelationExact: findExactMock,
}));

vi.mock("../CodexEntityRelationReviewDialog", () => ({
  CodexEntityRelationReviewDialog: () => null,
}));

import { toast } from "sonner";
import { CodexTypedRelationsSection } from "./CodexTypedRelationsSection";

function entry(id: string, name: string): CodexEntry {
  return {
    id,
    projectId: "p1",
    type: "character",
    name,
  } as unknown as CodexEntry;
}

const self = entry("e1", "主人公");
const target = entry("e2", "相棒");

beforeEach(() => {
  vi.clearAllMocks();
  entriesHolder.entries = [self, target];
  listForEntryMock.mockResolvedValue([] as CodexRelationRow[]);
  findExactMock.mockResolvedValue(undefined);
  createMock.mockResolvedValue({} as CodexRelationRow);
});

describe("CodexTypedRelationsSection", () => {
  it("shows the add form even when there are no relations", async () => {
    render(<CodexTypedRelationsSection entry={self} />);
    expect(
      await screen.findByText("codex.relation.addTitle"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("codex.relation.targetLabel"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("codex-typed-relations-open-nir1-review"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("codex-typed-relation-target"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("codex-typed-relation-label"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("codex-typed-relation-add")).toBeInTheDocument();
  });

  it("keeps a stable direct-review launcher on an existing relation row", async () => {
    listForEntryMock.mockResolvedValue([
      {
        id: "rel-1",
        projectId: "p1",
        fromCodexId: "e1",
        toCodexId: "e2",
        relationType: "friend",
        label: "友人",
      },
    ] as CodexRelationRow[]);
    render(<CodexTypedRelationsSection entry={self} />);
    expect(
      await screen.findByTestId("codex-typed-relation-row-rel-1"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("codex-typed-relation-prepare-rel-1"),
    ).toBeInTheDocument();
  });

  it("requires a label before creating", async () => {
    render(<CodexTypedRelationsSection entry={self} />);
    await screen.findByText("codex.relation.addTitle");

    fireEvent.change(screen.getByLabelText("codex.relation.targetLabel"), {
      target: { value: "e2" },
    });
    fireEvent.click(screen.getByText("codex.relation.add"));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("codex.relation.labelRequired");
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("creates an outgoing relation with from=self, to=target", async () => {
    render(<CodexTypedRelationsSection entry={self} />);
    await screen.findByText("codex.relation.addTitle");

    fireEvent.change(screen.getByLabelText("codex.relation.targetLabel"), {
      target: { value: "e2" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("codex.relation.labelPlaceholder"),
      { target: { value: "親友" } },
    );
    fireEvent.click(screen.getByText("codex.relation.add"));

    await waitFor(() => {
      expect(createMock).toHaveBeenCalledWith({
        projectId: "p1",
        fromCodexId: "e1",
        toCodexId: "e2",
        relationType: "親友",
        label: "親友",
      });
    });
    // reload は mount + 作成後 で 2 回
    expect(listForEntryMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("reverses from/to when direction is incoming", async () => {
    render(<CodexTypedRelationsSection entry={self} />);
    await screen.findByText("codex.relation.addTitle");

    fireEvent.change(screen.getByLabelText("codex.relation.targetLabel"), {
      target: { value: "e2" },
    });
    fireEvent.click(screen.getByText("codex.relation.directionIncoming"));
    fireEvent.change(
      screen.getByPlaceholderText("codex.relation.labelPlaceholder"),
      { target: { value: "師匠" } },
    );
    fireEvent.click(screen.getByText("codex.relation.add"));

    await waitFor(() => {
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({ fromCodexId: "e2", toCodexId: "e1" }),
      );
    });
  });

  it("blocks exact duplicates", async () => {
    findExactMock.mockResolvedValue({ id: "dup" } as CodexRelationRow);
    render(<CodexTypedRelationsSection entry={self} />);
    await screen.findByText("codex.relation.addTitle");

    fireEvent.change(screen.getByLabelText("codex.relation.targetLabel"), {
      target: { value: "e2" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("codex.relation.labelPlaceholder"),
      { target: { value: "親友" } },
    );
    fireEvent.click(screen.getByText("codex.relation.add"));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("codex.relation.duplicate");
    });
    expect(createMock).not.toHaveBeenCalled();
  });
});
