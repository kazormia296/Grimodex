// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import {
  createNode,
  deleteNode,
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
