import { beforeEach, describe, expect, it, vi } from "vitest";
import { commandProvider } from "./commandProvider";
import type { ProviderSearchContext } from "./types";

vi.mock("@/features/layout/layoutStore", () => ({
  useLayoutStore: { getState: vi.fn() },
}));

import { useLayoutStore } from "@/features/layout/layoutStore";

function makeContext(
  overrides: Partial<ProviderSearchContext> = {},
): ProviderSearchContext {
  return {
    query: "",
    signal: new AbortController().signal,
    limit: 100,
    mode: "command",
    generation: 1,
    descriptionMode: false,
    ...overrides,
  };
}

describe("commandProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useLayoutStore.getState).mockReturnValue({
      togglePanel: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });

  it("registers as bar surface, command mode only", () => {
    expect(commandProvider.surfaces).toEqual(["bar"]);
    expect(commandProvider.supportsMode("command")).toBe(true);
    expect(commandProvider.supportsMode("search")).toBe(false);
  });

  it("blank query returns full command list (capped by limit)", async () => {
    const section = await commandProvider.search(makeContext({ limit: 5 }));
    expect(section.items.length).toBe(5);
  });

  it("filters by label substring", async () => {
    const section = await commandProvider.search(
      makeContext({ query: "ツアー" }),
    );
    expect(section.items.length).toBeGreaterThan(0);
    expect(section.items.every((i) => i.title.includes("ツアー"))).toBe(true);
  });

  it("filters by keyword fallback", async () => {
    const section = await commandProvider.search(
      makeContext({ query: "export" }),
    );
    const titles = section.items.map((i) => i.title);
    expect(titles).toContain("エクスポート");
  });

  it("onSelect triggers togglePanel for panel commands", async () => {
    const togglePanel = vi.fn();
    vi.mocked(useLayoutStore.getState).mockReturnValue({
      togglePanel,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const section = await commandProvider.search(
      makeContext({ query: "シーン" }),
    );
    const scenesPanelCmd = section.items.find((i) =>
      i.title.includes("シーン"),
    );
    expect(scenesPanelCmd).toBeDefined();
    scenesPanelCmd?.onSelect();
    expect(togglePanel).toHaveBeenCalledWith("scenes");
  });
});
