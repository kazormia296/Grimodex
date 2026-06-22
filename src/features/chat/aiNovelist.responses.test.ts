import { describe, expect, it } from "vitest";
import {
  isResponsesApiCapableProvider,
  resolveAinoveristApiVariant,
  resolveModelApiVariant,
} from "./aiNovelist";

// resolveModelApiVariant は送信/永続化の variant 解決の正本。
// OpenAI/互換で Responses 選択を保持し、resolveAinoveristApiVariant の
// 「任意モデル→legacy」フォールバックに潰されないことを固定する
// (この回帰でチャット/Agent/ストリーミングの Responses が全死していた)。
describe("resolveModelApiVariant", () => {
  const models: Array<{ id: string; apiVariant?: string }> = [];

  it("OpenAI 直で responses 選択中は responses を返す", () => {
    expect(resolveModelApiVariant("openai", "gpt-5", models, "responses")).toBe(
      "responses",
    );
  });

  it("OpenAI 互換 gateway でも responses を保持する", () => {
    expect(
      resolveModelApiVariant(
        "openai-compatible",
        "my-model",
        models,
        "responses",
      ),
    ).toBe("responses");
  });

  it("OpenRouter でも responses を保持する (beta /api/v1/responses 対応)", () => {
    expect(
      resolveModelApiVariant(
        "openrouter",
        "openai/gpt-4o-mini",
        models,
        "responses",
      ),
    ).toBe("responses");
  });

  it("responses 選択でも provider が Responses 非対応なら委譲する", () => {
    // 例: provider 切替で stale な responses が残っても Anthropic 等には載せない。
    expect(
      resolveModelApiVariant("anthropic", "claude-3.7", models, "responses"),
    ).toBe("legacy");
    expect(
      resolveModelApiVariant("ai-novelist", "anything", models, "responses"),
    ).toBe("legacy");
  });

  it("responses 未選択なら resolveAinoveristApiVariant に委譲する", () => {
    expect(resolveModelApiVariant("openai", "gpt-4o", models, null)).toBe(
      resolveAinoveristApiVariant("gpt-4o", models, null),
    );
  });

  it("AI のべりすとの legacy/v1 解決には干渉しない", () => {
    expect(
      resolveModelApiVariant("ai-novelist", "anything", models, "legacy"),
    ).toBe("legacy");
    expect(
      resolveModelApiVariant("ai-novelist", "anything", models, "v1"),
    ).toBe("v1");
  });
});

describe("isResponsesApiCapableProvider", () => {
  it("OpenAI 直 / 互換 gateway / OpenRouter が対応", () => {
    expect(isResponsesApiCapableProvider("openai")).toBe(true);
    expect(isResponsesApiCapableProvider("openai-compatible")).toBe(true);
    expect(isResponsesApiCapableProvider("openrouter")).toBe(true);
  });

  it("それ以外のプロバイダ / 未指定は非対応", () => {
    expect(isResponsesApiCapableProvider("anthropic")).toBe(false);
    expect(isResponsesApiCapableProvider("ai-novelist")).toBe(false);
    expect(isResponsesApiCapableProvider("ollama")).toBe(false);
    expect(isResponsesApiCapableProvider("cli")).toBe(false);
    expect(isResponsesApiCapableProvider(undefined)).toBe(false);
  });
});
