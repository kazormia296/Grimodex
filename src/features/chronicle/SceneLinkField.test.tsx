// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { SceneLinkField, filterLinkableScenes } from "./SceneLinkField";

const SCENES = [
  { id: "s1", title: "旅立ち" },
  { id: "s2", title: "森の対決" },
  { id: "s3", title: "" }, // 無題
  { id: "s4", title: "王都 Forest" },
];

describe("filterLinkableScenes", () => {
  it("既にリンク済みのシーンは候補から除外する", () => {
    expect(
      filterLinkableScenes(SCENES, ["s1", "s3"], "").map((s) => s.id),
    ).toEqual(["s2", "s4"]);
  });

  it("空クエリは未リンク全件を読み順のまま返す", () => {
    expect(filterLinkableScenes(SCENES, [], "").map((s) => s.id)).toEqual([
      "s1",
      "s2",
      "s3",
      "s4",
    ]);
  });

  it("タイトル部分一致で絞る", () => {
    expect(filterLinkableScenes(SCENES, [], "森").map((s) => s.id)).toEqual([
      "s2",
    ]);
  });

  it("英字は大文字小文字を無視して一致", () => {
    expect(filterLinkableScenes(SCENES, [], "forest").map((s) => s.id)).toEqual(
      ["s4"],
    );
  });

  it("前後空白を無視する", () => {
    expect(
      filterLinkableScenes(SCENES, [], "  王都  ").map((s) => s.id),
    ).toEqual(["s4"]);
  });
});

// 日時ありシーンを含む候補（優先ダイアログの発火確認用）。
const DATED = [
  { id: "d1", title: "日時あり", hasDate: true },
  { id: "d2", title: "日時なし" },
];

function setup(
  linkedSceneIds: string[] = [],
  scenes: { id: string; title: string; hasDate?: boolean }[] = SCENES,
) {
  const onLink = vi.fn();
  const onUnlink = vi.fn();
  const utils = render(
    <SceneLinkField
      scenes={scenes}
      linkedSceneIds={linkedSceneIds}
      onLink={onLink}
      onUnlink={onUnlink}
    />,
  );
  const candidate = (id: string) =>
    utils
      .getAllByTestId("link-scene-candidate")
      .find((b) => b.getAttribute("data-scene-id") === id) as HTMLElement;
  return { ...utils, onLink, onUnlink, candidate };
}

describe("SceneLinkField", () => {
  it("リンクが無ければ空状態を出す", () => {
    const { getByTestId, queryAllByTestId } = setup([]);
    expect(getByTestId("no-linked-scenes")).toBeTruthy();
    expect(queryAllByTestId("linked-scene").length).toBe(0);
  });

  it("リンク済みシーンをタイトル付きで並べる", () => {
    const { getAllByTestId } = setup(["s1", "s2"]);
    const chips = getAllByTestId("linked-scene");
    expect(chips.length).toBe(2);
    expect(chips[0].textContent).toContain("旅立ち");
    expect(chips[1].textContent).toContain("森の対決");
  });

  it("× で onUnlink(sceneId) を呼ぶ", () => {
    const { getAllByTestId, onUnlink } = setup(["s1"]);
    fireEvent.click(getAllByTestId("unlink-scene")[0]);
    expect(onUnlink).toHaveBeenCalledWith("s1");
  });

  it("追加トグルで検索パネルを開き、リンク済みは候補から除外する", () => {
    const { getByTestId, getAllByTestId, queryByTestId } = setup(["s1"]);
    expect(queryByTestId("link-scene-search")).toBeNull(); // 既定は閉じている
    fireEvent.click(getByTestId("link-scene-toggle"));
    expect(getByTestId("link-scene-search")).toBeTruthy();
    const ids = getAllByTestId("link-scene-candidate").map((el) =>
      el.getAttribute("data-scene-id"),
    );
    expect(ids).toEqual(["s2", "s3", "s4"]); // s1 は除外
  });

  it("検索入力で候補を絞り、候補クリックで onLink(sceneId) を呼ぶ", () => {
    const { getByTestId, getAllByTestId, onLink } = setup([]);
    fireEvent.click(getByTestId("link-scene-toggle"));
    fireEvent.change(getByTestId("link-scene-search"), {
      target: { value: "森" },
    });
    const candidates = getAllByTestId("link-scene-candidate");
    expect(candidates.length).toBe(1);
    expect(candidates[0].getAttribute("data-scene-id")).toBe("s2");
    fireEvent.click(candidates[0]);
    // 日時なしシーンは既定=イベント優先で即リンク（ダイアログ無し）。
    expect(onLink).toHaveBeenCalledWith("s2", "event");
  });

  it("日時なしシーンはダイアログ無しで即 onLink(id, 'event')", () => {
    const { getByTestId, queryByTestId, candidate, onLink } = setup([], DATED);
    fireEvent.click(getByTestId("link-scene-toggle"));
    fireEvent.click(candidate("d2"));
    expect(onLink).toHaveBeenCalledWith("d2", "event");
    expect(queryByTestId("link-mode-dialog")).toBeNull();
  });

  it("日時ありシーンをクリックすると確認ダイアログを開き、まだ onLink しない", () => {
    const { getByTestId, candidate, onLink } = setup([], DATED);
    fireEvent.click(getByTestId("link-scene-toggle"));
    fireEvent.click(candidate("d1"));
    expect(getByTestId("link-mode-dialog")).toBeTruthy();
    expect(onLink).not.toHaveBeenCalled();
  });

  it("ダイアログでイベント優先を選ぶと onLink(id, 'event')・閉じる", () => {
    const { getByTestId, queryByTestId, candidate, onLink } = setup([], DATED);
    fireEvent.click(getByTestId("link-scene-toggle"));
    fireEvent.click(candidate("d1"));
    fireEvent.click(getByTestId("link-mode-dialog-event"));
    expect(onLink).toHaveBeenCalledWith("d1", "event");
    expect(queryByTestId("link-mode-dialog")).toBeNull();
  });

  it("ダイアログでシーン優先を選ぶと onLink(id, 'scene')・閉じる", () => {
    const { getByTestId, queryByTestId, candidate, onLink } = setup([], DATED);
    fireEvent.click(getByTestId("link-scene-toggle"));
    fireEvent.click(candidate("d1"));
    fireEvent.click(getByTestId("link-mode-dialog-scene"));
    expect(onLink).toHaveBeenCalledWith("d1", "scene");
    expect(queryByTestId("link-mode-dialog")).toBeNull();
  });

  it("ダイアログでキャンセルすると onLink せず閉じる", () => {
    const { getByTestId, queryByTestId, candidate, onLink } = setup([], DATED);
    fireEvent.click(getByTestId("link-scene-toggle"));
    fireEvent.click(candidate("d1"));
    fireEvent.click(getByTestId("link-mode-dialog-cancel"));
    expect(onLink).not.toHaveBeenCalled();
    expect(queryByTestId("link-mode-dialog")).toBeNull();
  });

  it("候補が無ければ該当なし表示", () => {
    const { getByTestId } = setup([]);
    fireEvent.click(getByTestId("link-scene-toggle"));
    fireEvent.change(getByTestId("link-scene-search"), {
      target: { value: "存在しない題名" },
    });
    expect(getByTestId("no-matching-scenes")).toBeTruthy();
  });
});
