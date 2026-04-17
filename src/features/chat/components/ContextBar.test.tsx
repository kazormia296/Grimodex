// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContextBar } from "./ContextBar";
import type { CodexEntry } from "@/features/codex/api";
import type { PinnedCodexEntryWithData } from "../chatApi";
import { useCodexStore } from "@/features/codex/codexStore";

vi.mock("../chatStore", () => ({
  useChatStore: vi.fn(() => ""),
}));

vi.mock("../contextCreatorApi", () => ({
  runContextCreator: vi.fn(() => Promise.resolve([])),
}));

afterEach(() => {
  useCodexStore.setState({ entries: [] });
});

function makeEntry(
  id: string,
  name: string,
  type = "character",
  parentId: string | null = null,
): CodexEntry {
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
    parentId,
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
  withChildren = false,
): PinnedCodexEntryWithData {
  return {
    ...makeEntry(id, name, type),
    withChildren,
    pinnedType: "codex",
    pinSource: "manual",
  };
}

const defaultProps = {
  onReturnToAuto: vi.fn(),
  onRemove: vi.fn(),
  onRemoveAuto: vi.fn(),
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

describe("ContextBar 子エントリピル表示 (非グループモード)", () => {
  it("withChildren=false のエントリは子エントリピルを表示しない", () => {
    const parent = makePinnedEntry("p1", "親キャラ", "character", false);
    useCodexStore.setState({
      entries: [makeEntry("c1", "子キャラ", "character", "p1")],
    });
    render(<ContextBar {...defaultProps} pinnedEntries={[parent]} />);
    expect(screen.getByText("親キャラ")).toBeInTheDocument();
    expect(screen.queryByText("子キャラ")).not.toBeInTheDocument();
  });

  it("withChildren=true のエントリは子エントリを通常ピルと同スタイルで via 表示する", () => {
    const parent = makePinnedEntry("p1", "親キャラ", "character", true);
    useCodexStore.setState({
      entries: [makeEntry("c1", "子キャラ", "character", "p1")],
    });
    render(<ContextBar {...defaultProps} pinnedEntries={[parent]} />);
    expect(screen.getByText("親キャラ")).toBeInTheDocument();
    expect(screen.getByText("子キャラ")).toBeInTheDocument();
    expect(screen.getByText(/via 親キャラ/)).toBeInTheDocument();
  });

  it("withChildren=true でも子がいなければ子ピルは表示されない", () => {
    const parent = makePinnedEntry("p1", "親キャラ", "character", true);
    useCodexStore.setState({ entries: [] });
    render(<ContextBar {...defaultProps} pinnedEntries={[parent]} />);
    expect(screen.getByText("親キャラ")).toBeInTheDocument();
    expect(screen.queryByText(/via 親キャラ/)).not.toBeInTheDocument();
  });

  it("chat_mention (input-detected) エントリは withChildren=true で子ピルを via 表示する", () => {
    const parent: PinnedCodexEntryWithData = {
      ...makeEntry("p1", "検出キャラ"),
      withChildren: true,
      pinnedType: "codex",
      pinSource: "chat_mention",
    };
    useCodexStore.setState({
      entries: [makeEntry("c1", "子キャラ", "character", "p1")],
    });
    render(<ContextBar {...defaultProps} pinnedEntries={[parent]} />);
    expect(screen.getByText("検出キャラ")).toBeInTheDocument();
    expect(screen.getByText("子キャラ")).toBeInTheDocument();
    expect(screen.getByText(/via 検出キャラ/)).toBeInTheDocument();
  });

  it("子エントリが既に pinnedEntries に含まれる場合は via 表示しない（重複排除）", () => {
    const parent = makePinnedEntry("p1", "親キャラ", "character", true);
    const childAsPinned = makePinnedEntry("c1", "子キャラ", "character", false);
    useCodexStore.setState({
      entries: [makeEntry("c1", "子キャラ", "character", "p1")],
    });
    render(
      <ContextBar {...defaultProps} pinnedEntries={[parent, childAsPinned]} />,
    );
    // 子キャラはピン済みとして表示されるが via ラベルは付かない
    expect(screen.getAllByText("子キャラ")).toHaveLength(1);
    expect(screen.queryByText(/via 親キャラ/)).not.toBeInTheDocument();
  });

  it("onDismissViaChild が渡された場合、via子エントリに X ボタンが表示される", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    const onDismissViaChild = vi.fn();
    const parent = makePinnedEntry("p1", "親キャラ", "character", true);
    useCodexStore.setState({
      entries: [makeEntry("c1", "子キャラ", "character", "p1")],
    });
    render(
      <ContextBar
        {...defaultProps}
        pinnedEntries={[parent]}
        onDismissViaChild={onDismissViaChild}
      />,
    );
    expect(screen.getByText("子キャラ")).toBeInTheDocument();
    const dismissBtn = screen.getByRole("button", {
      name: /子キャラのピン留め解除/,
    });
    await user.click(dismissBtn);
    expect(onDismissViaChild).toHaveBeenCalledWith("c1");
  });
});
