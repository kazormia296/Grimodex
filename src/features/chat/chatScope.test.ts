import { describe, it, expect } from "vitest";
import { resolveScopeSessionKey } from "./chatScope";

describe("resolveScopeSessionKey", () => {
  it("scene scope uses active scene nodeId", () => {
    expect(resolveScopeSessionKey("scene", "scene-1", null)).toEqual({
      nodeId: "scene-1",
      codexAnchorId: undefined,
    });
  });

  it("folder scope uses scope anchor as nodeId", () => {
    expect(resolveScopeSessionKey("folder", "scene-1", "folder-a")).toEqual({
      nodeId: "folder-a",
      codexAnchorId: undefined,
    });
  });

  it("project scope uses null nodeId", () => {
    expect(resolveScopeSessionKey("project", "scene-1", null)).toEqual({
      nodeId: null,
      codexAnchorId: undefined,
    });
  });

  it("codex scope uses codexAnchorId without nodeId", () => {
    expect(resolveScopeSessionKey("codex", "scene-1", "codex-hero")).toEqual({
      nodeId: undefined,
      codexAnchorId: "codex-hero",
    });
  });
});
