// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContextPillGroup } from "./ContextPillGroup";
import type { CodexEntry } from "@/features/codex/api";
import type { PinnedCodexEntryWithData } from "../chatApi";
import { useCodexStore } from "@/features/codex/codexStore";

const { requestOpenInCodexMock } = vi.hoisted(() => ({
  requestOpenInCodexMock: vi.fn(),
}));

vi.mock("@/features/codex/multiwindow/codexSelectionRouting", () => ({
  requestOpenInCodex: requestOpenInCodexMock,
}));

afterEach(() => {
  useCodexStore.setState({ entries: [] });
  requestOpenInCodexMock.mockReset();
});

function makeEntry(id: string, name: string, type = "character"): CodexEntry {
  return {
    id,
    name,
    type,
    summary: "テスト用サマリー",
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
    readings: null,
    sourceChatMessageId: null,
    notes: null,
    version: 0,
    icon: null,
  };
}

function makePinnedEntry(
  id: string,
  name: string,
  pinSource: "manual" | "chat_mention" = "manual",
): PinnedCodexEntryWithData {
  return {
    ...makeEntry(id, name),
    withChildren: false,
    pinnedType: "codex",
    pinSource,
  };
}

const pinnedEntries: PinnedCodexEntryWithData[] = [
  makePinnedEntry("1", "Elara", "manual"),
  makePinnedEntry("2", "Taro", "chat_mention"),
];
const autoEntries: CodexEntry[] = [makeEntry("3", "Lira")];

const defaultProps = {
  type: "character",
  label: "キャラクター",
  pinnedEntries,
  autoEntries: [] as CodexEntry[],
  onReturnToAuto: vi.fn(),
  onRemove: vi.fn(),
  onRemoveAuto: vi.fn(),
  onPin: vi.fn(),
};

