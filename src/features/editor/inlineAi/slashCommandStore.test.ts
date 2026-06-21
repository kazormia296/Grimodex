// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useSlashCommandStore } from "./slashCommandStore";
import type { InlineAiCommand } from "./inlineAiTypes";

const cmd = (id: string): InlineAiCommand => ({
  id,
  label: id,
  description: id,
  mode: "insert",
  needsSelection: false,
});

const rect = { top: 10, left: 20, bottom: 30 };

describe("useSlashCommandStore", () => {
  beforeEach(() => {
    useSlashCommandStore.getState().close();
  });

  it("starts closed and empty", () => {
    const s = useSlashCommandStore.getState();
    expect(s.isOpen).toBe(false);
    expect(s.items).toEqual([]);
    expect(s.query).toBe("");
    expect(s.rect).toBeNull();
    expect(s.commandFn).toBeNull();
    expect(s.keyHandler).toBeNull();
  });

  it("open() sets isOpen, items, query, rect and commandFn", () => {
    const fn = vi.fn();
    useSlashCommandStore.getState().open({
      items: [cmd("continue")],
      query: "con",
      rect,
      commandFn: fn,
    });
    const s = useSlashCommandStore.getState();
    expect(s.isOpen).toBe(true);
    expect(s.items.map((i) => i.id)).toEqual(["continue"]);
    expect(s.query).toBe("con");
    expect(s.rect).toEqual(rect);
    expect(s.commandFn).toBe(fn);
  });

  it("update() refreshes items/query/rect but preserves commandFn and isOpen", () => {
    const fn = vi.fn();
    useSlashCommandStore
      .getState()
      .open({ items: [cmd("continue")], query: "con", rect, commandFn: fn });
    useSlashCommandStore.getState().update({
      items: [cmd("rewrite")],
      query: "rew",
      rect: null,
    });
    const s = useSlashCommandStore.getState();
    expect(s.isOpen).toBe(true);
    expect(s.items.map((i) => i.id)).toEqual(["rewrite"]);
    expect(s.query).toBe("rew");
    expect(s.rect).toBeNull();
    expect(s.commandFn).toBe(fn);
  });

  it("setKeyHandler() stores and clears the handler", () => {
    const handler = vi.fn(() => true);
    useSlashCommandStore.getState().setKeyHandler(handler);
    expect(useSlashCommandStore.getState().keyHandler).toBe(handler);
    useSlashCommandStore.getState().setKeyHandler(null);
    expect(useSlashCommandStore.getState().keyHandler).toBeNull();
  });

  it("close() resets every field", () => {
    useSlashCommandStore.getState().open({
      items: [cmd("continue")],
      query: "con",
      rect,
      commandFn: vi.fn(),
    });
    useSlashCommandStore.getState().setKeyHandler(vi.fn(() => false));
    useSlashCommandStore.getState().close();
    const s = useSlashCommandStore.getState();
    expect(s.isOpen).toBe(false);
    expect(s.items).toEqual([]);
    expect(s.query).toBe("");
    expect(s.rect).toBeNull();
    expect(s.commandFn).toBeNull();
    expect(s.keyHandler).toBeNull();
  });
});
