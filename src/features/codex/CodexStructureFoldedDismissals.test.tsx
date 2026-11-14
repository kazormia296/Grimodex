// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CodexStructureFoldedDismissals } from "./CodexStructureFoldedDismissals";

afterEach(() => cleanup());

const surface = (name: string, key = name) => ({ surface: name, key });

describe("CodexStructureFoldedDismissals", () => {
  it("畳んだ表記が無ければ何も出さない", () => {
    const { container } = render(<CodexStructureFoldedDismissals />);
    expect(container.firstChild).toBeNull();
    cleanup();
    const empty = render(
      <CodexStructureFoldedDismissals surfaces={[]} onRestore={vi.fn()} />,
    );
    expect(empty.container.firstChild).toBeNull();
  });

  it("記録を読めなかった run では注意文を出し、表記の一覧は出さない", () => {
    render(
      <CodexStructureFoldedDismissals
        unavailable
        surfaces={[surface("ミナト")]}
        onRestore={vi.fn()}
      />,
    );
    const note = screen.getByTestId(
      "codex-structure-folded-dismissed-unavailable",
    );
    expect(note.textContent).toContain("見送りの記録を読めなかった");
    expect(screen.queryByTestId("codex-structure-folded-dismissed")).toBeNull();
  });

  it("1 件の「戻す」で onRestore([key]) が呼ばれ、「戻しました」に変わる", async () => {
    const user = userEvent.setup();
    const onRestore = vi.fn();
    render(
      <CodexStructureFoldedDismissals
        surfaces={[surface("ミナト"), surface("Alice", "alice")]}
        onRestore={onRestore}
      />,
    );
    const items = screen.getAllByTestId(
      "codex-structure-folded-dismissed-item",
    );
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("「ミナト」");
    await user.click(
      items[1]!.querySelector(
        '[data-testid="codex-structure-folded-dismissed-restore"]',
      )!,
    );
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onRestore).toHaveBeenCalledWith(["alice"]);
    expect(items[1]!.textContent).toContain("戻しました");
    expect(
      items[1]!.querySelector(
        '[data-testid="codex-structure-folded-dismissed-restore"]',
      ),
    ).toBeNull();
    // もう片方はまだ戻せる。
    expect(
      items[0]!.querySelector(
        '[data-testid="codex-structure-folded-dismissed-restore"]',
      ),
    ).not.toBeNull();
  });

  it("「すべて戻す」は未戻しの key だけを全部渡し、その後は出なくなる", async () => {
    const user = userEvent.setup();
    const onRestore = vi.fn();
    render(
      <CodexStructureFoldedDismissals
        surfaces={[surface("ミナト"), surface("ライカ"), surface("ベルカ")]}
        onRestore={onRestore}
      />,
    );
    await user.click(
      screen.getAllByTestId("codex-structure-folded-dismissed-restore")[0]!,
    );
    expect(onRestore).toHaveBeenLastCalledWith(["ミナト"]);
    await user.click(
      screen.getByTestId("codex-structure-folded-dismissed-restore-all"),
    );
    expect(onRestore).toHaveBeenCalledTimes(2);
    expect(onRestore).toHaveBeenLastCalledWith(["ライカ", "ベルカ"]);
    expect(
      screen.queryByTestId("codex-structure-folded-dismissed-restore-all"),
    ).toBeNull();
    expect(
      screen.queryAllByTestId("codex-structure-folded-dismissed-restore"),
    ).toHaveLength(0);
  });

  it("1 種だけのときは「すべて戻す」を出さない", () => {
    render(
      <CodexStructureFoldedDismissals
        surfaces={[surface("ミナト")]}
        onRestore={vi.fn()}
      />,
    );
    expect(
      screen.queryByTestId("codex-structure-folded-dismissed-restore-all"),
    ).toBeNull();
  });

  it("同じ key は 1 種にまとめる（出現ごとの重複を数えない）", async () => {
    const user = userEvent.setup();
    const onRestore = vi.fn();
    render(
      <CodexStructureFoldedDismissals
        surfaces={[
          surface("Alice", "alice"),
          surface("ALICE", "alice"),
          surface("ミナト"),
        ]}
        onRestore={onRestore}
      />,
    );
    expect(
      screen.getAllByTestId("codex-structure-folded-dismissed-item"),
    ).toHaveLength(2);
    expect(
      screen.getByTestId("codex-structure-folded-dismissed").textContent,
    ).toContain("2 種");
    await user.click(
      screen.getByTestId("codex-structure-folded-dismissed-restore-all"),
    );
    expect(onRestore).toHaveBeenCalledWith(["alice", "ミナト"]);
  });

  it("11 種以上は先頭 10 種だけを出し、「ほか」で残りの数を示す", () => {
    render(
      <CodexStructureFoldedDismissals
        surfaces={Array.from({ length: 12 }, (_, i) => surface(`呼び${i}`))}
        onRestore={vi.fn()}
      />,
    );
    expect(
      screen.getAllByTestId("codex-structure-folded-dismissed-item"),
    ).toHaveLength(10);
    const text = screen.getByTestId(
      "codex-structure-folded-dismissed",
    ).textContent;
    expect(text).toContain("12 種");
    expect(text).toContain("ほか 2 種");
    expect(text).not.toContain("呼び10");
  });

  it("11 種以上でも「すべて戻す」は表示外の種も含めた全部の key を渡す", async () => {
    const user = userEvent.setup();
    const onRestore = vi.fn();
    render(
      <CodexStructureFoldedDismissals
        surfaces={Array.from({ length: 12 }, (_, i) => surface(`呼び${i}`))}
        onRestore={onRestore}
      />,
    );
    await user.click(
      screen.getByTestId("codex-structure-folded-dismissed-restore-all"),
    );
    expect(onRestore.mock.calls[0]![0]).toHaveLength(12);
  });

  it("onRestore が無ければ戻すボタンを出さない（一覧は出す）", () => {
    render(
      <CodexStructureFoldedDismissals
        surfaces={[surface("ミナト"), surface("ライカ")]}
      />,
    );
    expect(
      screen.getAllByTestId("codex-structure-folded-dismissed-item"),
    ).toHaveLength(2);
    expect(
      screen.queryByTestId("codex-structure-folded-dismissed-restore"),
    ).toBeNull();
    expect(
      screen.queryByTestId("codex-structure-folded-dismissed-restore-all"),
    ).toBeNull();
  });
});
