// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

import { debugLog } from "@/lib/debugLog";
import { invoke } from "@/lib/tauri";
import { createCanonicalWriteContext } from "@/features/native-writes/writeContext";

import {
  createNode,
  deleteNode,
  findNodeIdBySourceUri,
  getNode,
  historyWriteContext,
  loadTreeNodeRestoreSnapshot,
  treeWriteReceipt,
  updateNode,
} from "./api";

// DR-UND-1: the renderer wrapper, against the real browser mock (which mirrors
// the Native writer): the row read before a delete, put back by an Undo.
describe("Tree delete Undo restores the database row", () => {
  const COLUMNS = [
    "parentId",
    "synopsis",
    "intent",
    "storyTimeOrder",
    "storyTimeLabel",
    "povCharacterId",
    "locationId",
    "contextMode",
    "aliases",
    "excludedAliases",
    "content",
    "unplacedBeatsDoc",
    "unplacedBeatPreview",
    "placedBeatPreview",
    "sourceUri",
    "sourceMtime",
    "createdAt",
    "chronicleStartTime",
    "chronicleStartMinute",
    "chronicleStartGranularity",
    "chronicleEndTime",
    "chronicleEndMinute",
    "chronicleEndGranularity",
    "chroniclePrecision",
  ] as const;

  async function seeded(nodeType: "scene" | "note") {
    const id = `tree-restore-${nodeType}-${crypto.randomUUID()}`;
    await createNode({
      id,
      projectId: "default-project",
      parentId: null,
      nodeType,
      title: "Node",
      sortOrder: "z9",
    });
    if (nodeType === "scene") {
      await updateNode(id, {
        storyTimeOrder: "b3",
        storyTimeLabel: "night",
        chronicleStartTime: 100,
        chronicleStartMinute: 540,
        chronicleStartGranularity: "time",
        chronicleEndTime: 101,
        chronicleEndGranularity: "day",
        chroniclePrecision: "approx",
        content: '{"type":"doc","edited":true}',
      });
    } else {
      await updateNode(id, {
        contextMode: "hidden",
        aliases: '["a"]',
        excludedAliases: '["b"]',
        content: '{"type":"doc","edited":true}',
      });
    }
    return { id };
  }

  it("reads the columns the create payload does not carry, from the database", async () => {
    const { id } = await seeded("note");
    const snapshot = await loadTreeNodeRestoreSnapshot(id);
    expect(snapshot).toMatchObject({
      content: '{"type":"doc","edited":true}',
      sourceUri: null,
      sourceMtime: null,
      restoreState: {
        contextMode: "hidden",
        aliases: '["a"]',
        excludedAliases: '["b"]',
      },
    });
    // NULL columns are left out, not sent as null.
    expect(snapshot!.restoreState).not.toHaveProperty("povCharacterId");
    expect(snapshot!.restoreState).not.toHaveProperty("unplacedBeatPreview");
    expect(await loadTreeNodeRestoreSnapshot("no-such-node")).toBeNull();
  });

  it.each(["scene", "note"] as const)(
    "an Undo of a %s with that snapshot returns the row to what it was before the delete",
    async (nodeType) => {
      const { id } = await seeded(nodeType);
      const before = await getNode(id);
      const snapshot = (await loadTreeNodeRestoreSnapshot(id))!;
      const receipt = treeWriteReceipt(
        await deleteNode(id, "default-project", {}),
      );
      expect(await getNode(id)).toBeUndefined();
      // The delete's own receipt names the journal the Undo replays.
      const deleteReceipt = receipt!;

      const restored = await createNode(
        {
          id,
          projectId: "default-project",
          parentId: undefined,
          nodeType,
          title: "Node",
          sortOrder: "z9",
          content: snapshot.content,
        },
        {
          writeContext: historyWriteContext("undo", deleteReceipt),
          restoreState: snapshot.restoreState,
        },
      );
      const after = await getNode(id);
      for (const column of COLUMNS) {
        expect(after![column], column).toEqual(before![column]);
      }
      // version is not restored (the Source token must not return to an earlier value).
      expect(restored).toMatchObject({ id, version: 0 });
      expect(after!.storyTimeOrder).toBe(nodeType === "scene" ? "b3" : null);
      expect(after!.contextMode).toBe(nodeType === "note" ? "hidden" : null);
    },
  );

  it("sends the date range as one group, and only when it is not the default", async () => {
    const scene = await seeded("scene");
    const withRange = (await loadTreeNodeRestoreSnapshot(scene.id))!;
    expect(withRange.restoreState).toMatchObject({
      chronicleStartTime: 100,
      chronicleStartMinute: 540,
      chronicleStartGranularity: "time",
      chronicleEndTime: 101,
      chronicleEndGranularity: "day",
      chroniclePrecision: "approx",
    });
    // NULL day or minute is left out (the INSERT's default is NULL).
    expect(withRange.restoreState).not.toHaveProperty("chronicleEndMinute");

    const note = await seeded("note");
    const noRange = (await loadTreeNodeRestoreSnapshot(note.id))!;
    for (const key of Object.keys(noRange.restoreState)) {
      expect(key.startsWith("chronicle"), key).toBe(false);
    }
  });

  // The external-file link (P2-1 of the review): what actually happens in the
  // two orders, against the real create/delete writers.
  describe("an external-file Scene", () => {
    async function mountScene(uri: string) {
      const id = `tree-mount-${crypto.randomUUID()}`;
      await createNode({
        id,
        projectId: "default-project",
        parentId: null,
        nodeType: "scene",
        title: "Chapter",
        sortOrder: "z9",
        sourceUri: uri,
        sourceMtime: "2026-01-01T00:00:00Z",
      });
      const snapshot = (await loadTreeNodeRestoreSnapshot(id))!;
      const receipt = treeWriteReceipt(
        await deleteNode(id, "default-project", {}),
      )!;
      return { id, snapshot, receipt };
    }

    function undoCreate(
      id: string,
      snapshot: NonNullable<
        Awaited<ReturnType<typeof loadTreeNodeRestoreSnapshot>>
      >,
      receipt: NonNullable<ReturnType<typeof treeWriteReceipt>>,
      withSource: boolean,
    ) {
      return createNode(
        {
          id,
          projectId: "default-project",
          parentId: undefined,
          nodeType: "scene",
          title: "Chapter",
          sortOrder: "z9",
          content: snapshot.content,
          ...(withSource
            ? {
                sourceUri: snapshot.sourceUri,
                sourceMtime: snapshot.sourceMtime,
              }
            : {}),
        },
        {
          writeContext: historyWriteContext("undo", receipt),
          restoreState: snapshot.restoreState,
        },
      );
    }

    it("(1) delete, then undo at once: nothing else holds the file, so the link comes back", async () => {
      const uri = `external-root://mount/${crypto.randomUUID()}.md`;
      const { id, snapshot, receipt } = await mountScene(uri);
      expect(
        await findNodeIdBySourceUri("default-project", uri, id),
      ).toBeNull();
      await undoCreate(id, snapshot, receipt, true);
      expect((await getNode(id))!.sourceUri).toBe(uri);
      expect(await findNodeIdBySourceUri("default-project", uri, "other")).toBe(
        id,
      );
    });

    it("(2) delete, a reconcile makes a node for the file, then undo: the lookup sees it, and restoring the link anyway would leave two Scenes on one file", async () => {
      const uri = `external-root://mount/${crypto.randomUUID()}.md`;
      const { id, snapshot, receipt } = await mountScene(uri);
      const reconciledId = `tree-reconciled-${crypto.randomUUID()}`;
      await createNode({
        id: reconciledId,
        projectId: "default-project",
        parentId: null,
        nodeType: "scene",
        title: "Chapter",
        sortOrder: "z9",
        sourceUri: uri,
        sourceMtime: "2026-01-02T00:00:00Z",
      });
      expect(await findNodeIdBySourceUri("default-project", uri, id)).toBe(
        reconciledId,
      );
      // The store leaves the link off in this case: one Scene on the file.
      await undoCreate(id, snapshot, receipt, false);
      expect((await getNode(id))!.sourceUri).toBeNull();
      expect(
        await findNodeIdBySourceUri("default-project", uri, reconciledId),
      ).toBeNull();
    });

    it("the hazard the rule avoids: without it two rows share the source (no unique constraint)", async () => {
      const uri = `external-root://mount/${crypto.randomUUID()}.md`;
      const { id, snapshot, receipt } = await mountScene(uri);
      const reconciledId = `tree-reconciled-${crypto.randomUUID()}`;
      await createNode({
        id: reconciledId,
        projectId: "default-project",
        parentId: null,
        nodeType: "scene",
        title: "Chapter",
        sortOrder: "z9",
        sourceUri: uri,
      });
      await undoCreate(id, snapshot, receipt, true);
      expect((await getNode(id))!.sourceUri).toBe(uri);
      expect((await getNode(reconciledId))!.sourceUri).toBe(uri);
    });
  });

  // A legacy row: tree_node_patch writes the date columns unchecked, so a row can
  // hold a reversed range or values of an unexpected shape. Its Undo must still
  // succeed.
  describe("a legacy date range", () => {
    // `tree_node_patch` writes the date columns with no check (the date editors
    // validate before they call `temporal_scene_patch`), exactly as a legacy row
    // came to hold them.
    async function legacyScene(patch: Record<string, unknown>) {
      const id = `tree-legacy-${crypto.randomUUID()}`;
      await createNode({
        id,
        projectId: "default-project",
        parentId: null,
        nodeType: "scene",
        title: "Legacy",
        sortOrder: "z9",
      });
      await invoke("tree_node_patch", {
        payload: {
          ...createCanonicalWriteContext(),
          projectId: "default-project",
          nodeId: id,
          patch,
          baseVersion: 0,
          bumpVersion: false,
          updatedAt: "2026-08-24T00:00:00.000Z",
        },
      });
      return id;
    }

    async function undoWith(id: string) {
      const before = (await getNode(id))!;
      const snapshot = (await loadTreeNodeRestoreSnapshot(id))!;
      const receipt = treeWriteReceipt(
        await deleteNode(id, "default-project", {}),
      )!;
      await createNode(
        {
          id,
          projectId: "default-project",
          parentId: undefined,
          nodeType: "scene",
          title: "Legacy",
          sortOrder: "z9",
          content: snapshot.content,
        },
        {
          writeContext: historyWriteContext("undo", receipt),
          restoreState: snapshot.restoreState,
        },
      );
      return { before, snapshot, after: (await getNode(id))! };
    }

    it("a reversed range and a time without a minute are sent as they are, and the Undo restores them", async () => {
      const warn = vi.spyOn(debugLog, "warn").mockImplementation(() => {});
      const id = await legacyScene({
        chronicleStartTime: 10,
        chronicleStartGranularity: "day",
        chronicleEndTime: 9,
        chronicleEndGranularity: "day",
        chroniclePrecision: "approx",
      });
      const { snapshot, after } = await undoWith(id);
      expect(snapshot.restoreState).toMatchObject({
        chronicleStartTime: 10,
        chronicleEndTime: 9,
      });
      expect(after).toMatchObject({
        chronicleStartTime: 10,
        chronicleEndTime: 9,
        chronicleStartGranularity: "day",
        chroniclePrecision: "approx",
      });

      const timeId = await legacyScene({
        chronicleStartTime: 5,
        chronicleStartGranularity: "time",
      });
      const timeRun = await undoWith(timeId);
      expect(timeRun.after).toMatchObject({
        chronicleStartTime: 5,
        chronicleStartMinute: null,
        chronicleStartGranularity: "time",
      });
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("an unknown granularity is not sent: the Undo succeeds, the date alone is left unset, and it is logged", async () => {
      for (const patch of [
        { chronicleStartTime: 5, chronicleStartGranularity: "century" },
      ]) {
        const warn = vi.spyOn(debugLog, "warn").mockImplementation(() => {});
        const id = await legacyScene(patch);
        const { snapshot, after } = await undoWith(id);
        for (const key of Object.keys(snapshot.restoreState)) {
          expect(key.startsWith("chronicle"), key).toBe(false);
        }
        expect(after).toMatchObject({
          chronicleStartTime: null,
          chronicleStartGranularity: "none",
          chroniclePrecision: "exact",
        });
        expect(warn).toHaveBeenCalledWith(
          "tree",
          "undo date range not restorable",
          expect.stringContaining(id),
        );
        warn.mockRestore();
      }
    });
  });

  it("an ordinary create does not send restoreState", async () => {
    const id = `tree-plain-${crypto.randomUUID()}`;
    const plain = await createNode({
      id,
      projectId: "default-project",
      parentId: null,
      nodeType: "scene",
      title: "Plain",
      sortOrder: "z9",
    });
    expect(plain).toMatchObject({ id, intent: null });
  });
});
