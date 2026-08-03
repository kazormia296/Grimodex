import { describe, expect, it } from "vitest";
import {
  awaitPendingEditorWrites,
  trackPendingEditorWrite,
} from "./editorQuiescence";

describe("awaitPendingEditorWrites", () => {
  it("waits for every write before reporting failures", async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    trackPendingEditorWrite(Promise.reject(new Error("first failed")));
    trackPendingEditorWrite(slow);

    let settled = false;
    const wait = awaitPendingEditorWrites()
      .catch((error: unknown) => error)
      .then((error) => {
        settled = true;
        return error;
      });
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    const error = await wait;
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(1);
  });
});
