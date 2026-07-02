// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const {
  mockUpdate,
  mockAddCodexLink,
  mockRemoveCodexLink,
  mockListCodexEntriesByForeshadow,
  mockListCodexEntries,
} = vi.hoisted(() => ({
  mockUpdate: vi.fn().mockResolvedValue(undefined),
  mockAddCodexLink: vi.fn().mockResolvedValue(undefined),
  mockRemoveCodexLink: vi.fn().mockResolvedValue(undefined),
  mockListCodexEntriesByForeshadow: vi.fn().mockResolvedValue([]),
  mockListCodexEntries: vi.fn().mockResolvedValue([]),
}));

vi.mock("./api", () => ({
  addCodexLink: mockAddCodexLink,
  removeCodexLink: mockRemoveCodexLink,
  listCodexEntriesByForeshadow: mockListCodexEntriesByForeshadow,
}));

vi.mock("@/features/codex/api", () => ({
  listCodexMatchTargets: mockListCodexEntries,
}));

vi.mock("./foreshadowStore", () => ({
  useForeshadowStore: () => ({ update: mockUpdate }),
}));

vi.mock("./foreshadowNavStore", () => ({
  useForeshadowNavStore: { getState: () => ({ requestJump: vi.fn() }) },
}));

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: (sel: (s: { nodes: unknown[] }) => unknown) =>
    sel({ nodes: [] }),
}));

vi.mock("@/features/layout/layoutStore", () => ({
  useLayoutStore: { getState: () => ({ showPanel: vi.fn() }) },
}));

vi.mock("@/components/ui/animated-overlay", () => ({
  AnimatedOverlay: ({
    open,
    children,
    testId,
  }: {
    open: boolean;
    children: React.ReactNode;
    testId?: string;
  }) => (open ? <div data-testid={testId ?? "overlay"}>{children}</div> : null),
}));

import { EditForeshadowDialog } from "./EditForeshadowDialog";
import type { ForeshadowWithLabel } from "./types";

function makeItem(
  overrides: Partial<ForeshadowWithLabel> = {},
): ForeshadowWithLabel {
  return {
    id: "f-1",
    projectId: "p-1",
    title: "元のタイトル",
    intent: "元の意図",
    notes: "元のメモ",
    payoffSceneId: null,
    payoffFromPos: null,
    payoffToPos: null,
    payoffConfirmed: false,
    abandoned: false,
    secret: true,
    loadBearing: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    label: "planned",
    setupCount: 0,
    ...overrides,
  };
}

