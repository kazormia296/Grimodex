import { describe, expect, it } from "vitest";
import {
  LIVE_READER_MAX_PENDING_CHARS,
  LIVE_READER_MIN_PENDING_CHARS,
  accumulateLiveReaderInsertion,
  buildLiveReaderContext,
  classifyLiveReaderChange,
  createLiveReaderAccumulator,
  shouldTriggerLiveReader,
  takeLiveReaderInsertion,
} from "./liveReaderTrigger";

describe("classifyLiveReaderChange", () => {
  it("純粋な追記だけを insertion として返す", () => {
    expect(classifyLiveReaderChange("本文", "本文を追加")).toEqual({
      kind: "insert",
      addedText: "を追加",
      removedText: "",
    });
  });

  it("削除・置換・同一本文の変更は live reader の追記にしない", () => {
    expect(classifyLiveReaderChange("本文を追加", "本文")).toMatchObject({
      kind: "delete",
    });
    expect(classifyLiveReaderChange("古い本文", "新しい本文")).toMatchObject({
      kind: "replace",
    });
    expect(
      classifyLiveReaderChange("本文", "本文", { docChanged: false }),
    ).toEqual({
      kind: "ignored",
      addedText: "",
      removedText: "",
    });
  });

  it("IME composition 中と programmatic transaction は無視する", () => {
    expect(
      classifyLiveReaderChange("本文", "本文追記", { isComposing: true }),
    ).toMatchObject({ kind: "ignored" });
    expect(
      classifyLiveReaderChange("本文", "本文追記", { isProgrammatic: true }),
    ).toMatchObject({ kind: "ignored" });
  });

  it("帰属保護用の programmatic な貼り付けはユーザー追記として受け付ける", () => {
    expect(
      classifyLiveReaderChange("本文", "本文追記", {
        isProgrammatic: true,
        isUserInitiatedPaste: true,
      }),
    ).toEqual({
      kind: "insert",
      addedText: "追記",
      removedText: "",
    });
  });
});

describe("live reader trigger accumulation", () => {
  it("閾値未満では発火せず、句読点を含む閾値到達で発火する", () => {
    let state = createLiveReaderAccumulator();
    state = accumulateLiveReaderInsertion(
      state,
      "あ".repeat(LIVE_READER_MIN_PENDING_CHARS - 1),
    );
    expect(shouldTriggerLiveReader(state)).toBe(false);

    state = accumulateLiveReaderInsertion(state, "。続き");
    expect(shouldTriggerLiveReader(state)).toBe(true);
  });

  it("境界がなくても大きな追記では発火し、take 後に空へ戻る", () => {
    const state = accumulateLiveReaderInsertion(
      createLiveReaderAccumulator(),
      "a".repeat(LIVE_READER_MAX_PENDING_CHARS),
    );
    expect(shouldTriggerLiveReader(state)).toBe(true);
    expect(takeLiveReaderInsertion(state)).toEqual({
      text: "a".repeat(LIVE_READER_MAX_PENDING_CHARS),
      next: createLiveReaderAccumulator(),
    });
  });
});

describe("buildLiveReaderContext", () => {
  it("新しく追加された箇所を明示し、前後の近傍だけを返す", () => {
    const context = buildLiveReaderContext(
      "古い段落。" + "前置き。" + "新しい出来事が起きた。" + "後の段落。",
      "新しい出来事が起きた。",
      100,
    );

    expect(context).toContain("[RECENTLY_ADDED]");
    expect(context).toContain("新しい出来事が起きた。");
    expect(context).toContain("[/RECENTLY_ADDED]");
    expect(context.length).toBeLessThanOrEqual(100);
  });
});
