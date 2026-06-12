// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildImeLogEntry,
  clearImeLog,
  disableImeLog,
  dumpImeLog,
  enableImeLog,
  formatImeLogEntry,
  isImeLogEnabled,
  recordImeEvent,
  roundRect,
  type ImeEventSnapshot,
} from "./imeLog";

function makeSnapshot(
  overrides: Partial<ImeEventSnapshot> = {},
): ImeEventSnapshot {
  return {
    type: "compositionupdate",
    at: 1234.567,
    data: "あいう",
    selectionFrom: 5,
    selectionTo: 5,
    pmComposing: true,
    vertical: true,
    domSelectionRect: {
      left: 100.04,
      top: 200.06,
      right: 107.04,
      bottom: 312.06,
    },
    domSelectionRects: [
      { left: 100.04, top: 200.06, right: 107.04, bottom: 312.06 },
    ],
    appCaretRect: { left: 100, top: 312, right: 107, bottom: 312 },
    pmCaretRect: { left: 107, top: 200, right: 107, bottom: 201 },
    logicalScrollOffset: 480.25,
    rawScrollLeft: -480.25,
    rawScrollTop: 0,
    containerRect: { left: 0, top: 40, right: 800, bottom: 640 },
    devicePixelRatio: 1.5,
    screenX: 10,
    screenY: 20,
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
  clearImeLog();
});

afterEach(() => {
  disableImeLog();
  clearImeLog();
  localStorage.removeItem("grimodex.imeLog");
  vi.restoreAllMocks();
});

describe("roundRect", () => {
  it("rounds to 0.1px and derives width/height from raw edges", () => {
    const r = roundRect({ left: 1.04, top: 2.06, right: 8.11, bottom: 2.06 });
    expect(r).toEqual({
      left: 1,
      top: 2.1,
      right: 8.1,
      bottom: 2.1,
      width: 7.1,
      height: 0,
    });
  });
});

describe("buildImeLogEntry", () => {
  it("rounds rects and preserves null rects (取得不能も診断情報)", () => {
    const entry = buildImeLogEntry(
      makeSnapshot({
        domSelectionRect: null,
        domSelectionRects: [],
        pmCaretRect: null,
        logicalScrollOffset: null,
        rawScrollLeft: null,
        rawScrollTop: null,
        containerRect: null,
      }),
    );
    expect(entry.domSelectionRect).toBeNull();
    expect(entry.domSelectionRects).toEqual([]);
    expect(entry.pmCaretRect).toBeNull();
    expect(entry.logicalScrollOffset).toBeNull();
    expect(entry.appCaretRect).toEqual({
      left: 100,
      top: 312,
      right: 107,
      bottom: 312,
      width: 7,
      height: 0,
    });
    expect(entry.at).toBe(1235);
  });

  it("truncates composition data to 32 chars (本文混入を抑える)", () => {
    const long = "縦".repeat(40);
    const entry = buildImeLogEntry(makeSnapshot({ data: long }));
    expect(entry.data).toBe(`${"縦".repeat(32)}…`);
    expect(buildImeLogEntry(makeSnapshot({ data: null })).data).toBeNull();
    expect(buildImeLogEntry(makeSnapshot({ data: "短い" })).data).toBe("短い");
  });
});

describe("formatImeLogEntry", () => {
  it("renders a single greppable line with all rects", () => {
    const line = formatImeLogEntry(buildImeLogEntry(makeSnapshot()));
    expect(line).toContain("compositionupdate vertical");
    expect(line).toContain('data="あいう"');
    expect(line).toContain("sel=5..5");
    expect(line).toContain("dom=(100,200.1 7×112)");
    expect(line).toContain("dpr=1.5");
  });

  it("marks missing rects with ∅", () => {
    const line = formatImeLogEntry(
      buildImeLogEntry(
        makeSnapshot({ domSelectionRect: null, logicalScrollOffset: null }),
      ),
    );
    expect(line).toContain("dom=∅");
    expect(line).toContain("scroll=∅");
  });
});

describe("recordImeEvent gating + ring buffer", () => {
  it("drops entries while disabled", () => {
    expect(isImeLogEnabled()).toBe(false);
    expect(recordImeEvent(buildImeLogEntry(makeSnapshot()))).toBeNull();
    expect(dumpImeLog()).toEqual([]);
  });

  it("records with monotonic seq while enabled", () => {
    enableImeLog();
    const a = recordImeEvent(buildImeLogEntry(makeSnapshot()));
    const b = recordImeEvent(buildImeLogEntry(makeSnapshot()));
    expect(a?.seq).toBe(1);
    expect(b?.seq).toBe(2);
    expect(dumpImeLog()).toHaveLength(2);
  });

  it("caps the buffer at 300 entries (FIFO)", () => {
    enableImeLog();
    for (let i = 0; i < 305; i++) {
      recordImeEvent(buildImeLogEntry(makeSnapshot()));
    }
    const all = dumpImeLog();
    expect(all).toHaveLength(300);
    expect(all[0]?.seq).toBe(6);
    expect(all[299]?.seq).toBe(305);
  });

  it("keeps entries after disable (QA 後の回収用) until cleared", () => {
    enableImeLog();
    recordImeEvent(buildImeLogEntry(makeSnapshot()));
    disableImeLog();
    expect(dumpImeLog()).toHaveLength(1);
    clearImeLog();
    expect(dumpImeLog()).toEqual([]);
  });
});
