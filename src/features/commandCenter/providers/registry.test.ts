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
    const result = getProviders();
    expect(result.map((p) => p.id)).toEqual(["lexical", "semantic"]);
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
    expect(getProviders()).toEqual([]);
  });
});
