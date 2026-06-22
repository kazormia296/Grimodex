import { describe, expect, it } from "vitest";
import {
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

  it("responses 選択でも provider が OpenAI 系でなければ委譲する", () => {
    // 例: provider 切替で stale な responses が残っても OpenRouter には載せない。
    expect(
      resolveModelApiVariant(
        "openrouter",
        "anthropic/claude",
        models,
        "responses",
      ),
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
