import { describe, expect, it } from "vitest";
import {
  isResponsesApiCapableProvider,
  resolveAinoveristApiVariant,
  resolveModelApiVariant,
  resolveSendApiVariant,
} from "./aiNovelist";
import { DEFAULT_AI_SETTINGS, type AiSettings } from "./types";

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

// resolveSendApiVariant は「アクティブプロバイダの送信経路」の variant 正本。
// openai-compatible は経路をエンドポイント単位 apiVariant で決め、グローバル
// modelApiVariant(Responses トグル)を持ち込まない — この回帰で PlaMo 等
// /responses 非対応の互換サーバへの送信が 404 していた。
describe("resolveSendApiVariant", () => {
  const models: Array<{ id: string; apiVariant?: string }> = [];

  function compatSettings(
    endpointVariant: "v1" | "responses" | null,
    globalVariant: AiSettings["modelApiVariant"],
  ): AiSettings {
    return {
      ...DEFAULT_AI_SETTINGS,
      provider: "openai-compatible",
      modelApiVariant: globalVariant,
      openaiCompatibleEndpoints: [
        {
          id: "plamo",
          label: "PlaMo",
          baseUrl: "https://api.platform.preferredai.jp/v1",
          apiVariant: endpointVariant,
        },
      ],
      activeOpenaiCompatibleEndpointId: "plamo",
    };
  }

  it("互換 auto エンドポイントはグローバル responses 残留を無視し /chat/completions 経路", () => {
    // endpoint=auto なのに他プロバイダの responses トグルが残留しているケース。
    const variant = resolveSendApiVariant(
      compatSettings(null, "responses"),
      models,
      "plamo-3.0-prime",
    );
    expect(variant).not.toBe("responses");
  });

  it("互換 endpoint=responses を明示選択したときだけ responses に乗る", () => {
    expect(
      resolveSendApiVariant(
        compatSettings("responses", null),
        models,
        "plamo-3.0-prime",
      ),
    ).toBe("responses");
  });

  it("互換 endpoint=v1 はグローバル responses 残留より優先される", () => {
    expect(
      resolveSendApiVariant(
        compatSettings("v1", "responses"),
        models,
        "plamo-3.0-prime",
      ),
    ).toBe("v1");
  });

  it("非互換プロバイダ(OpenAI 直)はグローバル responses トグルをそのまま尊重する", () => {
    const settings: AiSettings = {
      ...DEFAULT_AI_SETTINGS,
      provider: "openai",
      modelApiVariant: "responses",
    };
    expect(resolveSendApiVariant(settings, models, "gpt-5")).toBe("responses");
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