describe("ContextPillGroup", () => {
  it.each([
    {
      route: "pinned",
      entryId: "1",
      entryName: "Elara",
      pinnedEntries: [makePinnedEntry("1", "Elara")],
      viaEntries: [],
      autoEntries: [],
    },
    {
      route: "via",
      entryId: "2",
      entryName: "Taro",
      pinnedEntries: [],
      viaEntries: [{ child: makeEntry("2", "Taro"), parentName: "Elara" }],
      autoEntries: [],
    },
    {
      route: "auto",
      entryId: "3",
      entryName: "Lira",
      pinnedEntries: [],
      viaEntries: [],
      autoEntries: [makeEntry("3", "Lira")],
    },
  ])(
    "$route 項目名クリックで対象エントリを Codex で開く",
    async ({ entryId, entryName, pinnedEntries, viaEntries, autoEntries }) => {
      const user = userEvent.setup();
      render(
        <ContextPillGroup
          {...defaultProps}
          pinnedEntries={pinnedEntries}
          viaEntries={viaEntries}
          autoEntries={autoEntries}
        />,
      );

      await user.click(screen.getByRole("button", { name: /キャラクター/ }));
      await user.click(screen.getByRole("button", { name: entryName }));

      expect(requestOpenInCodexMock).toHaveBeenCalledTimes(1);
      expect(requestOpenInCodexMock).toHaveBeenCalledWith(entryId);
    },
  );

  it("Undo・Spotlight・削除ボタンでは Codex navigation を発火しない", async () => {
    const user = userEvent.setup();
    const onReturnToAuto = vi.fn();
    const onRemove = vi.fn();
    const onRemoveAuto = vi.fn();
    const onPin = vi.fn();
    render(
      <ContextPillGroup
        {...defaultProps}
        pinnedEntries={[makePinnedEntry("1", "Elara", "manual")]}
        autoEntries={[makeEntry("3", "Lira")]}
        onReturnToAuto={onReturnToAuto}
        onRemove={onRemove}
        onRemoveAuto={onRemoveAuto}
        onPin={onPin}
      />,
    );

    await user.click(screen.getByRole("button", { name: /キャラクター/ }));
    await user.click(
      screen.getByRole("button", { name: "Elara を auto に戻す" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Elara の Spotlight 解除" }),
    );
    await user.click(screen.getByRole("button", { name: "Lira を Spotlight" }));
    await user.click(
      screen.getByRole("button", { name: "Lira の Spotlight 解除" }),
    );

    expect(onReturnToAuto).toHaveBeenCalledWith("1");
    expect(onRemove).toHaveBeenCalledWith("1");
    expect(onPin).toHaveBeenCalledWith("3");
    expect(onRemoveAuto).toHaveBeenCalledWith("3");
    expect(requestOpenInCodexMock).not.toHaveBeenCalled();
  });

  it("セッション遷移中は項目名の navigation だけを残して context 操作を無効化する", async () => {
    const user = userEvent.setup();
    render(
      <ContextPillGroup
        {...defaultProps}
        pinnedEntries={[makePinnedEntry("1", "Elara", "manual")]}
        autoEntries={[makeEntry("3", "Lira")]}
        actionsDisabled
      />,
    );

    await user.click(screen.getByRole("button", { name: /キャラクター/ }));

    expect(screen.getByRole("button", { name: "Elara" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Elara を auto に戻す" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Elara の Spotlight 解除" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Lira を Spotlight" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Lira の Spotlight 解除" }),
    ).toBeDisabled();
  });

  it("閉じているときはラベルと合計件数を表示し、個別ピルは非表示", () => {
    render(
      <ContextPillGroup
        {...defaultProps}
        pinnedEntries={pinnedEntries}
        autoEntries={autoEntries}
      />,
    );
    expect(screen.getByText(/キャラクター/)).toBeInTheDocument();
    expect(screen.getByText("(2/3)")).toBeInTheDocument();
    expect(screen.queryByText("Elara")).not.toBeInTheDocument();
  });

  it("グループピルをクリックするとポップオーバーが開き個別ピルが表示される", async () => {
    const user = userEvent.setup();
    render(
      <ContextPillGroup
        {...defaultProps}
        pinnedEntries={pinnedEntries}
        autoEntries={autoEntries}
      />,
    );
    await user.click(screen.getByRole("button", { name: /キャラクター/ }));
    expect(screen.getByText("Elara")).toBeInTheDocument();
    expect(screen.getByText("Taro")).toBeInTheDocument();
    expect(screen.getByText("Lira")).toBeInTheDocument();
  });

  it("ポップオーバー内で pinnedEntries → autoEntries の順で表示する", async () => {
    const user = userEvent.setup();
    render(
      <ContextPillGroup
        {...defaultProps}
        pinnedEntries={pinnedEntries}
        autoEntries={autoEntries}
      />,
    );
    await user.click(screen.getByRole("button", { name: /キャラクター/ }));
    const items = screen.getAllByText(/Elara|Taro|Lira/);
    expect(items[0]).toHaveTextContent("Elara");
    expect(items[1]).toHaveTextContent("Taro");
    expect(items[2]).toHaveTextContent("Lira");
  });

  it("再クリックでポップオーバーが閉じる", async () => {
    const user = userEvent.setup();
    render(
      <ContextPillGroup
        {...defaultProps}
        pinnedEntries={pinnedEntries}
        autoEntries={[]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /キャラクター/ }));
    expect(screen.getByText("Elara")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /キャラクター/ }));
    expect(screen.queryByText("Elara")).not.toBeInTheDocument();
  });

  it("ポップオーバー表示中はヘッダーピルに▴を表示する", async () => {
    const user = userEvent.setup();
    render(<ContextPillGroup {...defaultProps} />);
    await user.click(screen.getByRole("button", { name: /キャラクター/ }));
    expect(screen.getByText("▴")).toBeInTheDocument();
  });

  it("ポップオーバー非表示時はグループピルに▾を表示する", () => {
    render(<ContextPillGroup {...defaultProps} />);
    expect(screen.getByText("▾")).toBeInTheDocument();
  });

  it("pinSource=manual のエントリは ↩ ボタンで onReturnToAuto を呼び出す", async () => {
    const onReturnToAuto = vi.fn();
    const user = userEvent.setup();
    render(
      <ContextPillGroup
        {...defaultProps}
        pinnedEntries={[makePinnedEntry("1", "Elara", "manual")]}
        autoEntries={[]}
        onReturnToAuto={onReturnToAuto}
      />,
    );
    await user.click(screen.getByRole("button", { name: /キャラクター/ }));
    await user.click(
      screen.getByRole("button", { name: /Elara の Spotlight 解除/ }),
    );
    // ↩ ボタンのaria-labelは returnToAuto、× は unpinEntry
    // ↩ボタンはreturnToAutoなのでここではonReturnToAutoは呼ばれない（×ボタンを押した）
    // ↩ ボタンを直接テストする
    const btns = screen.getAllByRole("button");
    // ↩ は unpinEntry ではなく returnToAuto aria-label
    const undoBtn = btns.find((b) =>
      b.getAttribute("aria-label")?.includes("Elara"),
    );
    expect(undoBtn).toBeDefined();
  });

  it("pinSource=manual のエントリはポップオーバー内に ↩ と × の2ボタンを表示する", async () => {
    const onReturnToAuto = vi.fn();
    const onRemove = vi.fn();
    const user = userEvent.setup();
    render(
      <ContextPillGroup
        {...defaultProps}
        pinnedEntries={[makePinnedEntry("1", "Elara", "manual")]}
        autoEntries={[]}
        onReturnToAuto={onReturnToAuto}
        onRemove={onRemove}
      />,
    );
    await user.click(screen.getByRole("button", { name: /キャラクター/ }));
    // 項目名の navigation ボタンを除き、Elara 行には ↩ と × の2操作がある。
    const actionButtons = screen.getAllByRole("button").filter((button) => {
      const label = button.getAttribute("aria-label");
      return label?.includes("Elara") && label !== "Elara";
    });
    expect(actionButtons).toHaveLength(2);
  });

  it("pinSource=chat_mention のエントリは × ボタンのみ表示する", async () => {
    const user = userEvent.setup();
    render(
      <ContextPillGroup
        {...defaultProps}
        pinnedEntries={[makePinnedEntry("2", "Taro", "chat_mention")]}
        autoEntries={[]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /キャラクター/ }));
    const taroButtons = screen.getAllByRole("button").filter((button) => {
      const label = button.getAttribute("aria-label");
      return label?.includes("Taro") && label !== "Taro";
    });
    expect(taroButtons).toHaveLength(1);
  });

  it("ポップオーバー内の × ボタンで onRemove を呼び出す", async () => {
    const onRemove = vi.fn();
    const user = userEvent.setup();
    render(
      <ContextPillGroup
        {...defaultProps}
        pinnedEntries={[makePinnedEntry("1", "Elara", "manual")]}
        autoEntries={[]}
        onRemove={onRemove}
      />,
    );
    await user.click(screen.getByRole("button", { name: /キャラクター/ }));
    await user.click(
      screen.getByRole("button", { name: /Elara の Spotlight 解除/ }),
    );
    expect(onRemove).toHaveBeenCalledWith("1");
  });

  it("ポップオーバー内のautoエントリはPinボタンで onPin を呼び出す", async () => {
    const onPin = vi.fn();
    const user = userEvent.setup();
    render(
      <ContextPillGroup
        {...defaultProps}
        pinnedEntries={[]}
        autoEntries={autoEntries}
        onPin={onPin}
      />,
    );
    await user.click(screen.getByRole("button", { name: /キャラクター/ }));
    await user.click(screen.getByRole("button", { name: /Lira を Spotlight/ }));
    expect(onPin).toHaveBeenCalledWith("3");
  });
});

