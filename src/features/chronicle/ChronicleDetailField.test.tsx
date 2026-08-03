// @vitest-environment happy-dom
import { beforeEach, describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { ChronicleDetailField } from "./ChronicleDetailField";
import type { EventRow } from "./api";

vi.mock("@/features/codex/components/CodexContentEditor", () => ({
  CodexContentEditor: ({
    onContentChange,
  }: {
    onContentChange: (content: string) => void;
  }) => (
    <button
      data-testid="mini-editor"
      onClick={() => onContentChange("changed detail")}
    >
      edit
    </button>
  ),
}));

vi.mock("@/features/editor/tabStore", () => ({
  useTabStore: { getState: () => ({ openChronicleEventTab: vi.fn() }) },
}));

const autoSaveHarness = vi.hoisted(() => ({
  save: null as null | (() => Promise<void>),
  schedule: vi.fn(),
  cancel: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  flush: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/hooks/useAutoSave", () => ({
  useAutoSave: (save: () => Promise<void>) => {
    autoSaveHarness.save = save;
    return {
      schedule: autoSaveHarness.schedule,
      cancel: autoSaveHarness.cancel,
      pause: autoSaveHarness.pause,
      resume: autoSaveHarness.resume,
      flush: autoSaveHarness.flush,
      setDelay: vi.fn(),
    };
  },
}));

vi.mock("./version", () => ({
  getEventVersion: vi.fn(),
}));

import { getEventVersion } from "./version";
import { useExternalWriteStore } from "@/features/concurrency/externalWriteStore";

const mockGetEventVersion = vi.mocked(getEventVersion);

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
    version: 0,
    createdAt: "",
    updatedAt: "",
  };
}

describe("ChronicleDetailField (label association)", () => {
  beforeEach(() => {
    autoSaveHarness.save = null;
    autoSaveHarness.schedule.mockClear();
    autoSaveHarness.cancel.mockClear();
    autoSaveHarness.pause.mockClear();
    autoSaveHarness.resume.mockClear();
    autoSaveHarness.flush.mockClear();
    autoSaveHarness.flush.mockResolvedValue(undefined);
    mockGetEventVersion.mockReset();
    useExternalWriteStore.getState().clear();
  });

  it("エディタ領域は role=group で、aria-labelledby が「詳細」ラベルを指す", () => {
    const { container, getByTestId } = render(
      <ChronicleDetailField
        event={eventRow()}
        onPatchDetail={async () => ({ version: 1 })}
      />,
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

  it("uses the loaded Event version and advances it after a successful save", async () => {
    const onPatchDetail = vi
      .fn()
      .mockResolvedValueOnce({ version: 4 })
      .mockResolvedValueOnce({ version: 5 });
    const { getByTestId } = render(
      <ChronicleDetailField event={eventRow()} onPatchDetail={onPatchDetail} />,
    );

    fireEvent.click(getByTestId("mini-editor"));
    await act(async () => {
      await autoSaveHarness.save?.();
    });
    fireEvent.click(getByTestId("mini-editor"));
    await act(async () => {
      await autoSaveHarness.save?.();
    });

    expect(onPatchDetail).toHaveBeenNthCalledWith(1, "changed detail", 0);
    expect(onPatchDetail).toHaveBeenNthCalledWith(2, "changed detail", 4);
  });

  it("detail が clean の Keep は外部 detail を書き戻さず aggregate version だけ進める", async () => {
    mockGetEventVersion.mockResolvedValue(7);
    const onPatchDetail = vi.fn().mockResolvedValue({ version: 8 });
    const onResolveExternalVersion = vi.fn();
    const event = eventRow();
    const { getByRole } = render(
      <ChronicleDetailField
        event={event}
        onPatchDetail={onPatchDetail}
        onResolveExternalVersion={onResolveExternalVersion}
      />,
    );
    act(() => {
      useExternalWriteStore.getState().pushConflict({
        documentKey: { kind: "chronicle-event", id: event.id },
        sceneId: event.id,
        domain: "event",
        opType: "event.update",
        entityId: event.id,
      });
    });

    fireEvent.click(
      getByRole("button", {
        name: /編集中の内容を保持|Keep my edits/,
      }),
    );
    await waitFor(() =>
      expect(onResolveExternalVersion).toHaveBeenCalledWith(7),
    );

    expect(onPatchDetail).not.toHaveBeenCalled();
    expect(autoSaveHarness.schedule).not.toHaveBeenCalled();
    expect(autoSaveHarness.flush).not.toHaveBeenCalled();
  });
});
