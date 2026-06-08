import { getSchema } from "@tiptap/core";
import { Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { getEditorExtensions } from "@/features/editor/extensions";
import { loadSceneContent } from "@/features/tree/api";
import { persistSceneBody } from "@/features/editor/persistSceneBody";
import { agentAcceptProseStage } from "@/features/agent-writes/prose";
import { useTreeStore } from "@/features/tree/treeStore";
import { useTabStore } from "@/features/editor/tabStore";
import { useSceneContentStore } from "@/features/editor/sceneContentStore";
import { isFileBackedNode } from "@/features/external-mount/externalRootStore";
import type { PendingProseProposal } from "@/features/agent-writes/proseStagingStore";

// Sentinel source-group for setLiveContent: out of band of every real editor
// group (panes use 0/1), so no open editor filters our resync out as "its own".
const RESYNC_GROUP = -1;

export type AutoApplySkipReason =
  | "unsupported-mode"
  | "empty-text"
  | "scene-missing"
  | "file-backed";

export interface AutoApplyOutcome {
  applied: boolean;
  reason?: AutoApplySkipReason;
}

let cachedSchema: Schema | null = null;
function getDocSchema(): Schema {
  if (!cachedSchema) {
    // The mention stub is load-bearing: without it the schema omits the mention
    // node and `Node.fromJSON` throws on any doc containing an @mention.
    cachedSchema = getSchema(
      getEditorExtensions({ setMentionPopup: () => {} }),
    );
  }
  return cachedSchema;
}

function buildDoc(schema: Schema, raw: string): ProseMirrorNode {
  const t = raw.trim();
  if (t && t.startsWith("{")) {
    try {
      return ProseMirrorNode.fromJSON(schema, JSON.parse(t));
    } catch {
      // malformed stored content → fall through to an empty doc
    }
  }
  const empty = schema.topNodeType.createAndFill();
  if (!empty) throw new Error("failed to build empty ProseMirror doc");
  return empty;
}

function openSceneIds(): Set<string> {
  const s = useTabStore.getState();
  return new Set([
    ...s.tabs.map((t) => t.nodeId),
    ...s.secondaryTabs.map((t) => t.nodeId),
  ]);
}

/**
 * Apply a *proposed* prose-staging row to the scene body off-screen (no mounted
 * editor) and finalize the staging row. This is the headless analogue of the
 * human-accept path: it mirrors that path's exact primitives — `tr.insertText`
 * at end-of-doc plus an `authorship` (`source='ai'`) mark over the inserted
 * `[pos, pos+text.length)` span — on a schema-only ProseMirror `EditorState`
 * (no DOM view), then funnels persistence through {@link persistSceneBody} so
 * the full side-effect cascade (authorship_spans, mentions, semantic re-index,
 * …) fires identically to a live save.
 *
 * v1 supports APPEND only. `insert` needs a live caret position and `replace`
 * needs live doc ranges, neither of which can be reconstructed headlessly, so
 * those rows are left `proposed` for a human to review in the diff UI.
 *
 * Ordering note: the staging row is finalized (`accepted`) BEFORE the body
 * write. This trades a recoverable lost-write (write fails after the flip → the
 * agent can re-propose) against the far worse runaway duplication that a
 * write-first ordering would cause if the flip kept failing and the still-
 * `proposed` row were re-applied on every poll.
 */
export async function autoApplyProseProposal(
  proposal: PendingProseProposal,
): Promise<AutoApplyOutcome> {
  const { stagingId, sceneId, text, mode } = proposal;

  if (mode !== "append") return { applied: false, reason: "unsupported-mode" };
  if (!text.trim()) return { applied: false, reason: "empty-text" };

  const node = useTreeStore.getState().nodes.find((n) => n.id === sceneId);
  if (!node) return { applied: false, reason: "scene-missing" };
  if (isFileBackedNode(node.sourceUri)) {
    return { applied: false, reason: "file-backed" };
  }

  const schema = getDocSchema();
  const raw = await loadSceneContent(sceneId);
  const doc = buildDoc(schema, raw);

  // Append the prose as new paragraph node(s) with the `authorship`
  // (source='ai') mark BAKED INTO the text nodes. Marking by node construction —
  // rather than insertText + an addMark range — guarantees the mark covers
  // exactly the inserted text: inserting at the doc-end boundary remaps the
  // position into the last block, which makes a `pos+text.length` range off by
  // one. Splitting on "\n" turns a multi-paragraph draft into real paragraphs.
  const paragraphType = schema.nodes["paragraph"];
  if (!paragraphType) throw new Error("schema is missing a paragraph node");
  // model is unknown for an external MCP/agent write, so it is left null (honest
  // provenance) rather than spoofing a model id.
  const authorship = schema.marks["authorship"];
  const marks = authorship
    ? [authorship.create({ source: "ai", model: null, traceId: null })]
    : [];
  const paragraphs = text
    .split("\n")
    .map((line) =>
      paragraphType.create(null, line ? schema.text(line, marks) : null),
    );

  const state = EditorState.create({ schema, doc });
  const tr = state.tr;
  tr.insert(state.doc.content.size, paragraphs);
  const nextDoc = state.apply(tr).doc;

  // Finalize first (cross-poll dedup guard — see ordering note above).
  await agentAcceptProseStage(stagingId);

  await persistSceneBody(sceneId, nextDoc);

  // If the scene is open in a pane, mirror the persisted doc into the live
  // editor so its next autosave does not clobber this write (lost-update guard).
  if (openSceneIds().has(sceneId)) {
    useSceneContentStore
      .getState()
      .setLiveContent(sceneId, nextDoc.toJSON(), RESYNC_GROUP);
  }

  return { applied: true };
}
