import { describe, it, expect, beforeEach } from "vitest";

import {
  announce,
  getAnnouncerState,
  subscribeAnnouncer,
  __resetAnnouncerForTest,
} from "./announcer";

const ZWSP = String.fromCharCode(0x200b);

describe("announcer", () => {
  beforeEach(() => __resetAnnouncerForTest());

  it("stores polite messages and notifies subscribers", () => {
    let calls = 0;
    const unsub = subscribeAnnouncer(() => {
      calls++;
    });
    announce("保存しました");
    expect(getAnnouncerState().polite).toContain("保存しました");
    expect(calls).toBe(1);
    unsub();
  });

  it("toggles a zero-width space so repeated identical messages still change", () => {
    announce("保存しました");
    const first = getAnnouncerState().polite;
    announce("保存しました");
    const second = getAnnouncerState().polite;
    expect(first).not.toBe(second);
    // ZWSP を除けば同一文言 (SR には同じに聞こえる)
    const strip = (s: string) => s.split(ZWSP).join("");
    expect(strip(first)).toBe("保存しました");
    expect(strip(second)).toBe("保存しました");
  });

  it("routes assertive messages separately from polite", () => {
    announce("エラーが発生しました", "assertive");
    expect(getAnnouncerState().assertive).toContain("エラーが発生しました");
    expect(getAnnouncerState().polite).toBe("");
  });

  it("ignores empty / whitespace-only messages", () => {
    announce("   ");
    expect(getAnnouncerState().polite).toBe("");
  });
});
