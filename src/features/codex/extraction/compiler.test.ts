import { describe, expect, it } from "vitest";
import {
  compileCreateCodexEntryOperation,
  compileCreateCodexRelationOperation,
  compilePatchCodexEntryOperation,
  emptyCommitMap,
  registerCreatedBinding,
  registerExistingBinding,
} from "./compiler";
import { compileSetCodexBaseDetailOperation } from "./detailCompiler";
import {
  compileCreateCodexPhaseOperation,
  compilePatchCodexPhaseOperation,
} from "./phaseCompiler";
import { createSetCodexBaseDetailProposal } from "@/features/narrative-extraction/proposals/setCodexBaseDetailProposal";
import {
  bindExistingCodexPhaseProposal,
  createNewBindCodexPhaseProposal,
} from "@/features/narrative-extraction/proposals/bindCodexPhaseProposal";

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
});

describe("detailCompiler / phaseCompiler", () => {
  it("compiles base detail set with absent OCC via CommitMap", () => {
    let map = emptyCommitMap();
    map = registerCreatedBinding(map, "ent:alice", "entry-a");
    const proposal = createSetCodexBaseDetailProposal({
      narrativeEntityId: "ent:alice",
      definitionRef: "def:age",
      facetKey: "age",
      value: { kind: "text", text: "17" },
      temporalEligibility: "timeless",
      createId: () => "prop-base",
    });
    expect(proposal).not.toBeNull();
    const op = compileSetCodexBaseDetailOperation({
      proposal: proposal!,
      commitMap: map,
      resolveDefinitionId: (ref) => ref.replace("def:", "def-"),
      encodeValue: (value) => (value.kind === "text" ? value.text : null),
    });
    expect(op.kind).toBe("codex.detail.value.set");
    expect(op.payload.entryId).toBe("entry-a");
    expect(op.payload.definitionId).toBe("def-age");
    expect(op.payload.occ).toEqual({ kind: "absent" });
    expect(op.payload.value).toBe("17");
  });

  it("compiles phase create without content/context overrides", () => {
    let map = emptyCommitMap();
    map = registerExistingBinding(map, "ent:alice", "entry-a");
    const proposal = createNewBindCodexPhaseProposal(
      {
        narrativeEntityId: "ent:alice",
        anchorDocumentRef: "D000001",
        labelSuggestion: "開幕",
        detailOverrides: [
          {
            definitionRef: "def:role",
            write: { kind: "set", value: { kind: "text", text: "監察官" } },
          },
        ],
        binding: {
          kind: "create-new",
          phase: { label: "開幕", anchorDocumentRef: "D000001" },
        },
      },
      { createId: () => "prop-phase" },
    );
    const op = compileCreateCodexPhaseOperation({
      proposal,
      commitMap: map,
      phaseId: "phase-1",
      resolveDefinitionId: (ref) => ref.replace("def:", "def-"),
      encodeWrite: (_id, write) =>
        write.kind === "set" && write.value.kind === "text"
          ? write.value.text
          : null,
    });
    expect(op.kind).toBe("codex.phase.create");
    expect(op.payload.label).toBe("開幕");
    expect(op.payload.detailOverrides).toEqual([
      { definitionId: "def-role", value: "監察官" },
    ]);
    expect(
      Object.prototype.hasOwnProperty.call(op.payload, "contentOverride"),
    ).toBe(false);
  });

  it("compiles phase patch as exact-after aggregate", () => {
    const proposal = bindExistingCodexPhaseProposal(
      {
        narrativeEntityId: "ent:alice",
        anchorDocumentRef: "D000001",
        labelSuggestion: "更新",
        detailOverrides: [
          {
            definitionRef: "def:role",
            write: { kind: "set", value: { kind: "text", text: "新役割" } },
          },
          { definitionRef: "def:old", write: { kind: "inherit" } },
        ],
        binding: {
          kind: "bind-existing",
          phaseRef: "phase-existing",
          expectedVersion: 4,
        },
      },
      { createId: () => "prop-patch" },
    );
    const op = compilePatchCodexPhaseOperation({
      proposal,
      phaseId: "phase-existing",
      baseVersion: 4,
      existingOverrides: [
        { definitionId: "def-role", value: "旧" },
        { definitionId: "def-old", value: "消す" },
      ],
      resolveDefinitionId: (ref) => ref.replace("def:", "def-"),
      encodeWrite: (_id, write) =>
        write.kind === "set" && write.value.kind === "text"
          ? write.value.text
          : write.kind === "clear"
            ? null
            : undefined,
    });
    expect(op.kind).toBe("codex.phase.patch");
    expect(op.payload.baseVersion).toBe(4);
    expect(op.payload.detailOverrides).toEqual([
      { definitionId: "def-role", value: "新役割" },
    ]);
  });
});
