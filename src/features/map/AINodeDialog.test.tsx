// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
} from "@testing-library/react";
import { AINodeDialog } from "./AINodeDialog";
import type { AiBranchSeedChipMeta } from "./aiBranchContext";

function setup() {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <AINodeDialog
      boardId="b1"
      spawnPosition={{ x: 0, y: 0 }}
      seedNodeTitles={[]}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  const textarea = screen.getByPlaceholderText("アイデアを展開してください…");
  fireEvent.change(textarea, { target: { value: "無人駅" } });
  return { onConfirm, onCancel };
}

describe("AINodeDialog — 意外性 (Verbalized Sampling) ノブ", () => {
  it("既定は標準 = VS オフ → onConfirm の vsThreshold は null", () => {
    const { onConfirm } = setup();
    fireEvent.click(screen.getByRole("button", { name: "生成" }));
    expect(onConfirm).toHaveBeenCalledWith("無人駅", 5, null);
  });

  it("「意外」を選ぶと vsThreshold=0.1", () => {
    const { onConfirm } = setup();
    fireEvent.click(screen.getByRole("button", { name: "意外" }));
    fireEvent.click(screen.getByRole("button", { name: "生成" }));
    expect(onConfirm).toHaveBeenCalledWith("無人駅", 5, 0.1);
  });

  it("「大胆」を選ぶと vsThreshold=0.05", () => {
    const { onConfirm } = setup();
    fireEvent.click(screen.getByRole("button", { name: "大胆" }));
    fireEvent.click(screen.getByRole("button", { name: "生成" }));
    expect(onConfirm).toHaveBeenCalledWith("無人駅", 5, 0.05);
  });
});

