import { beforeEach, describe, expect, it, vi } from "vitest";
import { exportRecoveryDrafts } from "./exportRecoveryDrafts";

const saveTextFile = vi.hoisted(() =>
  vi.fn<
    (
      suggestedName: string,
      filter: unknown,
      contents: string,
      mime?: string,
    ) => Promise<string | null>
  >(async () => "/tmp/recovery.json"),
);

vi.mock("@/lib/exportFile", () => ({ saveTextFile }));
vi.mock("@/features/editor/editorSaveRegistry", () => ({
  collectEditorRecoveryDrafts: () => [],
}));

describe("exportRecoveryDrafts", () => {
  beforeEach(() => saveTextFile.mockClear());

  it("does not copy backend error messages into the recovery bundle", async () => {
    await exportRecoveryDrafts([
      {
        stage: "external-write-back",
        error: new Error("secret prose in SQL params"),
      },
    ]);

    const serialized = String(saveTextFile.mock.calls[0]?.[2]);
    expect(serialized).not.toContain("secret prose");
    expect(JSON.parse(serialized).failures).toEqual([
      { stage: "external-write-back", error: "Error" },
    ]);
  });
});
