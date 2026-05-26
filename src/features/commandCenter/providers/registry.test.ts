import { afterEach, describe, expect, it } from "vitest";
import {
  _clearProvidersForTests,
  getProviderById,
  getProviders,
  registerProvider,
  unregisterProvider,
} from "./registry";
import type { CommandCenterProvider } from "./types";

function makeProvider(
  id: string,
  overrides: Partial<CommandCenterProvider> = {},
): CommandCenterProvider {
  return {
    id,
    order: 1,
    title: id,
    hideWhenEmpty: true,
    surfaces: ["bar", "panel"],
    supportsMode: () => true,
    search: async () => ({ id, title: id, order: 1, items: [] }),
    ...overrides,
  };
}

describe("commandCenter/providers/registry", () => {
  afterEach(() => {
    _clearProvidersForTests();
  });

  it("registers and lists providers in order", () => {
    registerProvider(makeProvider("semantic", { order: 2 }));
    registerProvider(makeProvider("lexical", { order: 1 }));
    const result = getProviders("search");
    expect(result.map((p) => p.id)).toEqual(["lexical", "semantic"]);
  });

  it("filters by mode via supportsMode", () => {
    registerProvider(
      makeProvider("lexical", { supportsMode: (m) => m === "search" }),
    );
    registerProvider(
      makeProvider("command", { supportsMode: (m) => m === "command" }),
    );
    expect(getProviders("search").map((p) => p.id)).toEqual(["lexical"]);
    expect(getProviders("command").map((p) => p.id)).toEqual(["command"]);
  });

  it("getProviderById returns provider or undefined", () => {
    const p = makeProvider("lexical");
    registerProvider(p);
    expect(getProviderById("lexical")).toBe(p);
    expect(getProviderById("missing")).toBeUndefined();
  });

  it("unregisterProvider removes from registry", () => {
    registerProvider(makeProvider("lexical"));
    unregisterProvider("lexical");
    expect(getProviders("search")).toEqual([]);
  });

  it("filters by surface when specified", () => {
    registerProvider(makeProvider("bar-only", { surfaces: ["bar"] }));
    registerProvider(makeProvider("panel-only", { surfaces: ["panel"] }));
    registerProvider(makeProvider("both", { surfaces: ["bar", "panel"] }));
    expect(
      getProviders("search", "bar")
        .map((p) => p.id)
        .sort(),
    ).toEqual(["bar-only", "both"]);
    expect(
      getProviders("search", "panel")
        .map((p) => p.id)
        .sort(),
    ).toEqual(["both", "panel-only"]);
    // surface 未指定なら全件 (後方互換)
    expect(
      getProviders("search")
        .map((p) => p.id)
        .sort(),
    ).toEqual(["bar-only", "both", "panel-only"]);
  });
});
