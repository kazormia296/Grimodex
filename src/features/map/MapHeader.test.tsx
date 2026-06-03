// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  act,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MapBoard } from "@/db/schema";

// Board 編集 popover の「即閉じ」回帰 (38e56bba / 0a4f5c60) を gate する。
// 壊れやすい連鎖: dropdown row 操作 → suppressTriggerRefocusRef=true →
// setEditingBoard で Popover open → dropdown が閉じ onCloseAutoFocus で
// trigger refocus を抑止 → PopoverContent.onFocusOutside で focus-outside を
// 抑止、の全段が揃って初めて popover が開いたまま残る。
//
// 差分検証 (実測): MapHeader の onCloseAutoFocus / onFocusOutside の preventDefault を
// 外すと、create / rename(F2) / rename(ペンアイコン) の 3 テストは happy-dom 上で落ちる
// （trigger refocus → focus-outside 連鎖が発火し editingBoard が null に戻り form が消える）。
// = この 3 ケースは回帰を実際に gate している。
// delete 確認 popover は autofocus input を持たない (BoardDeleteConfirm は button のみ)
// ため happy-dom では即閉じを再現せず、fix の有無で差が出ない → flow テスト止まり。
//
// hover ペンアイコン (onClick) 経路の扱い (実測で診断):
//   userEvent.click（フル pointer 列）だと happy-dom では rename が開かず、代わりに
//   「行が選択され active board が切替わる」。原因 = 行選択の抑止は wrapper の
//   pointerdown stopPropagation に依存するが、happy-dom の Radix は pointerup で
//   行を select してしまい menu が unmount され、icon の click→setEditingBoard が
//   走る前に消える。実ブラウザは pointerdown 追跡を尊重するためこの経路は機能する。
//   → icon は click 単体 (fireEvent.click) で onClick 配線だけを isolate して
//     unit テストする（フル pointer 相互作用＝行選択抑止は real-browser-only で別層）。
//
// 原則: DB 境界 (mapApi) のみ mock。mapStore / projectStore は実物 (zustand) を使う。
const listBoards = vi.fn();
const renameBoard = vi.fn();
const createBoard = vi.fn();
const deleteBoard = vi.fn();
const duplicateBoard = vi.fn();

vi.mock("./mapApi", () => ({
  listBoards: (...a: unknown[]) => listBoards(...a),
  renameBoard: (...a: unknown[]) => renameBoard(...a),
  createBoard: (...a: unknown[]) => createBoard(...a),
  deleteBoard: (...a: unknown[]) => deleteBoard(...a),
  duplicateBoard: (...a: unknown[]) => duplicateBoard(...a),
}));

import { MapHeader } from "./MapHeader";
import { useMapStore } from "./mapStore";

function board(id: string, title: string): MapBoard {
  // 本コンポーネントが読むのは id / title のみ
  return { id, title } as unknown as MapBoard;
}

const BOARDS = [board("b1", "ボードA"), board("b2", "ボードB")];

async function openBoardMenu(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText("ボードA"); // boards 非同期ロード待ち
  await user.click(screen.getByTitle("ボードを切り替え"));
}

beforeEach(() => {
  vi.clearAllMocks();
  listBoards.mockResolvedValue(BOARDS);
  renameBoard.mockResolvedValue(undefined);
  createBoard.mockResolvedValue(board("b3", "新ボード"));
  deleteBoard.mockResolvedValue(undefined);
  act(() => {
    useMapStore.getState().setActiveBoardId("b1");
  });
});

describe("MapHeader board 編集 popover", () => {
  it("「+ 新規ボード」で popover が開き、focus settle 後も残存し、作成できる", async () => {
    const user = userEvent.setup();
    render(<MapHeader />);
    await openBoardMenu(user);

    await user.click(await screen.findByText("+ 新規ボード"));

    // 即閉じ回帰の核心: フォームが settle 後も残存していること
    await waitFor(() => {
      expect(screen.getByText("新規ボード名")).toBeInTheDocument();
    });
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "新ボード");
    await user.click(screen.getByRole("button", { name: "作成" }));

    expect(createBoard).toHaveBeenCalledWith(expect.any(String), "新ボード");
  });

  it("F2 で rename popover が開き、現在名が入り、settle 後も残存し、改名できる", async () => {
    const user = userEvent.setup();
    render(<MapHeader />);
    await openBoardMenu(user);

    const rowB = await screen.findByRole("menuitem", { name: /ボードB/ });
    rowB.focus();
    await user.keyboard("{F2}");

    await waitFor(() => {
      expect(screen.getByDisplayValue("ボードB")).toBeInTheDocument();
    });
    const input = screen.getByDisplayValue("ボードB");
    await user.clear(input);
    await user.type(input, "ボードB改");
    await user.click(screen.getByRole("button", { name: "リネーム" }));

    expect(renameBoard).toHaveBeenCalledWith("b2", "ボードB改");
  });

  it("ペンアイコンの onClick で対象ボードの rename フォームが開く [handler 配線]", async () => {
    const user = userEvent.setup();
    render(<MapHeader />);
    await openBoardMenu(user);

    const pencil = await screen.findByRole("button", {
      name: "「ボードB」をリネーム",
    });
    // フル pointer 列は happy-dom の Radix が行選択してしまう (上のコメント参照)。
    // click 単体で icon の onClick 配線だけを isolate する。
    fireEvent.click(pencil);

    expect(screen.getByDisplayValue("ボードB")).toBeInTheDocument();
    // 行選択 (active board 切替) は起きていない = ペンの意図だけが走った
    expect(useMapStore.getState().activeBoardId).toBe("b1");

    const input = screen.getByDisplayValue("ボードB");
    await user.clear(input);
    await user.type(input, "ボードB改");
    await user.click(screen.getByRole("button", { name: "リネーム" }));

    expect(renameBoard).toHaveBeenCalledWith("b2", "ボードB改");
  });

  it("Delete キーで削除確認が開き deleteBoard が呼ばれる (flow)", async () => {
    const user = userEvent.setup();
    render(<MapHeader />);
    await openBoardMenu(user);

    const rowB = await screen.findByRole("menuitem", { name: /ボードB/ });
    rowB.focus();
    await user.keyboard("{Delete}");

    await waitFor(() => {
      expect(screen.getByText("ボードを削除")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "削除" }));

    expect(deleteBoard).toHaveBeenCalledWith("b2");
  });
});
