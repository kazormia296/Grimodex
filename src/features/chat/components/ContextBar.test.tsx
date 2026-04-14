// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContextBar } from "./ContextBar";
import type { CodexEntry } from "@/features/codex/api";
import type { PinnedCodexEntryWithData } from "../chatApi";

vi.mock("../chatStore", () => ({
  useChatStore: vi.fn(() => ""),
}));

vi.mock("../contextCreatorApi", () => ({
  runContextCreator: vi.fn(() => Promise.resolve([])),
}));

function makeEntry(id: string, name: string, type = "character"): CodexEntry {
  return {
    id,
    name,
    type,
    summary: "",
    content: "{}",
    contextMode: "auto",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    projectId: "p1",
    parentId: null,
    childrenBudget: "medium",
    tagsCache: null,
    aliases: null,
    excludedAliases: null,
    sourceChatMessageId: null,
    notes: null,
    icon: null,
  };
}

function makePinnedEntry(
  id: string,
  name: string,
  type = "character",
): PinnedCodexEntryWithData {
  return {
    ...makeEntry(id, name, type),
    withChildren: false,
    pinnedType: "codex",
    pinSource: "manual",
  };
}

const defaultProps = {
  onReturnToAuto: vi.fn(),
  onRemove: vi.fn(),
  onPin: vi.fn(),
  onOpenPinDialog: vi.fn(),
  contextTokenCount: 0,
  contextLayers: [],
  systemPrompt: "",
  model: "",
};

describe("ContextBar グループ化", () => {
  it("6件以下では個別ピルを表示する", () => {
    const entries = Array.from({ length: 6 }, (_, i) =>
      makePinnedEntry(`e${i}`, `エントリ${i}`),
    );
    render(<ContextBar {...defaultProps} pinnedEntries={entries} />);
    expect(screen.getByText("エントリ0")).toBeInTheDocument();
    expect(screen.getByText("エントリ5")).toBeInTheDocument();
    // グループピルは表示されない
    expect(screen.queryByText(/▾/)).not.toBeInTheDocument();
  });

  it("7件以上ではグループ化ピルを表示する", () => {
    const entries = [
      ...Array.from({ length: 5 }, (_, i) =>
        makePinnedEntry(`c${i}`, `キャラ${i}`, "character"),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        makePinnedEntry(`l${i}`, `場所${i}`, "location"),
      ),
    ];
    render(<ContextBar {...defaultProps} pinnedEntries={entries} />);
    // グループピルが表示される
    expect(screen.getByText(/キャラクター/)).toBeInTheDocument();
    expect(screen.getByText(/場所/)).toBeInTheDocument();
    // 個別エントリ名は非表示
    expect(screen.queryByText("キャラ0")).not.toBeInTheDocument();
  });

  it("グループピルクリックで個別エントリが展開される", async () => {
    const user = userEvent.setup();
    const entries = [
      ...Array.from({ length: 5 }, (_, i) =>
        makePinnedEntry(`c${i}`, `キャラ${i}`, "character"),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        makePinnedEntry(`l${i}`, `場所${i}`, "location"),
      ),
    ];
    render(<ContextBar {...defaultProps} pinnedEntries={entries} />);
    await user.click(screen.getByRole("button", { name: /キャラクター/ }));
    expect(screen.getByText("キャラ0")).toBeInTheDocument();
    // 場所グループはまだ折りたたみ
    expect(screen.queryByText("場所0")).not.toBeInTheDocument();
  });

  it("別グループクリックで前のポップオーバーが閉じ新しいポップオーバーが開く", async () => {
    const user = userEvent.setup();
    const entries = [
      ...Array.from({ length: 5 }, (_, i) =>
        makePinnedEntry(`c${i}`, `キャラ${i}`, "character"),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        makePinnedEntry(`l${i}`, `場所${i}`, "location"),
      ),
    ];
    render(<ContextBar {...defaultProps} pinnedEntries={entries} />);
    await user.click(screen.getByRole("button", { name: /キャラクター/ }));
    expect(screen.getByText("キャラ0")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /場所/ }));
    expect(screen.getByText("場所0")).toBeInTheDocument();
    // キャラクターグループのポップオーバーは閉じている
    expect(screen.queryByText("キャラ0")).not.toBeInTheDocument();
  });

  it("0件のグループは表示しない", () => {
    const entries = Array.from({ length: 7 }, (_, i) =>
      makePinnedEntry(`c${i}`, `キャラ${i}`, "character"),
    );
    render(<ContextBar {...defaultProps} pinnedEntries={entries} />);
    expect(screen.getByText(/キャラクター/)).toBeInTheDocument();
    expect(screen.queryByText(/場所/)).not.toBeInTheDocument();
  });
});
