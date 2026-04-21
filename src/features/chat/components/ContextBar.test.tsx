// @vitest-environment happy-dom
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
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

// AnimatePresence をスタブ化: happy-dom では exit アニメーションが完了せず
// 古い要素が DOM に残り続けるため、アニメーションなしで即時削除させる
vi.mock("motion/react", async () => {
  const { createElement } = await import("react");
  type P = Record<string, unknown> & { children?: React.ReactNode };
  const el =
    (tag: string) =>
    ({
      initial: _i,
      animate: _a,
      exit: _e,
      transition: _t,
      children,
      ...rest
    }: P) =>
      createElement(tag, rest, children);
  return {
    motion: { div: el("div"), span: el("span") },
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    useReducedMotion: () => false,
  };
});

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
  pinnedSnippetIds: new Set<string>(),
  onPinEntry: vi.fn(),
  onUnpinEntry: vi.fn(),
  onTogglePinChildren: vi.fn(),
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
    const pills = screen.getByTestId("pills-visible");
    expect(within(pills).getByText("エントリ0")).toBeInTheDocument();
    expect(within(pills).getByText("エントリ5")).toBeInTheDocument();
    // グループピルは表示されない
    expect(within(pills).queryByText(/▾/)).not.toBeInTheDocument();
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
    const pills = screen.getByTestId("pills-visible");
    // グループピルが表示される
    expect(
      within(pills).getByRole("button", { name: /キャラクター/ }),
    ).toBeInTheDocument();
    expect(
      within(pills).getByRole("button", { name: /場所/ }),
    ).toBeInTheDocument();
    // 個別エントリ名は非表示
    expect(within(pills).queryByText("キャラ0")).not.toBeInTheDocument();
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
    const pills = screen.getByTestId("pills-visible");
    await user.click(
      within(pills).getByRole("button", { name: /キャラクター/ }),
    );
    const popup = screen.getByTestId("group-popup");
    expect(within(popup).getByText("キャラ0")).toBeInTheDocument();
    // 場所グループはまだ折りたたみ
    expect(within(pills).queryByText("場所0")).not.toBeInTheDocument();
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
    const pills = screen.getByTestId("pills-visible");
    await user.click(
      within(pills).getByRole("button", { name: /キャラクター/ }),
    );
    expect(
      within(screen.getByTestId("group-popup")).getByText("キャラ0"),
    ).toBeInTheDocument();
    await user.click(within(pills).getByRole("button", { name: /場所/ }));
    const popup = screen.getByTestId("group-popup");
    expect(within(popup).getByText("場所0")).toBeInTheDocument();
    // キャラクターグループのポップオーバーは閉じている
    expect(within(popup).queryByText("キャラ0")).not.toBeInTheDocument();
  });

  it("0件のグループは表示しない", () => {
    const entries = Array.from({ length: 7 }, (_, i) =>
      makePinnedEntry(`c${i}`, `キャラ${i}`, "character"),
    );
    render(<ContextBar {...defaultProps} pinnedEntries={entries} />);
    const pills = screen.getByTestId("pills-visible");
    expect(within(pills).getByText(/キャラクター/)).toBeInTheDocument();
    expect(within(pills).queryByText(/場所/)).not.toBeInTheDocument();
  });
});

describe("ContextBar 子エントリピル表示 (非グループモード)", () => {
  it("withChildren=false のエントリは子エントリピルを表示しない", () => {
    const parent = makePinnedEntry("p1", "親キャラ", "character", false);
    useCodexStore.setState({
      entries: [makeEntry("c1", "子キャラ", "character", "p1")],
    });
    render(<ContextBar {...defaultProps} pinnedEntries={[parent]} />);
    const pills = screen.getByTestId("pills-visible");
    expect(within(pills).getByText("親キャラ")).toBeInTheDocument();
    expect(within(pills).queryByText("子キャラ")).not.toBeInTheDocument();
  });

  it("withChildren=true のエントリは子エントリを通常ピルと同スタイルで via 表示する", () => {
    const parent = makePinnedEntry("p1", "親キャラ", "character", true);
    useCodexStore.setState({
      entries: [makeEntry("c1", "子キャラ", "character", "p1")],
    });
    render(<ContextBar {...defaultProps} pinnedEntries={[parent]} />);
    const pills = screen.getByTestId("pills-visible");
    expect(within(pills).getByText("親キャラ")).toBeInTheDocument();
    expect(within(pills).getByText("子キャラ")).toBeInTheDocument();
    expect(within(pills).getByText(/via 親キャラ/)).toBeInTheDocument();
  });

  it("withChildren=true でも子がいなければ子ピルは表示されない", () => {
    const parent = makePinnedEntry("p1", "親キャラ", "character", true);
    useCodexStore.setState({ entries: [] });
    render(<ContextBar {...defaultProps} pinnedEntries={[parent]} />);
    const pills = screen.getByTestId("pills-visible");
    expect(within(pills).getByText("親キャラ")).toBeInTheDocument();
    expect(within(pills).queryByText(/via 親キャラ/)).not.toBeInTheDocument();
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
    const pills = screen.getByTestId("pills-visible");
    expect(within(pills).getByText("検出キャラ")).toBeInTheDocument();
    expect(within(pills).getByText("子キャラ")).toBeInTheDocument();
    expect(within(pills).getByText(/via 検出キャラ/)).toBeInTheDocument();
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
    const pills = screen.getByTestId("pills-visible");
    expect(within(pills).getAllByText("子キャラ")).toHaveLength(1);
    expect(within(pills).queryByText(/via 親キャラ/)).not.toBeInTheDocument();
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
    const pills = screen.getByTestId("pills-visible");
    expect(within(pills).getByText("子キャラ")).toBeInTheDocument();
    const dismissBtn = within(pills).getByRole("button", {
      name: /子キャラのピン留め解除/,
    });
    await user.click(dismissBtn);
    expect(onDismissViaChild).toHaveBeenCalledWith("c1");
  });
});