// 確認ダイアログの注記（DR-MP4-43、ユーザー決定 2026-11-23）：AI に送られない Codex の chip に注記を出す。
// 注記は表示の補助で、判定の失敗・遅れ・古い結果でもダイアログは普通に使える。
describe("AINodeDialog — 「AI には送られません」の注記", () => {
  const NOTE = "AI には送られません";
  const TITLES = ["公開の剣聖", "沈黙の司祭", "第一場", "秘匿の帝都"];
  const META: (AiBranchSeedChipMeta | undefined)[] = [
    { codexEntryId: "open", notSentLocally: false },
    { codexEntryId: "phase", notSentLocally: false },
    undefined, // 場面など Codex 以外
    { codexEntryId: "base", notSentLocally: true }, // 同期の層で外れた（base が hidden）
  ];

  function renderDialog(
    resolve: ((ids: string[]) => Promise<ReadonlySet<string>>) | undefined,
    over: Partial<{
      titles: string[];
      meta: (AiBranchSeedChipMeta | undefined)[];
    }> = {},
  ) {
    const props = (titles: string[], meta: typeof META) => (
      <AINodeDialog
        boardId="b1"
        spawnPosition={{ x: 0, y: 0 }}
        seedNodeTitles={titles}
        seedChipMeta={meta}
        resolveNotSentCodexIds={resolve}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    const view = render(props(over.titles ?? TITLES, over.meta ?? META));
    return {
      ...view,
      update: (titles: string[], meta: typeof META) =>
        view.rerender(props(titles, meta)),
    };
  }

  /** chip（題の text を持つ span）の中に注記があるか。 */
  function noteIn(title: string): boolean {
    const chip = screen.getByText(title, { exact: false }).closest("span");
    return !!chip?.textContent?.includes(NOTE);
  }

  it("判定が返ると、送られない Codex の chip にだけ注記が出る（base が hidden の chip は判定を待たず出る）。Codex 以外は変わらない", async () => {
    const resolve = vi.fn(
      async () => new Set(["phase"]) as ReadonlySet<string>,
    );
    renderDialog(resolve);
    // 判定が返る前でも、同期の層で外れた Codex は注記が出ている。
    expect(noteIn("秘匿の帝都")).toBe(true);
    await waitFor(() => expect(noteIn("沈黙の司祭")).toBe(true));
    expect(noteIn("公開の剣聖")).toBe(false);
    expect(noteIn("第一場")).toBe(false);
    expect(screen.getAllByText(NOTE)).toHaveLength(2);
    // DB の判定の対象は、同期の層で外れていない Codex の id だけ。1 回だけ呼ぶ。
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(["open", "phase"]);
  });

  it("判定中は注記なし（chip はそのまま）で、判定が返るまでダイアログは使える", async () => {
    let release: (v: ReadonlySet<string>) => void = () => {};
    const pending = new Promise<ReadonlySet<string>>((r) => (release = r));
    renderDialog(() => pending);
    expect(noteIn("沈黙の司祭")).toBe(false);
    fireEvent.change(
      screen.getByPlaceholderText("アイデアを展開してください…"),
      {
        target: { value: "x" },
      },
    );
    expect(screen.getByRole("button", { name: "生成" })).toBeEnabled();
    await act(async () => release(new Set(["phase"])));
    expect(noteIn("沈黙の司祭")).toBe(true);
  });

  it("判定が失敗したら、DB 判定の chip は注記なしのまま（ダイアログは使える。同期の層の注記は残る）", async () => {
    const resolve = vi.fn(async () => {
      throw new Error("db down");
    });
    renderDialog(resolve);
    await waitFor(() => expect(resolve).toHaveBeenCalled());
    await act(async () => {});
    expect(noteIn("沈黙の司祭")).toBe(false);
    expect(noteIn("公開の剣聖")).toBe(false);
    expect(noteIn("秘匿の帝都")).toBe(true);
    expect(screen.getByRole("button", { name: "キャンセル" })).toBeEnabled();
  });

  it("resolver が無い・Codex が無いときは判定を呼ばず、注記も出ない", async () => {
    const resolve = vi.fn(async () => new Set<string>());
    renderDialog(resolve, { titles: ["第一場"], meta: [undefined] });
    await act(async () => {});
    expect(resolve).not.toHaveBeenCalled();
    renderDialog(undefined, { titles: ["別の chip"], meta: META.slice(0, 1) });
    await act(async () => {});
    expect(screen.queryAllByText(NOTE)).toHaveLength(0);
  });

  // 結果の取り込みは「cleanup の flag」と「結果に付けた key の照合」の二重の守りで、片方ずつが別の事象を防ぐ。
  // 次の 2 件は、それぞれ片方だけを外したときに落ちる（DR-MP4-43 項 9 ⑳）。
  const SOLO = (): [string[], { codexEntryId: string }[]] => [
    ["沈黙の司祭"],
    [{ codexEntryId: "phase" }],
  ];
  const OVERLAP = (): [string[], { codexEntryId: string }[]] => [
    ["沈黙の司祭", "別の Codex"],
    [{ codexEntryId: "phase" }, { codexEntryId: "x" }],
  ];

  it("一覧 A の結果が返った後、重なる一覧 B に変わって B の判定が保留中の間は、A の結果を使わず注記なし（key の照合）", async () => {
    const releases: ((v: ReadonlySet<string>) => void)[] = [];
    const resolve = vi.fn(
      () =>
        new Promise<ReadonlySet<string>>((r) => {
          releases.push(r);
        }),
    );
    const [titlesA, metaA] = SOLO();
    const view = renderDialog(resolve, { titles: titlesA, meta: metaA });
    await act(async () => releases[0]?.(new Set(["phase"])));
    expect(noteIn("沈黙の司祭")).toBe(true);
    const [titlesB, metaB] = OVERLAP();
    view.update(titlesB, metaB);
    expect(resolve).toHaveBeenCalledTimes(2);
    // B の判定は保留中。A の結果（phase が送られない）が残って見えてはいけない。
    expect(noteIn("沈黙の司祭")).toBe(false);
    await act(async () => releases[1]?.(new Set(["phase"])));
    expect(noteIn("沈黙の司祭")).toBe(true);
  });

  it("一覧 A を保留 → B に変更 → B が返る → A が返る、の順でも、B の注記は消えない（cleanup の flag）", async () => {
    const releases: ((v: ReadonlySet<string>) => void)[] = [];
    const resolve = vi.fn(
      () =>
        new Promise<ReadonlySet<string>>((r) => {
          releases.push(r);
        }),
    );
    const [titlesA, metaA] = SOLO();
    const view = renderDialog(resolve, { titles: titlesA, meta: metaA });
    const [titlesB, metaB] = OVERLAP();
    view.update(titlesB, metaB);
    expect(resolve).toHaveBeenCalledTimes(2);
    await act(async () => releases[1]?.(new Set(["phase"])));
    expect(noteIn("沈黙の司祭")).toBe(true);
    // A の古い結果が後から返っても、B の結果を上書きしない（注記は戻らないままにならない）。
    await act(async () => releases[0]?.(new Set(["phase"])));
    expect(noteIn("沈黙の司祭")).toBe(true);
    expect(screen.getAllByText(NOTE)).toHaveLength(1);
  });

  it("種の一覧が変わった後に返った古い結果は捨てる（新しい一覧に古い判定を当てない）", async () => {
    const releases: ((v: ReadonlySet<string>) => void)[] = [];
    const resolve = vi.fn(
      (ids: string[]) =>
        new Promise<ReadonlySet<string>>((r) => {
          void ids;
          releases.push(r);
        }),
    );
    const view = renderDialog(resolve);
    expect(resolve).toHaveBeenCalledTimes(1);
    // 種の一覧が変わる：同じ id "phase" を持たない別の Codex の一覧。
    view.update(["新しい Codex"], [{ codexEntryId: "fresh" }]);
    expect(resolve).toHaveBeenCalledTimes(2);
    // 古い判定（"phase" と "fresh" を含む結果）が後から返っても使わない。
    await act(async () => releases[0]?.(new Set(["phase", "fresh"])));
    expect(noteIn("新しい Codex")).toBe(false);
    // 新しい判定が返れば反映される。
    await act(async () => releases[1]?.(new Set(["fresh"])));
    expect(noteIn("新しい Codex")).toBe(true);
  });

  it("同じ種の一覧のまま再描画しても、判定を呼び直さない", async () => {
    const resolve = vi.fn(
      async () => new Set(["phase"]) as ReadonlySet<string>,
    );
    const view = renderDialog(resolve);
    await waitFor(() => expect(noteIn("沈黙の司祭")).toBe(true));
    view.update(TITLES, [...META]);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(noteIn("沈黙の司祭")).toBe(true);
  });
});
