import { describe, it, expect } from "vitest";
import { resolveScopeSessionKey } from "./chatScope";

describe("resolveScopeSessionKey", () => {
  it("scene scope uses active scene nodeId", () => {
    expect(resolveScopeSessionKey("scene", "scene-1", null)).toEqual({
      nodeId: "scene-1",
      codexAnchorId: undefined,
      snippetAnchorId: undefined,
    });
  });

  it("folder scope uses scope anchor as nodeId", () => {
    expect(resolveScopeSessionKey("folder", "scene-1", "folder-a")).toEqual({
      nodeId: "folder-a",
      codexAnchorId: undefined,
      snippetAnchorId: undefined,
    });
  });

  it("project scope uses null nodeId", () => {
    expect(resolveScopeSessionKey("project", "scene-1", null)).toEqual({
      nodeId: null,
      codexAnchorId: undefined,
      snippetAnchorId: undefined,
    });
  });

  it("codex scope uses codexAnchorId without nodeId", () => {
    expect(resolveScopeSessionKey("codex", "scene-1", "codex-hero")).toEqual({
      nodeId: undefined,
      codexAnchorId: "codex-hero",
      snippetAnchorId: undefined,
    });
  });

  it("snippet scope uses snippetAnchorId without nodeId", () => {
    expect(resolveScopeSessionKey("snippet", "scene-1", "snip-1")).toEqual({
      nodeId: undefined,
      codexAnchorId: undefined,
      snippetAnchorId: "snip-1",
    });
  });

  it("snippet scope without anchor yields no session key", () => {
    // anchor 不在の snippet scope が project (nodeId: null) に化けると
    // プロジェクトスコープのセッション一覧を吸ってしまう。undefined を返すこと。
    expect(resolveScopeSessionKey("snippet", "scene-1", null)).toEqual({
      nodeId: undefined,
      codexAnchorId: undefined,
      snippetAnchorId: undefined,
    });
  });
});
