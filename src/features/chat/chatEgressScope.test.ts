import { describe, expect, it } from "vitest";
import {
  chatEgressClosureOf,
  type ChatEgressScopeState,
} from "./chatEgressClosure";
import { phoneChatEgressClosure } from "@/features/layout/adaptive/MobileWorkspaceSurfaces";

// DA-2b の PUB-G 前の必須 4（DR-DA2B-R24）：chat の送信の閉鎖は 3 状態。
// (a) 会話のある場面の会話：AI だけ閉じ、送信は開く（capture が入力を保存する）。
// (b) 会話の無い場面の会話：送信も閉じる（最初の送信は会話の作成で拒否される）。
// (c) 場面の会話でない：送信を閉じる（capture の外）。
// 場面の会話の述語は PR-A の `isSceneConversation`（capture の会話の条件）と同じ。

const scene: ChatEgressScopeState = {
  chatScope: "scene",
  activeSceneId: "scene-1",
  scopeAnchorId: null,
  threadFocusOverride: null,
  activeSessionId: "s1",
};

const CASES: ReadonlyArray<
  readonly [string, Partial<ChatEgressScopeState>, string]
> = [
  ["会話のある場面の会話", {}, "ai"],
  ["会話の無い場面の会話", { activeSessionId: null }, "newConversation"],
  ["project の会話", { chatScope: "project" }, "nonScene"],
  [
    "会話の無い project の scope",
    { chatScope: "project", activeSessionId: null },
    "nonScene",
  ],
  ["folder の会話", { chatScope: "folder" }, "nonScene"],
  ["codex の会話", { chatScope: "codex", scopeAnchorId: "c1" }, "nonScene"],
  ["場面が開いていない", { activeSceneId: "" }, "nonScene"],
  [
    "場面が開いておらず会話も無い",
    { activeSceneId: "", activeSessionId: null },
    "nonScene",
  ],
  [
    "thread の focus 中",
    { threadFocusOverride: { threadId: "t1" } },
    "nonScene",
  ],
  ["場面の scope で anchor あり", { scopeAnchorId: "a1" }, "nonScene"],
];

describe("chatEgressClosureOf", () => {
  it.each(CASES)("閉：%s → %s", (_label, patch, expected) => {
    expect(chatEgressClosureOf(true, { ...scene, ...patch })).toBe(expected);
  });

  it.each(CASES)("開：%s → open", (_label, patch) => {
    expect(chatEgressClosureOf(false, { ...scene, ...patch })).toBe("open");
  });
});

describe("Mobile の chat の判定は chat panel と同じ", () => {
  it.each(CASES)("%s", (_label, patch) => {
    for (const closed of [true, false]) {
      const state = { ...scene, ...patch };
      expect(phoneChatEgressClosure(closed, state)).toBe(
        chatEgressClosureOf(closed, state),
      );
    }
  });
});
