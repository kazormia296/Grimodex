import { describe, expect, it } from "vitest";
import { buildPair, cases } from "./prompts";

describe("B1 prompt pairs", () => {
  it("has five valid synthetic cases and changes only L4 order", () => {
    expect(cases).toHaveLength(5);
    for (const item of cases) {
      expect(item.id).toBeTruthy();
      expect(item.scene.title).toBeTruthy();
      expect(item.scene.content).toBeTruthy();
      expect(item.codexEntries.length).toBeGreaterThanOrEqual(3);
      expect(item.codexEntries.length).toBeLessThanOrEqual(6);
      for (const entry of item.codexEntries) {
        expect(entry.id).toBeTruthy();
        expect(entry.type).toBeTruthy();
        expect(entry.name).toBeTruthy();
        expect(entry.summary).toBeTruthy();
      }
      expect(item.userMessage).toBeTruthy();
      expect(item.expected.length).toBeGreaterThan(0);
      expect(item.forbidden.length).toBeGreaterThan(0);
      expect(item.approvedCodexEntryIds.length).toBeGreaterThan(0);
      for (const id of item.approvedCodexEntryIds)
        expect(item.codexEntries.some((entry) => entry.id === id)).toBe(true);
      const pair = buildPair(item);
      expect(pair.controlKeys).toHaveLength(item.codexEntries.length);
      expect({
        id: item.id,
        selection: pair.sameSelection,
        outer: pair.sameOuterLayers,
        total: pair.sameTotal,
        changed: pair.l4Changed,
        control: pair.controlKeys,
        ranked: pair.rankedKeys,
      }).toEqual(
        expect.objectContaining({
          selection: true,
          outer: true,
          total: true,
          changed: true,
        }),
      );
      expect(pair.controlKeys.at(-1)).not.toBe(pair.rankedKeys[0]);
    }
  });
});
