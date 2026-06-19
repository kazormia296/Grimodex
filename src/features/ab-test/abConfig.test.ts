import { describe, it, expect } from "vitest";
import { deriveAbConfigs, isAbConfigMeaningful } from "./abConfig";

describe("deriveAbConfigs", () => {
  it("model mode: A is default, B carries only the model", () => {
    const { configA, configB } = deriveAbConfigs("model", { model: "gpt-x" });
    expect(configA).toEqual({});
    expect(configB).toEqual({ model: "gpt-x" });
  });

  it("model mode: blank model collapses to undefined (=default)", () => {
    const { configB } = deriveAbConfigs("model", { model: "   " });
    expect(configB).toEqual({ model: undefined });
  });

  it("prompt mode: A is default, B carries only the prompt variant", () => {
    const { configA, configB } = deriveAbConfigs("prompt", {
      promptVariant: "  be terse  ",
    });
    expect(configA).toEqual({});
    expect(configB).toEqual({ promptVariant: "be terse" });
  });

  it("prompt mode: model input is ignored", () => {
    const { configB } = deriveAbConfigs("prompt", {
      model: "gpt-x",
      promptVariant: "tone up",
    });
    expect(configB).toEqual({ promptVariant: "tone up" });
    expect(configB.model).toBeUndefined();
  });
});

describe("isAbConfigMeaningful", () => {
  it("model mode requires a non-empty model", () => {
    expect(isAbConfigMeaningful("model", { model: "m" })).toBe(true);
    expect(isAbConfigMeaningful("model", { model: "" })).toBe(false);
    expect(isAbConfigMeaningful("model", {})).toBe(false);
  });

  it("prompt mode requires a non-empty variant", () => {
    expect(isAbConfigMeaningful("prompt", { promptVariant: "x" })).toBe(true);
    expect(isAbConfigMeaningful("prompt", { promptVariant: "  " })).toBe(false);
    expect(isAbConfigMeaningful("prompt", {})).toBe(false);
  });
});
