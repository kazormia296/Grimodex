import { describe, it, expect } from "vitest";
import { normalizeThread, normalizeLink } from "./api";

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
});
