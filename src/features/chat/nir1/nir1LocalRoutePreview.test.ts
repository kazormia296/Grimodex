import { describe, expect, it } from "vitest";
import { DEFAULT_AI_SETTINGS } from "@/features/chat/types";
import {
  isNir1LocalModelName,
  nir1LocalDestinationOf,
  nir1LocalRoutePreview,
} from "./nir1LocalRoutePreview";

// DD-1c (C9; K5/3 開示の試験 (2), DF+-b の 5): the destination and model the
// disclosure shows follow Native's IP literal rule only.

function settings(baseUrl: string, model = "local-model") {
  return {
    ...DEFAULT_AI_SETTINGS,
    provider: "openai-compatible" as const,
    model,
    openaiCompatibleEndpoints: [{ id: "local-1", label: "", baseUrl }],
    activeOpenaiCompatibleEndpointId: "local-1",
  };
}

describe("the route preview", () => {
  it.each([
    ["http://127.0.0.1:8080/v1", "http://127.0.0.1:8080/v1/chat/completions"],
    [
      "http://127.0.0.1:65535/v1/",
      "http://127.0.0.1:65535/v1/chat/completions",
    ],
    ["http://[::1]:1/v1", "http://[::1]:1/v1/chat/completions"],
  ])("shows %s as %s", (baseUrl, destination) => {
    expect(nir1LocalRoutePreview(settings(baseUrl))).toEqual({
      status: "usable",
      destination,
      model: "local-model",
    });
  });

  it.each([
    "http://localhost:8080/v1",
    "http://my-server:8080/v1",
    "http://127.0.0.2:8080/v1",
    "http://0x7f000001:8080/v1",
    "https://127.0.0.1:8080/v1",
    "http://127.0.0.1/v1",
    "http://127.0.0.1:0/v1",
    "http://127.0.0.1:080/v1",
    "http://127.0.0.1:65536/v1",
    "http://127.0.0.1:8080/v2",
    "http://127.0.0.1:8080",
    "http://[::ffff:127.0.0.1]:8080/v1",
    "http://192.168.0.2:8080/v1",
  ])("gives the reason why %s cannot be used", (baseUrl) => {
    expect(nir1LocalDestinationOf(baseUrl)).toBeNull();
    expect(nir1LocalRoutePreview(settings(baseUrl))).toEqual({
      status: "unusable",
      reason: "not-loopback",
    });
  });

  it("needs an OpenAI-compatible provider and an endpoint", () => {
    expect(
      nir1LocalRoutePreview({
        ...settings("http://127.0.0.1:1/v1"),
        provider: "ollama",
      }),
    ).toEqual({ status: "unusable", reason: "provider" });
    expect(nir1LocalRoutePreview(null)).toEqual({
      status: "unusable",
      reason: "provider",
    });
    expect(
      nir1LocalRoutePreview({
        ...settings("http://127.0.0.1:1/v1"),
        openaiCompatibleEndpoints: [],
        openaiCompatible: {
          ...DEFAULT_AI_SETTINGS.openaiCompatible,
          baseUrl: "",
        },
      }),
    ).toEqual({ status: "unusable", reason: "no-endpoint" });
  });

  it.each([
    ["", false],
    [" model", false],
    ["model ", false],
    ["a\nb", false],
    ["a\tb", false],
    ["a\u0085b", false],
    ["a b", false],
    ["a‮b", false],
    ["a⁦b", false],
    ["a".repeat(257), false],
    ["a".repeat(256), true],
    ['qwen 2.5 "local" \\ モデル', true],
  ])("model name %j is valid: %s", (model, valid) => {
    expect(isNir1LocalModelName(model)).toBe(valid);
    expect(
      nir1LocalRoutePreview(settings("http://127.0.0.1:1/v1", model)).status,
    ).toBe(valid ? "usable" : "unusable");
  });
});
