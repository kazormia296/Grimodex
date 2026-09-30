import { describe, expect, it } from "vitest";
import { adaptStoryOrderRows } from "./storyOrderAdapter";

describe("adaptStoryOrderRows", () => {
  const row = (
    sceneId: string,
    storyTimeOrder: string | null,
    version = 0,
  ) => ({
    projectId: "project-1",
    sceneId,
    storyTimeOrder,
    version,
    updatedAt: `2026-08-10T01:02:0${version}.000Z`,
  });

  it("orders only adjacent distinct buckets and leaves equal keys incomparable", async () => {
    const result = await adaptStoryOrderRows({
      projectId: "project-1",
      rows: [row("c", "b0", 3), row("a", "a0", 1), row("b", "a0", 2)],
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.constraints).toHaveLength(2);
    expect(result.constraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "interval-relation",
          leftNodeId: "tn:scene:a",
          relation: "before",
          rightNodeId: "tn:scene:c",
          authority: "user-metadata",
          strictness: "hard",
        }),
        expect.objectContaining({
          leftNodeId: "tn:scene:b",
          relation: "before",
          rightNodeId: "tn:scene:c",
        }),
      ]),
    );
    expect(
      result.constraints.some(
        (constraint) =>
          (constraint.leftNodeId === "tn:scene:a" &&
            constraint.rightNodeId === "tn:scene:b") ||
          (constraint.leftNodeId === "tn:scene:b" &&
            constraint.rightNodeId === "tn:scene:a"),
      ),
    ).toBe(false);
  });

  it("is input-order independent and ignores empty story keys", async () => {
    const rows = [row("c", "c0"), row("none", "  "), row("a", "a0")];
    const left = await adaptStoryOrderRows({ projectId: "project-1", rows });
    const right = await adaptStoryOrderRows({
      projectId: "project-1",
      rows: [...rows].reverse(),
    });

    expect(left.constraints).toEqual(right.constraints);
    expect(JSON.stringify(left.constraints)).not.toContain("none");
  });

  it("fails closed per foreign or malformed row", async () => {
    const result = await adaptStoryOrderRows({
      projectId: "project-1",
      rows: [
        { ...row("foreign", "a0"), projectId: "project-2" },
        { ...row("invalid", "b0"), version: -1 },
      ],
    });

    expect(result.constraints).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "TEMPORAL_ADAPTER_INVALID_ROW",
      "TEMPORAL_ADAPTER_PROJECT_MISMATCH",
    ]);
  });
});
