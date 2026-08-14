import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "project-1",
}));
vi.mock("@/features/timelapse/recorder", () => ({
  getRecorderSessionId: () => "session-1",
}));

import { invoke } from "@/lib/tauri";
import { applyUndoJournal } from "./undoJournal";

function requestIds(): string[] {
  return (invoke as Mock).mock.calls.map(
    (call) => call[1].payload.requestId as string,
  );
}

beforeEach(() => {
  (invoke as Mock).mockReset().mockResolvedValue(undefined);
});

describe("applyUndoJournal request identity lease", () => {
  it("retains the same requestId after a rejected replay", async () => {
    (invoke as Mock).mockRejectedValueOnce(new Error("outcome unknown"));

    await expect(applyUndoJournal("journal-1", "undo")).rejects.toThrow(
      "outcome unknown",
    );
    await applyUndoJournal("journal-1", "undo");

    expect(requestIds()).toHaveLength(2);
    expect(requestIds()[1]).toBe(requestIds()[0]);
  });

  it("rotates after success for undo -> redo -> undo logical cycles", async () => {
    await applyUndoJournal("journal-cycle", "undo");
    await applyUndoJournal("journal-cycle", "redo");
    await applyUndoJournal("journal-cycle", "undo");

    const [firstUndo, redo, nextUndo] = requestIds();
    expect(redo).not.toBe(firstUndo);
    expect(nextUndo).not.toBe(firstUndo);
  });

  it("respects and retains an explicit requestId until success", async () => {
    (invoke as Mock).mockRejectedValueOnce(new Error("retry me"));
    await expect(
      applyUndoJournal("journal-explicit", "redo", "caller-request-1"),
    ).rejects.toThrow("retry me");

    await applyUndoJournal("journal-explicit", "redo");
    expect(requestIds()).toEqual(["caller-request-1", "caller-request-1"]);
  });
});
