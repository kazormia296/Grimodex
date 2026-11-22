// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReadingsBackfillSection } from "./ReadingsBackfillSection";
import { listCodexEntries, updateCodexEntry } from "@/features/codex/api";
import { inferReadings, listYomiHiddenIds } from "@/features/codex/codexYomi";
import { listCodexTypes } from "@/features/codex/typeApi";

// 読みの一括推定は、作者が hidden（AI に秘匿）と印した Codex を、対象に入れず AI へ送らない。
// contextMode が不明値・欠落でも送らない（fail-closed）。

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
vi.mock("@/features/license/gate", () => ({
  blockIfUnlicensed: () => false,
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
  listYomiHiddenIds: vi.fn(),
  YOMI_MAX_ENTRIES: 20,
}));
vi.mock("@/features/codex/typeApi", () => ({
  listCodexTypes: vi.fn(),
}));
vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: { getState: () => storeState },
}));

function entry(id: string, name: string, contextMode: unknown) {
  return {
    id,
    projectId: "project-1",
    type: "character",
    name,
    aliases: null,
    readings: null,
    ...(contextMode === undefined ? {} : { contextMode }),
  };
}

function sentIds(): string[] {
  return vi
    .mocked(inferReadings)
    .mock.calls.flatMap(([batch]) => batch.map((e) => e.id));
}

async function runBackfill() {
  render(<ReadingsBackfillSection />);
  fireEvent.click(screen.getByTestId("readings-backfill-run"));
}

describe("ReadingsBackfillSection と hidden の Codex", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState.entries = [];
    storeState.selectedEntry = null;
    storeState.loadEntries.mockResolvedValue(undefined);
    vi.mocked(listCodexTypes).mockResolvedValue([
      { slug: "character", label: "人物" },
    ] as never);
    vi.mocked(inferReadings).mockResolvedValue(new Map());
    vi.mocked(listYomiHiddenIds).mockResolvedValue(new Set());
    vi.mocked(updateCodexEntry).mockResolvedValue({ id: "x" } as never);
  });

  afterEach(() => cleanup());

  it("hidden が混在しても、inferReadings には hidden の id を渡さない", async () => {
    vi.mocked(listCodexEntries).mockResolvedValue([
      entry("a", "刹那", "mentioned"),
      entry("secret", "帝都", "hidden"),
      entry("b", "剣聖", "always"),
    ] as never);

    await runBackfill();

    await waitFor(() => expect(inferReadings).toHaveBeenCalled());
    expect(sentIds()).toEqual(["a", "b"]);
  });

  it("全件 hidden なら inferReadings を呼ばず、対象なしの toast で終わる", async () => {
    vi.mocked(listCodexEntries).mockResolvedValue([
      entry("s1", "刹那", "hidden"),
      entry("s2", "帝都", "hidden"),
    ] as never);

    await runBackfill();

    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith("codex.readings.backfillNone"),
    );
    expect(inferReadings).not.toHaveBeenCalled();
  });

  it("contextMode が不明値・欠落・null の項目も送らない（fail-closed）", async () => {
    vi.mocked(listCodexEntries).mockResolvedValue([
      entry("unknown", "刹那", "future-mode"),
      entry("missing", "帝都", undefined),
      entry("nullish", "剣聖", null),
    ] as never);

    await runBackfill();

    await waitFor(() => expect(toast.info).toHaveBeenCalled());
    expect(inferReadings).not.toHaveBeenCalled();
  });

  it("suppress・always・mentioned は従来どおり送る", async () => {
    vi.mocked(listCodexEntries).mockResolvedValue([
      entry("s", "刹那", "suppress"),
      entry("a", "帝都", "always"),
      entry("m", "剣聖", "mentioned"),
    ] as never);

    await runBackfill();

    await waitFor(() => expect(inferReadings).toHaveBeenCalled());
    expect(sentIds()).toEqual(["s", "a", "m"]);
  });

  it("base は公開で Phase でだけ hidden の項目は、事前判定で対象から除く（DR-MP4-41）", async () => {
    vi.mocked(listCodexEntries).mockResolvedValue([
      entry("a", "刹那", "mentioned"),
      entry("phase-hidden", "帝都", "mentioned"),
      entry("b", "剣聖", "always"),
    ] as never);
    vi.mocked(listYomiHiddenIds).mockResolvedValue(new Set(["phase-hidden"]));

    await runBackfill();

    await waitFor(() => expect(inferReadings).toHaveBeenCalled());
    expect(sentIds()).toEqual(["a", "b"]);
    // 判定には、base の mode で残った項目をまとめて 1 回で渡す。
    expect(listYomiHiddenIds).toHaveBeenCalledTimes(1);
    expect(listYomiHiddenIds).toHaveBeenCalledWith(["a", "phase-hidden", "b"]);
  });

  it("残りが全部 Phase でだけ hidden なら、inferReadings を呼ばず対象なしの toast で終わる（毎回 0 件の完了にしない）", async () => {
    vi.mocked(listCodexEntries).mockResolvedValue([
      entry("p1", "刹那", "mentioned"),
      entry("p2", "帝都", "always"),
    ] as never);
    vi.mocked(listYomiHiddenIds).mockResolvedValue(new Set(["p1", "p2"]));

    await runBackfill();

    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith("codex.readings.backfillNone"),
    );
    expect(inferReadings).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("base が hidden の項目だけなら、Phase の事前判定を呼ばない（対象が無い）", async () => {
    vi.mocked(listCodexEntries).mockResolvedValue([
      entry("s1", "刹那", "hidden"),
    ] as never);

    await runBackfill();

    await waitFor(() => expect(toast.info).toHaveBeenCalled());
    expect(listYomiHiddenIds).not.toHaveBeenCalled();
  });
});
