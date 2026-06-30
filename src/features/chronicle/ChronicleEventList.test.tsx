// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import {
  ChronicleEventList,
  type ChronicleEventListItem,
} from "./ChronicleEventList";

function item(o: Partial<ChronicleEventListItem> = {}): ChronicleEventListItem {
  return {
    id: "e1",
    title: "出来事A",
    kind: "generic",
    precision: "exact",
    secret: false,
    isInterval: false,
    primaryCodexId: "c1",
    laneName: "アヤ",
    dateLabel: "1年 春",
    startDay: 10,
    hasIssue: false,
    ...o,
  };
}

const laneOptions = [
  { id: "c1", name: "アヤ" },
  { id: "c2", name: "ボロ" },
];

function renderList(
  items: ChronicleEventListItem[],
  over: { selectedId?: string | null } = {},
) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const r = render(
    <ChronicleEventList
      items={items}
      selectedId={over.selectedId ?? null}
      laneOptions={laneOptions}
      onSelect={onSelect}
      onClose={onClose}
    />,
  );
  const ids = () =>
    [...r.container.querySelectorAll("[data-event-list-id]")].map((el) =>
      el.getAttribute("data-event-list-id"),
    );
  return { ...r, onSelect, onClose, ids };
}

describe("ChronicleEventList", () => {
  it("行を年表順（startDay 昇順・無時刻は末尾）で描く", () => {
    const { ids } = renderList([
      item({ id: "a", title: "A", startDay: 30 }),
      item({ id: "b", title: "B", startDay: null, dateLabel: null }),
      item({ id: "c", title: "C", startDay: 10 }),
    ]);
    expect(ids()).toEqual(["c", "a", "b"]);
  });

  it("検索でタイトル一致のみ残す", () => {
    const { getByTestId, ids } = renderList([
      item({ id: "a", title: "剣の修行" }),
      item({ id: "b", title: "城の陥落" }),
    ]);
    fireEvent.change(getByTestId("chronicle-event-list-search"), {
      target: { value: "剣" },
    });
    expect(ids()).toEqual(["a"]);
  });

  it("レーンで絞り込む", () => {
    const { getByLabelText, ids } = renderList([
      item({ id: "a", primaryCodexId: "c1", laneName: "アヤ" }),
      item({ id: "b", primaryCodexId: "c2", laneName: "ボロ" }),
    ]);
    fireEvent.change(getByLabelText("レーンで絞り込み"), {
      target: { value: "c2" },
    });
    expect(ids()).toEqual(["b"]);
  });

  it("未割当でレーン絞り込み", () => {
    const { getByLabelText, ids } = renderList([
      item({ id: "a", primaryCodexId: "c1" }),
      item({ id: "b", primaryCodexId: null, laneName: null }),
    ]);
    fireEvent.change(getByLabelText("レーンで絞り込み"), {
      target: { value: "__unassigned" },
    });
    expect(ids()).toEqual(["b"]);
  });

  it("種別で絞り込む", () => {
    const { getByLabelText, ids } = renderList([
      item({ id: "a", kind: "generic" }),
      item({ id: "b", kind: "birth" }),
      item({ id: "c", kind: "death" }),
    ]);
    fireEvent.change(getByLabelText("種別で絞り込み"), {
      target: { value: "birth" },
    });
    expect(ids()).toEqual(["b"]);
  });

  it("行クリックで onSelect(id)（=ナビゲーション）", () => {
    const { container, onSelect } = renderList([
      item({ id: "a", title: "A" }),
      item({ id: "b", title: "B" }),
    ]);
    (
      container.querySelector('[data-event-list-id="b"]') as HTMLElement
    ).click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("該当なしは空メッセージ", () => {
    const { getByTestId, getByText, ids } = renderList([
      item({ id: "a", title: "剣の修行" }),
    ]);
    fireEvent.change(getByTestId("chronicle-event-list-search"), {
      target: { value: "存在しない語" },
    });
    expect(ids()).toEqual([]);
    expect(getByText("該当する出来事がありません")).toBeTruthy();
  });

  it("選択行は data-selected で印付け", () => {
    const { container } = renderList([item({ id: "a" }), item({ id: "b" })], {
      selectedId: "b",
    });
    const b = container.querySelector(
      '[data-event-list-id="b"]',
    ) as HTMLElement;
    expect(b.getAttribute("data-selected")).toBe("true");
    const a = container.querySelector(
      '[data-event-list-id="a"]',
    ) as HTMLElement;
    expect(a.getAttribute("data-selected")).toBeNull();
  });

  it("閉じるボタンで onClose", () => {
    const { getByLabelText, onClose } = renderList([item()]);
    fireEvent.click(getByLabelText("閉じる"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