function makeCodexEntry(id: string, name: string) {
  return {
    id,
    projectId: "p-1",
    parentId: null,
    type: "character",
    name,
    aliases: null,
    excludedAliases: null,
    summary: null,
    content: "{}",
    icon: null,
    tagsCache: null,
    contextMode: "mentioned",
    childrenBudget: "compact",
    sourceChatMessageId: null,
    notes: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("EditForeshadowDialog", () => {
  beforeEach(() => {
    mockUpdate.mockClear();
    mockAddCodexLink.mockClear();
    mockRemoveCodexLink.mockClear();
    mockListCodexEntriesByForeshadow.mockResolvedValue([]);
    mockListCodexEntries.mockResolvedValue([]);
  });

  it("open=false のとき何も表示しない", () => {
    render(
      <EditForeshadowDialog open={false} item={makeItem()} onClose={vi.fn()} />,
    );
    expect(
      screen.queryByTestId("edit-foreshadow-dialog"),
    ).not.toBeInTheDocument();
  });

  it("open=true のとき item の値を初期表示する", () => {
    const item = makeItem({
      title: "テストタイトル",
      intent: "意図",
      notes: "メモ",
    });
    render(<EditForeshadowDialog open={true} item={item} onClose={vi.fn()} />);
    expect(
      (screen.getByTestId("edit-foreshadow-title-input") as HTMLInputElement)
        .value,
    ).toBe("テストタイトル");
    expect(
      (screen.getByTestId("edit-foreshadow-intent-input") as HTMLInputElement)
        .value,
    ).toBe("意図");
    expect(
      (screen.getByTestId("edit-foreshadow-notes-input") as HTMLInputElement)
        .value,
    ).toBe("メモ");
  });

  it("変更がない場合 update を呼ばずに onClose だけ呼ぶ", async () => {
    const onClose = vi.fn();
    const item = makeItem();
    render(<EditForeshadowDialog open={true} item={item} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("edit-foreshadow-save"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("タイトル変更のみ差分 patch を渡して update を呼ぶ", async () => {
    const onClose = vi.fn();
    const item = makeItem({ title: "旧タイトル" });
    render(<EditForeshadowDialog open={true} item={item} onClose={onClose} />);
    fireEvent.change(screen.getByTestId("edit-foreshadow-title-input"), {
      target: { value: "新タイトル" },
    });
    fireEvent.click(screen.getByTestId("edit-foreshadow-save"));
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith(
        "f-1",
        expect.objectContaining({ title: "新タイトル" }),
        "p-1",
      ),
    );
    const patch = mockUpdate.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(patch)).toEqual(["title"]);
  });

  it("abandoned チェックが差分として含まれる", async () => {
    const onClose = vi.fn();
    const item = makeItem({ abandoned: false });
    render(<EditForeshadowDialog open={true} item={item} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("edit-foreshadow-abandoned"));
    fireEvent.click(screen.getByTestId("edit-foreshadow-save"));
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith(
        "f-1",
        expect.objectContaining({ abandoned: true }),
        "p-1",
      ),
    );
  });

  it("payoff anchor がないとき payoffConfirmed チェックボックスが disabled", () => {
    const item = makeItem({ payoffSceneId: null });
    render(<EditForeshadowDialog open={true} item={item} onClose={vi.fn()} />);
    const cb = screen.getByTestId(
      "edit-foreshadow-payoff-confirmed",
    ) as HTMLInputElement;
    expect(cb.disabled).toBe(true);
  });

  it("payoff anchor があるとき payoffConfirmed が操作可能", () => {
    const item = makeItem({
      payoffSceneId: "s-1",
      payoffFromPos: 0,
      payoffToPos: 5,
    });
    render(<EditForeshadowDialog open={true} item={item} onClose={vi.fn()} />);
    const cb = screen.getByTestId(
      "edit-foreshadow-payoff-confirmed",
    ) as HTMLInputElement;
    expect(cb.disabled).toBe(false);
  });

  it("キャンセルボタンで onClose が呼ばれ update は呼ばれない", async () => {
    const onClose = vi.fn();
    render(
      <EditForeshadowDialog open={true} item={makeItem()} onClose={onClose} />,
    );
    fireEvent.click(screen.getByTestId("edit-foreshadow-cancel"));
    expect(onClose).toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  describe("payoff anchor 解除フロー", () => {
    it("解除ボタン押下で確認 UI が表示される", () => {
      const item = makeItem({
        payoffSceneId: "s-1",
        payoffFromPos: 0,
        payoffToPos: 5,
      });
      render(
        <EditForeshadowDialog open={true} item={item} onClose={vi.fn()} />,
      );
      fireEvent.click(screen.getByTestId("edit-foreshadow-unset-anchor"));
      expect(
        screen.getByTestId("edit-foreshadow-unset-confirm"),
      ).toBeInTheDocument();
    });

    it("確認 UI でキャンセルすると解除状態がリセットされる", () => {
      const item = makeItem({
        payoffSceneId: "s-1",
        payoffFromPos: 0,
        payoffToPos: 5,
      });
      render(
        <EditForeshadowDialog open={true} item={item} onClose={vi.fn()} />,
      );
      fireEvent.click(screen.getByTestId("edit-foreshadow-unset-anchor"));
      fireEvent.click(screen.getByTestId("edit-foreshadow-unset-cancel"));
      expect(
        screen.queryByTestId("edit-foreshadow-unset-confirm"),
      ).not.toBeInTheDocument();
      expect(
        screen.getByTestId("edit-foreshadow-unset-anchor"),
      ).toBeInTheDocument();
    });

    it("確認後に保存すると patch に payoffSceneId=null が含まれる", async () => {
      const onClose = vi.fn();
      const item = makeItem({
        payoffSceneId: "s-1",
        payoffFromPos: 0,
        payoffToPos: 5,
        payoffConfirmed: true,
      });
      render(
        <EditForeshadowDialog open={true} item={item} onClose={onClose} />,
      );
      fireEvent.click(screen.getByTestId("edit-foreshadow-unset-anchor"));
      fireEvent.click(screen.getByTestId("edit-foreshadow-unset-confirm"));
      fireEvent.click(screen.getByTestId("edit-foreshadow-save"));
      await waitFor(() =>
        expect(mockUpdate).toHaveBeenCalledWith(
          "f-1",
          expect.objectContaining({
            payoffSceneId: null,
            payoffFromPos: null,
            payoffToPos: null,
            payoffConfirmed: false,
          }),
          "p-1",
        ),
      );
    });

    it("anchor 解除後 payoffConfirmed チェックボックスが disabled になる", () => {
      const item = makeItem({
        payoffSceneId: "s-1",
        payoffFromPos: 0,
        payoffToPos: 5,
      });
      render(
        <EditForeshadowDialog open={true} item={item} onClose={vi.fn()} />,
      );
      const cb = screen.getByTestId(
        "edit-foreshadow-payoff-confirmed",
      ) as HTMLInputElement;
      expect(cb.disabled).toBe(false);

      fireEvent.click(screen.getByTestId("edit-foreshadow-unset-anchor"));
      fireEvent.click(screen.getByTestId("edit-foreshadow-unset-confirm"));
      expect(cb.disabled).toBe(true);
    });
  });

  describe("Codex リンク編集", () => {
    it("open 時に既存リンクを表示する", async () => {
      const linked = makeCodexEntry("c-1", "人物A");
      mockListCodexEntriesByForeshadow.mockResolvedValue([linked]);
      render(
        <EditForeshadowDialog
          open={true}
          item={makeItem()}
          onClose={vi.fn()}
        />,
      );
      await waitFor(() =>
        expect(screen.getByText("人物A")).toBeInTheDocument(),
      );
    });

    it("× で既存リンクを削除マーク → Save で removeCodexLink を呼ぶ", async () => {
      const linked = makeCodexEntry("c-1", "人物A");
      mockListCodexEntriesByForeshadow.mockResolvedValue([linked]);
      const onClose = vi.fn();
      render(
        <EditForeshadowDialog
          open={true}
          item={makeItem()}
          onClose={onClose}
        />,
      );
      await waitFor(() =>
        expect(
          screen.getByTestId("edit-foreshadow-unlink-codex-c-1"),
        ).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByTestId("edit-foreshadow-unlink-codex-c-1"));
      fireEvent.click(screen.getByTestId("edit-foreshadow-save"));
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(mockRemoveCodexLink).toHaveBeenCalledWith("f-1", "c-1");
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("検索から新規追加 → Save で addCodexLink を呼ぶ", async () => {
      const entry = makeCodexEntry("c-2", "場所B");
      mockListCodexEntries.mockResolvedValue([entry]);
      const onClose = vi.fn();
      render(
        <EditForeshadowDialog
          open={true}
          item={makeItem()}
          onClose={onClose}
        />,
      );
      await waitFor(() =>
        expect(
          screen.getByTestId("edit-foreshadow-add-codex"),
        ).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByTestId("edit-foreshadow-add-codex"));
      await waitFor(() =>
        expect(
          screen.getByTestId("edit-foreshadow-codex-search"),
        ).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByTestId("edit-foreshadow-codex-option-c-2"));
      fireEvent.click(screen.getByTestId("edit-foreshadow-save"));
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(mockAddCodexLink).toHaveBeenCalledWith("f-1", "c-2");
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("Cancel 時は addCodexLink / removeCodexLink を呼ばない", async () => {
      const linked = makeCodexEntry("c-1", "人物A");
      mockListCodexEntriesByForeshadow.mockResolvedValue([linked]);
      const onClose = vi.fn();
      render(
        <EditForeshadowDialog
          open={true}
          item={makeItem()}
          onClose={onClose}
        />,
      );
      await waitFor(() =>
        expect(
          screen.getByTestId("edit-foreshadow-unlink-codex-c-1"),
        ).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByTestId("edit-foreshadow-unlink-codex-c-1"));
      fireEvent.click(screen.getByTestId("edit-foreshadow-cancel"));
      expect(onClose).toHaveBeenCalled();
      expect(mockAddCodexLink).not.toHaveBeenCalled();
      expect(mockRemoveCodexLink).not.toHaveBeenCalled();
    });

    it("patch 空 + Codex リンクのみ変更でも Save が完了する", async () => {
      const entry = makeCodexEntry("c-3", "アイテムC");
      mockListCodexEntries.mockResolvedValue([entry]);
      const onClose = vi.fn();
      render(
        <EditForeshadowDialog
          open={true}
          item={makeItem()}
          onClose={onClose}
        />,
      );
      await waitFor(() =>
        expect(
          screen.getByTestId("edit-foreshadow-add-codex"),
        ).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByTestId("edit-foreshadow-add-codex"));
      await waitFor(() =>
        expect(
          screen.getByTestId("edit-foreshadow-codex-option-c-3"),
        ).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByTestId("edit-foreshadow-codex-option-c-3"));
      fireEvent.click(screen.getByTestId("edit-foreshadow-save"));
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockAddCodexLink).toHaveBeenCalledWith("f-1", "c-3");
    });
  });
});
