import { describe, it, expect, beforeEach } from "vitest";
import {
  bumpMatrixDataVersion,
  useMatrixDataVersionStore,
} from "./matrixDataVersion";

describe("matrixDataVersion", () => {
  beforeEach(() => {
    useMatrixDataVersionStore.setState({ version: 0 });
  });

  it("bump increments version monotonically", () => {
    expect(useMatrixDataVersionStore.getState().version).toBe(0);
    bumpMatrixDataVersion();
    expect(useMatrixDataVersionStore.getState().version).toBe(1);
    bumpMatrixDataVersion();
    expect(useMatrixDataVersionStore.getState().version).toBe(2);
  });

  it("notifies subscribers", () => {
    const seen: number[] = [];
    const unsub = useMatrixDataVersionStore.subscribe((s) =>
      seen.push(s.version),
    );
    bumpMatrixDataVersion();
    bumpMatrixDataVersion();
    unsub();
    expect(seen).toEqual([1, 2]);
  });
});
