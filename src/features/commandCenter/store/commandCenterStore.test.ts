import { beforeEach, describe, expect, it, vi } from "vitest";
import { selectPopoverOpen, useCommandCenterStore } from "./commandCenterStore";
import type {
  CommandCenterItem,
  CommandCenterSection,
} from "../providers/types";

function item(id: string, onSelect = () => {}): CommandCenterItem {
  return { id, kind: "lexical-scene", title: id, onSelect };
}

function lexicalSection(items: CommandCenterItem[]): CommandCenterSection {
  return { id: "lexical", title: "Lexical", order: 1, items };
}

function semanticSection(items: CommandCenterItem[]): CommandCenterSection {
  return { id: "semantic", title: "Semantic", order: 2, items };
}

describe("useCommandCenterStore", () => {
  beforeEach(() => {
    useCommandCenterStore.setState({
      open: false,
      mode: "search",
      query: "",
      parsedQuery: "",
      sections: [],
      selectedIndex: 0,
      focusRequest: 0,
    });
  });

  it("setOpen / setQuery / setMode / setParsedQuery を更新する", () => {
    const s = useCommandCenterStore.getState();
    s.setOpen(true);
    s.setQuery(">cmd");
    s.setMode("command");
    s.setParsedQuery("cmd");
    const next = useCommandCenterStore.getState();
    expect(next.open).toBe(true);
    expect(next.query).toBe(">cmd");
    expect(next.mode).toBe("command");
    expect(next.parsedQuery).toBe("cmd");
  });

  it("upsertSection: 同じ id の section を置換し order でソートする", () => {
    const { upsertSection } = useCommandCenterStore.getState();
    upsertSection(semanticSection([item("s1")]), true);
    upsertSection(lexicalSection([item("l1")]), true);
    const sections = useCommandCenterStore.getState().sections;
    expect(sections.map((s) => s.id)).toEqual(["lexical", "semantic"]);
  });

  it("upsertSection: hideWhenEmpty=true で空 section は除外される", () => {
    const { upsertSection } = useCommandCenterStore.getState();
    upsertSection(lexicalSection([item("l1")]), true);
    upsertSection(lexicalSection([]), true);
    expect(useCommandCenterStore.getState().sections).toEqual([]);
  });

  it("upsertSection: hideWhenEmpty=false なら 0 件でも残す", () => {
    const { upsertSection } = useCommandCenterStore.getState();
    upsertSection(lexicalSection([]), false);
    const sections = useCommandCenterStore.getState().sections;
    expect(sections).toHaveLength(1);
    expect(sections[0].items).toEqual([]);
  });

  it("upsertSection: hideWhenEmpty=true でも loading/error の section は残す", () => {
    const { upsertSection } = useCommandCenterStore.getState();
    upsertSection(
      {
        id: "lexical",
        title: "L",
        order: 1,
        items: [],
        state: { kind: "loading" },
      },
      true,
    );
    expect(useCommandCenterStore.getState().sections).toHaveLength(1);
    upsertSection(
      {
        id: "lexical",
        title: "L",
        order: 1,
        items: [],
        state: { kind: "error", message: "boom" },
      },
      true,
    );
    expect(useCommandCenterStore.getState().sections).toHaveLength(1);
  });

  it("upsertSection: 既存 selectedIndex は flat 長を超えたら clamp する", () => {
    const { upsertSection } = useCommandCenterStore.getState();
    upsertSection(lexicalSection([item("a"), item("b"), item("c")]), true);
    useCommandCenterStore.setState({ selectedIndex: 2 });
    upsertSection(lexicalSection([item("a")]), true);
    expect(useCommandCenterStore.getState().selectedIndex).toBe(0);
  });

  it("moveSelection: ↓ で次の item に、↑ で前に戻る (clamp あり)", () => {
    const { upsertSection, moveSelection } = useCommandCenterStore.getState();
    upsertSection(lexicalSection([item("a"), item("b")]), true);
    upsertSection(semanticSection([item("c")]), true);
    expect(useCommandCenterStore.getState().selectedIndex).toBe(0);
    moveSelection("down");
    expect(useCommandCenterStore.getState().selectedIndex).toBe(1);
    moveSelection("down");
    expect(useCommandCenterStore.getState().selectedIndex).toBe(2);
    moveSelection("down");
    expect(useCommandCenterStore.getState().selectedIndex).toBe(2);
    moveSelection("up");
    expect(useCommandCenterStore.getState().selectedIndex).toBe(1);
  });

  it("moveSelection: items が 0 件のとき index は変化しない", () => {
    useCommandCenterStore.setState({ selectedIndex: 0 });
    useCommandCenterStore.getState().moveSelection("down");
    expect(useCommandCenterStore.getState().selectedIndex).toBe(0);
  });

  it("moveSelection: store に 50 件入っていても selectedIndex は BAR_VISIBLE_LIMIT_PER_SECTION 上限で止まる", () => {
    // パネル展開で store には 50 件入る想定。バー側は per-section 10 件しか表示しない。
    const many = Array.from({ length: 50 }, (_, i) => item(`x${i}`));
    useCommandCenterStore.getState().upsertSection(lexicalSection(many), true);
    useCommandCenterStore.setState({ selectedIndex: 0 });
    // ↓ を 12 回押しても 9 (= 10 - 1) で止まる (1 section × 10 visible items)
    for (let i = 0; i < 12; i++) {
      useCommandCenterStore.getState().moveSelection("down");
    }
    expect(useCommandCenterStore.getState().selectedIndex).toBe(9);
  });

  it("moveSelection: 2 sections × 50 items でも selectedIndex は 0..19 に収まる", () => {
    const lexicalMany = Array.from({ length: 50 }, (_, i) =>
      item(`l${i}`, () => {}),
    );
    const semanticMany = Array.from({ length: 50 }, (_, i) =>
      item(`s${i}`, () => {}),
    );
    const { upsertSection, moveSelection } = useCommandCenterStore.getState();
    upsertSection(lexicalSection(lexicalMany), true);
    upsertSection(semanticSection(semanticMany), true);
    useCommandCenterStore.setState({ selectedIndex: 0 });
    for (let i = 0; i < 100; i++) moveSelection("down");
    expect(useCommandCenterStore.getState().selectedIndex).toBe(19);
  });

  it("executeSelected: bar-visible 範囲の item.onSelect を呼ぶ (10 件超えのインデックスは clamp)", () => {
    const onSelectVisible = vi.fn();
    const items = Array.from({ length: 50 }, (_, i) =>
      item(`x${i}`, i === 9 ? onSelectVisible : () => {}),
    );
    useCommandCenterStore.getState().upsertSection(lexicalSection(items), true);
    // 9 (= bar-visible 末尾) を選択 → onSelectVisible が呼ばれる
    useCommandCenterStore.setState({ selectedIndex: 9 });
    useCommandCenterStore.getState().executeSelected();
    expect(onSelectVisible).toHaveBeenCalled();
  });

  it("executeSelected: 選択中 item の onSelect を呼ぶ", () => {
    const onSelect = vi.fn();
    useCommandCenterStore
      .getState()
      .upsertSection(lexicalSection([item("a"), item("b", onSelect)]), true);
    useCommandCenterStore.setState({ selectedIndex: 1 });
    useCommandCenterStore.getState().executeSelected();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("executeSelected: 該当 item がなければ何もしない", () => {
    expect(() =>
      useCommandCenterStore.getState().executeSelected(),
    ).not.toThrow();
  });

  it("requestFocus: counter が増える", () => {
    const before = useCommandCenterStore.getState().focusRequest;
    useCommandCenterStore.getState().requestFocus();
    expect(useCommandCenterStore.getState().focusRequest).toBe(before + 1);
  });

  it("reset: query/sections/selectedIndex をクリアし open/mode は残す", () => {
    useCommandCenterStore.setState({
      open: true,
      mode: "command",
      query: "x",
      parsedQuery: "x",
      sections: [lexicalSection([item("a")])],
      selectedIndex: 0,
    });
    useCommandCenterStore.getState().reset();
    const s = useCommandCenterStore.getState();
    expect(s.open).toBe(true);
    expect(s.mode).toBe("command");
    expect(s.query).toBe("");
    expect(s.parsedQuery).toBe("");
    expect(s.sections).toEqual([]);
    expect(s.selectedIndex).toBe(0);
  });

  it("selectPopoverOpen: open=true でも parsedQuery 空なら false", () => {
    expect(selectPopoverOpen({ open: true, parsedQuery: "" })).toBe(false);
    expect(selectPopoverOpen({ open: true, parsedQuery: "   " })).toBe(false);
    expect(selectPopoverOpen({ open: true, parsedQuery: "x" })).toBe(true);
    expect(selectPopoverOpen({ open: false, parsedQuery: "x" })).toBe(false);
  });
});
