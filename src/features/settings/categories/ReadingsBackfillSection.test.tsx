// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReadingsBackfillSection } from "./ReadingsBackfillSection";
import { listCodexEntries, updateCodexEntry } from "@/features/codex/api";
import { inferReadings } from "@/features/codex/codexYomi";
import { listCodexTypes } from "@/features/codex/typeApi";

const { storeState } = vi.hoisted(() => ({
  storeState: {
    entries: [] as unknown[],
    loadEntries: vi.fn<() => Promise<void>>(),
    selectedEntry: null as { id: string } | null,
    setSelectedEntry: vi.fn(),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("sonner", () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "project-1",
}));

vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: () => false,
}));

vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: (
    selector: (state: { projectLanguage: string }) => unknown,
  ) => selector({ projectLanguage: "ja" }),
}));

vi.mock("@/features/codex/api", () => ({
  listCodexEntries: vi.fn(),
  updateCodexEntry: vi.fn(),
}));

vi.mock("@/features/codex/codexYomi", () => ({
  inferReadings: vi.fn(),
  YOMI_MAX_ENTRIES: 20,
}));

vi.mock("@/features/codex/typeApi", () => ({
  listCodexTypes: vi.fn(),
}));

vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: { getState: () => storeState },
}));

describe("ReadingsBackfillSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState.entries = [];
    storeState.selectedEntry = null;
    storeState.loadEntries.mockResolvedValue(undefined);
    vi.mocked(listCodexEntries).mockResolvedValue([
      {
        id: "entry-1",
        projectId: "project-1",
        type: "character",
        name: "刹那",
        aliases: null,
        readings: null,
      },
    ] as never);
    vi.mocked(listCodexTypes).mockResolvedValue([
      { slug: "character", label: "人物" },
    ] as never);
    vi.mocked(inferReadings).mockResolvedValue(
      new Map([["entry-1", [{ surface: "刹那", yomi: "せつな" }]]]),
    );
    vi.mocked(updateCodexEntry).mockResolvedValue({ id: "entry-1" } as never);
  });

  afterEach(() => cleanup());

  it("Codex パネルが未表示でも書き込み後に全件照合キャッシュを再同期する", async () => {
    render(<ReadingsBackfillSection />);

    fireEvent.click(screen.getByTestId("readings-backfill-run"));

    await waitFor(() => expect(updateCodexEntry).toHaveBeenCalledTimes(1));
    expect(storeState.entries).toEqual([]);
    expect(storeState.loadEntries).toHaveBeenCalledTimes(1);
  });
});
