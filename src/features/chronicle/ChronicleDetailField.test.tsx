// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { ChronicleDetailField } from "./ChronicleDetailField";
import type { EventRow } from "./api";

vi.mock("@/features/codex/components/CodexContentEditor", () => ({
  CodexContentEditor: () => <div data-testid="mini-editor" />,
}));

vi.mock("@/features/editor/tabStore", () => ({
  useTabStore: { getState: () => ({ openChronicleEventTab: vi.fn() }) },
}));

vi.mock("@/hooks/useAutoSave", () => ({
  useAutoSave: () => ({
    schedule: vi.fn(),
    cancel: vi.fn(),
    flush: vi.fn(),
  }),
}));

function eventRow(): EventRow {
  return {
    id: "ev1",
    projectId: "p1",
    title: "出来事A",
    note: null,
    detail: "",
    ordinal: "a0",
    primaryCodexId: null,
    laneGroup: null,
    locationCodexId: null,
    startTime: null,
    endTime: null,
    startMinute: null,
    endMinute: null,
    startGranularity: "none",
    endGranularity: "none",
    precision: "exact",
    kind: "generic",
    secret: false,
    revealSceneId: null,
    createdAt: "",
    updatedAt: "",
  };
}

describe("ChronicleDetailField (label association)", () => {
  it("エディタ領域は role=group で、aria-labelledby が「詳細」ラベルを指す", () => {
    const { container, getByTestId } = render(
      <ChronicleDetailField event={eventRow()} onPatchDetail={() => {}} />,
    );
    const group = container.querySelector('[role="group"]')!;
    expect(group).toBeTruthy();
    const labelId = group.getAttribute("aria-labelledby")!;
    expect(labelId).toBeTruthy();
    const label = document.getElementById(labelId)!;
    expect(label.textContent).toBe("詳細");
    // ラベル・エディタとも group 内（1.3.1 の関連付けが構造でも成立）。
    expect(group.contains(label)).toBe(true);
    expect(group.contains(getByTestId("mini-editor"))).toBe(true);
  });
});
