// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";
import type { EventRow } from "./api";

// 重い子コンポーネントは軽量スタブへ（key の重複検出は親側で起きるので実装不要）。
vi.mock("./ChronicleDatePicker", () => ({ ChronicleDatePicker: () => null }));
vi.mock("./ChronicleDetailField", () => ({
  ChronicleDetailField: () => <div data-testid="detail-field" />,
}));
vi.mock("./CodexEntryPicker", () => ({
  CodexEntryPicker: () => <div data-testid="codex-picker" />,
}));
vi.mock("./SceneLinkField", () => ({
  SceneLinkField: () => <div data-testid="scene-link" />,
}));
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

import { ChronicleInspector } from "./ChronicleInspector";

const NOW = "2026-06-27T00:00:00.000Z";

function ev(over: Partial<EventRow> = {}): EventRow {
  return {
    id: "ea",
    projectId: "p1",
    title: "出来事A",
    note: null,
    detail: null,
    ordinal: "a0",
    primaryCodexId: null,
    laneGroup: null,
    locationCodexId: null,
    startTime: 100,
    endTime: null,
    startMinute: null,
    endMinute: null,
    startGranularity: "day",
    endGranularity: "none",
    precision: "exact",
    kind: "generic",
    secret: false,
    revealSceneId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function renderInspector() {
  return render(
    <ChronicleInspector
      event={ev()}
      laneOptions={[]}
      locations={[]}
      scenes={[]}
      calendar={{ daysPerYear: 360, seasonBoundaries: [] }}
      allEvents={[]}
      onPatch={() => {}}
      onDelete={() => {}}
      onClose={() => {}}
      onLinkScene={() => {}}
      onUnlinkScene={() => {}}
    />,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ChronicleInspector — 子要素の React key", () => {
  it("詳細欄と参照シーン節が同一 key で重複せず、React の重複 key 警告を出さない", () => {
    const errors: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        errors.push(args.map((a) => String(a)).join(" "));
      });

    const { getAllByTestId } = renderInspector();

    spy.mockRestore();
    const dupKeyWarnings = errors.filter((e) =>
      /Encountered two children with the same key|same key/i.test(e),
    );
    expect(dupKeyWarnings).toEqual([]);
    // 詳細欄・参照シーン節はそれぞれ 1 つだけ（増殖しない）。
    expect(getAllByTestId("detail-field").length).toBe(1);
    expect(getAllByTestId("scene-link").length).toBe(1);
  });
});
