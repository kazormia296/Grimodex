import { describe, it, expect } from "vitest";
import { normalizeThread, normalizeLink, normalizeBranch } from "./api";

describe("plot-threads api normalization", () => {
  it("normalizes a snake_case DB thread row into camelCase", () => {
    const row = {
      id: "t1",
      project_id: "p1",
      name: "復讐の糸",
      color: "#c33",
      description: null,
      sort_order: "a0",
      created_at: "2026-06-22T00:00:00Z",
      updated_at: "2026-06-22T00:00:00Z",
    };
    expect(normalizeThread(row)).toEqual({
      id: "t1",
      projectId: "p1",
      name: "復讐の糸",
      color: "#c33",
      description: null,
      sortOrder: "a0",
      startNodeId: null,
      endNodeId: null,
      version: 0,
      createdAt: "2026-06-22T00:00:00Z",
      updatedAt: "2026-06-22T00:00:00Z",
    });
  });

  it("normalizes a camelCase invoke thread row too", () => {
    const row = { id: "t1", projectId: "p1", name: "x", sortOrder: "a1" };
    const out = normalizeThread(row);
    expect(out.projectId).toBe("p1");
    expect(out.sortOrder).toBe("a1");
    expect(out.color).toBeNull();
  });

  it("falls back to defaults for a missing thread sortOrder", () => {
    expect(normalizeThread({ id: "t1" }).sortOrder).toBe("a0");
  });

  it("normalizes start/end span override from snake_case and camelCase", () => {
    expect(
      normalizeThread({ id: "t1", start_node_id: "s1", end_node_id: "s9" }),
    ).toMatchObject({ startNodeId: "s1", endNodeId: "s9" });
    expect(normalizeThread({ id: "t1", startNodeId: "s2" })).toMatchObject({
      startNodeId: "s2",
      endNodeId: null,
    });
  });

  it("normalizes a snake_case link row and defaults phaseType", () => {
    const row = {
      id: "l1",
      thread_id: "t1",
      node_id: "s1",
      phase_type: "climax",
      note: null,
      sort_order: null,
    };
    expect(normalizeLink(row)).toMatchObject({
      id: "l1",
      threadId: "t1",
      nodeId: "s1",
      phaseType: "climax",
      note: null,
      sortOrder: null,
    });
    expect(normalizeLink({ id: "l2" }).phaseType).toBe("develop");
  });

  it("normalizes a snake_case branch row and defaults kind", () => {
    const row = {
      id: "b1",
      project_id: "p1",
      from_thread_id: "t1",
      to_thread_id: "t2",
      at_node_id: "s1",
      kind: "merge",
    };
    expect(normalizeBranch(row)).toEqual({
      id: "b1",
      projectId: "p1",
      fromThreadId: "t1",
      toThreadId: "t2",
      atNodeId: "s1",
      kind: "merge",
      semanticKey: "t1|t2|s1|merge",
      version: 0,
      createdAt: "",
      updatedAt: "",
    });
    // camelCase（invoke 戻り値）も受ける
    expect(
      normalizeBranch({ id: "b2", fromThreadId: "tA", toThreadId: "tB" }),
    ).toMatchObject({ fromThreadId: "tA", toThreadId: "tB", kind: "branch" });
  });
});