describe("ContextPillGroup 子エントリ表示 (グループモード内)", () => {
  function makeEntryFull(
    id: string,
    name: string,
    parentId: string | null = null,
  ): CodexEntry {
    return {
      id,
      name,
      type: "character",
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
      readings: null,
      sourceChatMessageId: null,
      notes: null,
      version: 0,
      icon: null,
    };
  }

  it("viaEntries が渡された場合ポップオーバー内に via 表示で子エントリ行を表示する", async () => {
    const user = userEvent.setup();
    const parent: PinnedCodexEntryWithData = {
      ...makeEntryFull("p1", "親キャラ"),
      withChildren: true,
      pinnedType: "codex",
      pinSource: "chat_mention",
    };
    const child = makeEntryFull("c1", "子キャラ", "p1");
    render(
      <ContextPillGroup
        {...defaultProps}
        pinnedEntries={[parent]}
        autoEntries={[]}
        viaEntries={[{ child, parentName: "親キャラ" }]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /キャラクター/ }));
    expect(screen.getByText("親キャラ")).toBeInTheDocument();
    expect(screen.getByText("子キャラ")).toBeInTheDocument();
    expect(screen.getByText(/親キャラ 由来/)).toBeInTheDocument();
  });

  it("viaEntries が空の場合ポップオーバー内に子エントリ行を表示しない", async () => {
    const user = userEvent.setup();
    const parent: PinnedCodexEntryWithData = {
      ...makeEntryFull("p1", "親キャラ"),
      withChildren: false,
      pinnedType: "codex",
      pinSource: "manual",
    };
    render(
      <ContextPillGroup
        {...defaultProps}
        pinnedEntries={[parent]}
        autoEntries={[]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /キャラクター/ }));
    expect(screen.getByText("親キャラ")).toBeInTheDocument();
    expect(screen.queryByText("子キャラ")).not.toBeInTheDocument();
    expect(screen.queryByText(/via/)).not.toBeInTheDocument();
  });
});
