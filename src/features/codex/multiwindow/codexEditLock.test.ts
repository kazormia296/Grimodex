import { describe, it, expect } from "vitest";
import { reduceLock, canEdit, holderOf } from "./codexEditLock";

const TTL = 5000;

describe("codexEditLock reducer", () => {
  it("最初の acquire が holder になり、他窓は編集不可・自窓は編集可", () => {
    const s = reduceLock(
      {},
      { type: "acquire", entryId: "e1", windowId: "A", ts: 1000 },
      TTL,
    );
    expect(holderOf(s, "e1", 1000, TTL)).toBe("A");
    expect(canEdit(s, "e1", "B", 1000, TTL)).toBe(false);
    expect(canEdit(s, "e1", "A", 1000, TTL)).toBe(true);
  });

  it("holder 不在の entry は誰でも編集可", () => {
    expect(canEdit({}, "e9", "Z", 1000, TTL)).toBe(true);
    expect(holderOf({}, "e9", 1000, TTL)).toBeNull();
  });

  it("先勝ち：有効な holder がいる間は 2 番目の acquire が奪えない", () => {
    let s = reduceLock(
      {},
      { type: "acquire", entryId: "e1", windowId: "A", ts: 1000 },
      TTL,
    );
    s = reduceLock(
      s,
      { type: "acquire", entryId: "e1", windowId: "B", ts: 1001 },
      TTL,
    );
    expect(holderOf(s, "e1", 1001, TTL)).toBe("A");
  });

  it("同時 acquire（同 ts）は windowId 辞書順で決定的に決まる（両窓が同じ結論に収束）", () => {
    // 到着順が違っても同じ holder に収束しなければならない。
    let s1 = reduceLock(
      {},
      { type: "acquire", entryId: "e1", windowId: "B", ts: 1000 },
      TTL,
    );
    s1 = reduceLock(
      s1,
      { type: "acquire", entryId: "e1", windowId: "A", ts: 1000 },
      TTL,
    );

    let s2 = reduceLock(
      {},
      { type: "acquire", entryId: "e1", windowId: "A", ts: 1000 },
      TTL,
    );
    s2 = reduceLock(
      s2,
      { type: "acquire", entryId: "e1", windowId: "B", ts: 1000 },
      TTL,
    );

    expect(holderOf(s1, "e1", 1000, TTL)).toBe("A"); // 辞書順 A < B
    expect(holderOf(s2, "e1", 1000, TTL)).toBe("A");
  });

  it("TTL 切れの holder は別窓が奪える（クラッシュ/閉じ忘れ復帰）", () => {
    let s = reduceLock(
      {},
      { type: "acquire", entryId: "e1", windowId: "A", ts: 1000 },
      TTL,
    );
    const later = 1000 + TTL + 1;
    s = reduceLock(
      s,
      { type: "acquire", entryId: "e1", windowId: "B", ts: later },
      TTL,
    );
    expect(holderOf(s, "e1", later, TTL)).toBe("B");
  });

  it("heartbeat は同 holder の有効期限を延長する", () => {
    let s = reduceLock(
      {},
      { type: "acquire", entryId: "e1", windowId: "A", ts: 1000 },
      TTL,
    );
    // TTL 直前に heartbeat → 期限延長
    s = reduceLock(
      s,
      { type: "heartbeat", entryId: "e1", windowId: "A", ts: 1000 + TTL - 1 },
      TTL,
    );
    // 元の ts からは TTL 超だが、heartbeat 後なので holder 継続
    expect(holderOf(s, "e1", 1000 + TTL + 1, TTL)).toBe("A");
  });

  it("他窓の heartbeat は holder を奪わない", () => {
    let s = reduceLock(
      {},
      { type: "acquire", entryId: "e1", windowId: "A", ts: 1000 },
      TTL,
    );
    s = reduceLock(
      s,
      { type: "heartbeat", entryId: "e1", windowId: "B", ts: 1100 },
      TTL,
    );
    expect(holderOf(s, "e1", 1100, TTL)).toBe("A");
  });

  it("release は同 holder のみ解除（他窓の release は無視）", () => {
    let s = reduceLock(
      {},
      { type: "acquire", entryId: "e1", windowId: "A", ts: 1000 },
      TTL,
    );
    s = reduceLock(
      s,
      { type: "release", entryId: "e1", windowId: "B", ts: 1001 },
      TTL,
    );
    expect(holderOf(s, "e1", 1001, TTL)).toBe("A");
    s = reduceLock(
      s,
      { type: "release", entryId: "e1", windowId: "A", ts: 1002 },
      TTL,
    );
    expect(holderOf(s, "e1", 1002, TTL)).toBeNull();
    expect(canEdit(s, "e1", "B", 1002, TTL)).toBe(true);
  });

  it("複数 entry のロックは独立に管理される", () => {
    let s = reduceLock(
      {},
      { type: "acquire", entryId: "e1", windowId: "A", ts: 1000 },
      TTL,
    );
    s = reduceLock(
      s,
      { type: "acquire", entryId: "e2", windowId: "B", ts: 1000 },
      TTL,
    );
    expect(holderOf(s, "e1", 1000, TTL)).toBe("A");
    expect(holderOf(s, "e2", 1000, TTL)).toBe("B");
  });

  it("reduceLock は入力 state を破壊しない（純粋）", () => {
    const s0 = {};
    const s1 = reduceLock(
      s0,
      { type: "acquire", entryId: "e1", windowId: "A", ts: 1000 },
      TTL,
    );
    expect(s0).toEqual({});
    expect(s1).not.toBe(s0);
  });
});
