import type { KeyboardEvent } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCommandCenterStore } from "../store/commandCenterStore";
import type {
  CommandCenterItem,
  CommandCenterSection,
} from "../providers/types";
import { handleCommandCenterKeyDown } from "./useCommandCenterKeyboard";

function fakeEvent(key: string): KeyboardEvent<HTMLInputElement> & {
  preventDefault: ReturnType<typeof vi.fn>;
} {
  const preventDefault = vi.fn();
  return {
    key,
    preventDefault,
  } as unknown as KeyboardEvent<HTMLInputElement> & {
    preventDefault: ReturnType<typeof vi.fn>;
  };
}

function item(id: string, onSelect = vi.fn()): CommandCenterItem {
  return { id, kind: "lexical-scene", title: id, onSelect };
}

function lexicalSection(items: CommandCenterItem[]): CommandCenterSection {
  return { id: "lexical", title: "Lexical", order: 1, items };
}

function setStore(
  partial: Partial<ReturnType<typeof useCommandCenterStore.getState>>,
) {
  useCommandCenterStore.setState({
    open: false,
    mode: "search",
    query: "",
    parsedQuery: "",
    sections: [],
    selectedIndex: 0,
    focusRequest: 0,
    ...partial,
  });
}

describe("handleCommandCenterKeyDown", () => {
  beforeEach(() => {
    setStore({});
  });

  it("Escape: popover 開状態なら close + preventDefault", () => {
    setStore({ open: true, parsedQuery: "x" });
    const e = fakeEvent("Escape");
    handleCommandCenterKeyDown(e, useCommandCenterStore);
    expect(useCommandCenterStore.getState().open).toBe(false);
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("Escape: open=false のときは preventDefault しない", () => {
    setStore({ open: false });
    const e = fakeEvent("Escape");
    handleCommandCenterKeyDown(e, useCommandCenterStore);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("ArrowDown: popover 開いていれば selectedIndex を進めて preventDefault", () => {
    setStore({
      open: true,
      parsedQuery: "x",
      sections: [lexicalSection([item("a"), item("b")])],
      selectedIndex: 0,
    });
    const e = fakeEvent("ArrowDown");
    handleCommandCenterKeyDown(e, useCommandCenterStore);
    expect(useCommandCenterStore.getState().selectedIndex).toBe(1);
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("ArrowUp: popover 開いていれば selectedIndex を戻して preventDefault", () => {
    setStore({
      open: true,
      parsedQuery: "x",
      sections: [lexicalSection([item("a"), item("b")])],
      selectedIndex: 1,
    });
    const e = fakeEvent("ArrowUp");
    handleCommandCenterKeyDown(e, useCommandCenterStore);
    expect(useCommandCenterStore.getState().selectedIndex).toBe(0);
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("ArrowDown: popover 閉じていればキャレット移動 (preventDefault しない)", () => {
    setStore({ open: false, parsedQuery: "x" });
    const e = fakeEvent("ArrowDown");
    handleCommandCenterKeyDown(e, useCommandCenterStore);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("ArrowDown: open=true でも parsedQuery が空ならキャレット移動", () => {
    setStore({ open: true, parsedQuery: "" });
    const e = fakeEvent("ArrowDown");
    handleCommandCenterKeyDown(e, useCommandCenterStore);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("Enter: items あり時のみ executeSelected + preventDefault", () => {
    const onSelect = vi.fn();
    setStore({
      open: true,
      parsedQuery: "x",
      sections: [lexicalSection([item("a", onSelect)])],
      selectedIndex: 0,
    });
    const e = fakeEvent("Enter");
    handleCommandCenterKeyDown(e, useCommandCenterStore);
    expect(onSelect).toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("Enter: items 0 件なら preventDefault しない", () => {
    setStore({
      open: true,
      parsedQuery: "x",
      sections: [],
    });
    const e = fakeEvent("Enter");
    handleCommandCenterKeyDown(e, useCommandCenterStore);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("通常文字キー: 何もしない", () => {
    setStore({ open: true, parsedQuery: "x" });
    const e = fakeEvent("a");
    handleCommandCenterKeyDown(e, useCommandCenterStore);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});
