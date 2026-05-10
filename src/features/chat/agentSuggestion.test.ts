import { describe, it, expect } from "vitest";
import {
  shouldSuggestAgentMode,
  looksLikeMissingInfo,
} from "./agentSuggestion";

describe("shouldSuggestAgentMode", () => {
  it("探索系キーワード入りの長文は提案する", () => {
    expect(
      shouldSuggestAgentMode({
        text: "この物語の登場人物の関係を整理して",
        hasMentions: false,
      }),
    ).toBe(true);
  });

  it("長文でもキーワードが無ければ提案しない (drafting 等)", () => {
    expect(
      shouldSuggestAgentMode({
        text: "シーン1を3000字で書いてください。トーンは柔らかめで、女性視点でお願いします。",
        hasMentions: false,
      }),
    ).toBe(false);
  });

  it("英語の探索クエリも拾う", () => {
    expect(
      shouldSuggestAgentMode({
        text: "Tell me everything about the protagonist's background.",
        hasMentions: false,
      }),
    ).toBe(true);
  });

  it("英語の縮約形 (what's / who's など) も拾う", () => {
    expect(
      shouldSuggestAgentMode({
        text: "What's the relationship between the two kingdoms?",
        hasMentions: false,
      }),
    ).toBe(true);
    expect(
      shouldSuggestAgentMode({
        text: "Who's the antagonist in this story arc?",
        hasMentions: false,
      }),
    ).toBe(true);
  });

  it("短い質問は誤爆を避けて提案しない", () => {
    expect(shouldSuggestAgentMode({ text: "誰?", hasMentions: false })).toBe(
      false,
    );
  });

  it("@メンションがあれば既に対象特定済みなので提案しない", () => {
    expect(
      shouldSuggestAgentMode({
        text: "この登場人物について詳しく教えて",
        hasMentions: true,
      }),
    ).toBe(false);
  });

  it("空文字は提案しない", () => {
    expect(shouldSuggestAgentMode({ text: "", hasMentions: false })).toBe(
      false,
    );
  });
});

describe("looksLikeMissingInfo", () => {
  it("「情報が足りません」パターンを検出", () => {
    expect(
      looksLikeMissingInfo(
        "申し訳ありません、お答えできる十分な情報がありません。",
      ),
    ).toBe(true);
  });

  it("「Codexに該当する情報がありません」パターンを検出", () => {
    expect(looksLikeMissingInfo("Codex に該当する情報はありません。")).toBe(
      true,
    );
  });

  it("地の文の「わかりません」単独は誤検知しない", () => {
    expect(
      looksLikeMissingInfo("「彼の気持ちはわかりません」と彼女は呟いた。"),
    ).toBe(false);
  });

  it("通常の応答は false", () => {
    expect(
      looksLikeMissingInfo(
        "登場人物のアリスは王国の第三王女で、剣術に長けています。",
      ),
    ).toBe(false);
  });

  it("空文字は false", () => {
    expect(looksLikeMissingInfo("")).toBe(false);
  });
});
