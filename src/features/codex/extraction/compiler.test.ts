import { describe, expect, it } from "vitest";
import {
  compileCreateCodexEntryOperation,
  compileCreateCodexRelationOperation,
  compilePatchCodexEntryOperation,
  emptyCommitMap,
  registerCreatedBinding,
  registerExistingBinding,
} from "./compiler";

describe("codex extraction compiler", () => {
  it("compiles create with parentId null and empty content", () => {
    const op = compileCreateCodexEntryOperation({
      narrativeEntityId: "ent:alice",
      typeSlug: "character",
      name: "Alice",
      aliases: ["灰の目"],
      summary: null,
      entryId: "entry-1",
    });
    expect(op.kind).toBe("codex.entry.create");
    expect(op.payload.parentId).toBeNull();
    expect(op.payload.content).toBe('{"type":"doc","content":[]}');
  });

  it("returns null patch when existing binding has no domain writes", () => {
    const op = compilePatchCodexEntryOperation({
      narrativeEntityId: "ent:alice",
      entryId: "entry-1",
      baseVersion: 2,
      aliasesToAdd: [],
      existingAliases: ["旧"],
      summary: { kind: "leave" },
    });
    expect(op).toBeNull();
  });

  it("resolves relation endpoints via CommitMap and builds semantic key", () => {
    let map = emptyCommitMap();
    map = registerExistingBinding(map, "ent:a", "codex-a");
    map = registerCreatedBinding(map, "ent:b", "codex-b");
    const op = compileCreateCodexRelationOperation(
      {
        payload: {
          subjectEntityId: "ent:a",
          objectEntityId: "ent:b",
          relation: {
            relationType: "friend",
            directionality: "symmetric",
            forwardLabel: "友人",
            inverseLabel: "友人",
          },
          validity: "current",
        },
      },
      map,
      { projectId: "project-1", relationId: "rel-1" },
    );
    expect(op.payload.fromCodexId).toBe("codex-a");
    expect(op.payload.toCodexId).toBe("codex-b");
    expect(op.payload.semanticKey).toContain("project-1");
    expect(op.payload.semanticKey?.startsWith("s\t")).toBe(true);
  });

  it("allows idempotent re-register of the same binding", () => {
    let map = emptyCommitMap();
    map = registerExistingBinding(map, "ent:a", "codex-a");
    map = registerExistingBinding(map, "ent:a", "codex-a");
    map = registerCreatedBinding(map, "ent:b", "codex-b");
    map = registerCreatedBinding(map, "ent:b", "codex-b");
    expect(map.entityBindings["ent:a"]?.codexEntryId).toBe("codex-a");
    expect(map.entityBindings["ent:b"]?.codexEntryId).toBe("codex-b");
  });

  it("throws NEX_COMMIT_MAP_CONFLICT when rebound to a different entry", () => {
    let map = emptyCommitMap();
    map = registerExistingBinding(map, "ent:a", "codex-a");
    expect(() => registerExistingBinding(map, "ent:a", "codex-other")).toThrow(
      /NEX_COMMIT_MAP_CONFLICT/,
    );
    expect(() => registerCreatedBinding(map, "ent:a", "codex-created")).toThrow(
      /NEX_COMMIT_MAP_CONFLICT/,
    );
  });
});
