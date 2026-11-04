import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@/lib/tauri", () => ({ invoke: invokeMock }));

import {
  applyScopeDefaultToScenes,
  countScopeMarkers,
} from "./applyScopeDefault";
import { chapterSceneIds } from "./chapterScenes";

const mainLine = {
  timeline: { kind: "exact", ref: "timeline:main" },
  worldline: { kind: "exact", ref: "worldline:prime" },
  narrativeLayer: { kind: "exact", ref: "layer:manuscript" },
};

function scopeRead(sceneId: string, marker: string, version = 1) {
  return {
    registry: {},
    registryRevision: 1,
    binding: {
      schemaVersion: 1,
      projectId: "project-1",
      sceneId,
      sceneIncarnationId: `inc-${sceneId}`,
      compatibilityMarker: marker,
      queryIdentity: {},
      materialConstraint: {},
      knowledgeHolder: { kind: "reader" },
      audience: { kind: "reader" },
      version,
      sourceToken: "token",
      updatedAt: "2026-11-04T00:00:00.000Z",
    },
  };
}

function backend(
  markers: Record<string, string>,
  options: { defaultState?: "set" | "none"; failUpdate?: string[] } = {},
) {
  invokeMock.mockImplementation(
    async (command: string, args: Record<string, unknown>) => {
      if (command === "narrative_scope_project_default_read") {
        return {
          projectId: "project-1",
          default:
            options.defaultState === "none"
              ? { state: "none" }
              : {
                  state: "set",
                  queryIdentity: mainLine,
                  materialConstraint: mainLine,
                },
          version: 1,
          sourceToken: null,
          updatedAt: null,
        };
      }
      if (command === "narrative_scene_scope_read") {
        const sceneId = args.sceneId as string;
        if (!(sceneId in markers)) throw new Error("scene is gone");
        return scopeRead(sceneId, markers[sceneId]!, 4);
      }
      if (command === "narrative_scene_scope_update") {
        const payload = args.payload as { sceneId: string };
        if (options.failUpdate?.includes(payload.sceneId))
          throw new Error("NEX_SCENE_SCOPE_VERSION_MISMATCH");
        return {};
      }
      throw new Error(`unexpected ${command}`);
    },
  );
}

const input = {
  workspacePath: "/workspace",
  projectId: "project-1",
};

describe("applyScopeDefaultToScenes（SDEF/1 R14・R16・R18、DR-SDEF-30）", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("writes only unset Scenes with the default, never touches explicit ones, and counts a partial result", async () => {
    backend(
      {
        a: "unknown",
        b: "explicit",
        c: "legacy-absent",
        d: "unknown",
        e: "unknown",
      },
      { failUpdate: ["e"] },
    );
    const result = await applyScopeDefaultToScenes({
      ...input,
      sceneIds: ["a", "b", "c", "d", "e", "missing"],
      target: "unknown",
    });
    expect(result).toEqual({
      status: "done",
      applied: 2,
      skipped: 2,
      failed: 2,
    });
    const updates = invokeMock.mock.calls.filter(
      ([command]) => command === "narrative_scene_scope_update",
    );
    expect(updates.map(([, args]) => args.payload.sceneId)).toEqual([
      "a",
      "d",
      "e",
    ]);
    expect(updates[0]![1]).toEqual({
      expectedWorkspacePath: "/workspace",
      payload: expect.objectContaining({
        projectId: "project-1",
        sceneId: "a",
        baseVersion: 4,
        scope: {
          schemaVersion: 1,
          compatibilityMarker: "explicit",
          queryIdentity: mainLine,
          materialConstraint: mainLine,
          knowledgeHolder: { kind: "reader" },
          audience: { kind: "reader" },
        },
      }),
    });
  });

  it("applies to earlier Scenes only through the separate target", async () => {
    backend({ a: "unknown", c: "legacy-absent" });
    const result = await applyScopeDefaultToScenes({
      ...input,
      sceneIds: ["a", "c"],
      target: "legacy-absent",
    });
    expect(result).toMatchObject({ applied: 1, skipped: 1 });
    const updates = invokeMock.mock.calls.filter(
      ([command]) => command === "narrative_scene_scope_update",
    );
    expect(updates.map(([, args]) => args.payload.sceneId)).toEqual(["c"]);
  });

  it("writes nothing when the default moved after the confirmation (PR-2 review P2-1)", async () => {
    backend({ a: "unknown" });
    await expect(
      applyScopeDefaultToScenes({
        ...input,
        sceneIds: ["a"],
        target: "unknown",
        expectedVersion: 0,
      }),
    ).resolves.toEqual({ status: "default-changed" });
    expect(
      invokeMock.mock.calls.some(
        ([command]) => command === "narrative_scene_scope_update",
      ),
    ).toBe(false);
  });

  it("writes nothing without a set default", async () => {
    backend({ a: "unknown" }, { defaultState: "none" });
    await expect(
      applyScopeDefaultToScenes({
        ...input,
        sceneIds: ["a"],
        target: "unknown",
      }),
    ).resolves.toEqual({ status: "no-default" });
    expect(
      invokeMock.mock.calls.some(
        ([command]) => command === "narrative_scene_scope_update",
      ),
    ).toBe(false);
  });

  it("counts the markers before asking", async () => {
    backend({ a: "unknown", b: "explicit", c: "legacy-absent" });
    await expect(
      countScopeMarkers({ ...input, sceneIds: ["a", "b", "c", "gone"] }),
    ).resolves.toEqual({ unknown: 1, legacyAbsent: 1, explicit: 1, failed: 1 });
  });
});

describe("chapterSceneIds", () => {
  it("collects every Scene under the chapter at any depth", () => {
    const nodes = [
      { id: "ch", parentId: null, nodeType: "folder" },
      { id: "s1", parentId: "ch", nodeType: "scene" },
      { id: "sub", parentId: "ch", nodeType: "folder" },
      { id: "s2", parentId: "sub", nodeType: "scene" },
      { id: "n1", parentId: "sub", nodeType: "note" },
      { id: "other", parentId: null, nodeType: "scene" },
    ];
    expect(chapterSceneIds(nodes, "ch").sort()).toEqual(["s1", "s2"]);
  });
});
