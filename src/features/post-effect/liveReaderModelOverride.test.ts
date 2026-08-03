import { describe, expect, it } from "vitest";
import { resolveLiveReaderModelOverride } from "./liveReaderModelOverride";

function settings(values: Record<string, string>) {
  return {
    get: (key: string, defaultValue?: string) =>
      values[key] ?? defaultValue ?? "",
  };
}

describe("resolveLiveReaderModelOverride", () => {
  it("falls back when no reader model is configured", () => {
    expect(resolveLiveReaderModelOverride(settings({}))).toEqual({
      model: null,
      provider: null,
      apiVariant: null,
      endpointId: null,
    });
  });

  it("resolves the reader model, provider, variant, and endpoint", () => {
    expect(
      resolveLiveReaderModelOverride(
        settings({
          "aiModel.role.reader": "reader-model",
          "aiModel.roleProviders": JSON.stringify({
            reader: { provider: "sakana", endpointId: "reader-endpoint" },
          }),
        }),
      ),
    ).toEqual({
      model: "reader-model",
      provider: "sakana",
      apiVariant: "responses",
      endpointId: "reader-endpoint",
    });
  });

  it("ignores malformed provider routing without losing the model", () => {
    expect(
      resolveLiveReaderModelOverride(
        settings({
          "aiModel.role.reader": "reader-model",
          "aiModel.roleProviders": "not-json",
        }),
      ),
    ).toEqual({
      model: "reader-model",
      provider: null,
      apiVariant: null,
      endpointId: null,
    });
  });

  it("fails safe for known structured-output-incompatible DeepSeek models", () => {
    expect(
      resolveLiveReaderModelOverride(
        settings({ "aiModel.role.reader": "deepseek/deepseek-r1" }),
      ),
    ).toEqual({
      model: null,
      provider: null,
      apiVariant: null,
      endpointId: null,
    });
  });
});
