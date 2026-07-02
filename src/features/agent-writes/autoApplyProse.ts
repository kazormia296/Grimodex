import { getSchema } from "@tiptap/core";
import { Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { getEditorExtensions } from "@/features/editor/extensions";
import { loadSceneContent, getSceneVersion } from "@/features/tree/api";
import { saveScene } from "@/features/editor/editorSaveRegistry";
import { persistSceneBody } from "@/features/editor/persistSceneBody";
import { agentAcceptProseStage } from "@/features/agent-writes/prose";
import { recordChangeEvent } from "@/features/timelapse/recorder";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  useSceneContentStore,
  hasLiveContentSubscriber,
} from "@/features/editor/sceneContentStore";
import { isFileBackedNode } from "@/features/external-mount/externalRootStore";
import { useExternalWriteStore } from "@/features/concurrency/externalWriteStore";
import type { PendingProseProposal } from "@/features/agent-writes/proseStagingStore";

// Sentinel source-group for setLiveContent: out of band of every real editor
// group (panes use 0/1), so no open editor filters our resync out as "its own".
const RESYNC_GROUP = -1;

export type AutoApplySkipReason =
  | "unsupported-mode"
  | "empty-text"
  | "scene-missing"
  | "file-backed"
  | "content-unparseable"
  | "anchor-not-found"
  | "anchor-ambiguous"
  | "stale-base-version";

export interface AutoApplyOutcome {
  applied: boolean;
  reason?: AutoApplySkipReason;
}

export type AnchorResolve =
  | { pos: number }
  | { error: "anchor-not-found" | "anchor-ambiguous" };

/**
 * Resolve a content anchor to a top-level block boundary for headless insertion.
 * Finds the single top-level block whose text contains `anchorText` and returns
 * the position before/after it. Zero or multiple matches → an error (the caller
 * must NOT guess; it leaves the proposal for manual review). Block boundaries
 * are valid insertion points for the block paragraphs the applier builds.
 */
export function resolveAnchorInsertPos(
  doc: ProseMirrorNode,
  anchorText: string,
  position: "before" | "after",
): AnchorResolve {
  const needle = anchorText.trim();
  if (!needle) return { error: "anchor-not-found" };
  let count = 0;
  let offset = 0;
  let size = 0;
  doc.forEach((node, nodeOffset) => {
    if (node.textContent.includes(needle)) {
      count += 1;
      offset = nodeOffset;
      size = node.nodeSize;
    }
  });
  if (count === 0) return { error: "anchor-not-found" };
  if (count > 1) return { error: "anchor-ambiguous" };
  return { pos: position === "before" ? offset : offset + size };
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

/**
 * Build the scene doc to append to.
 *
 * Returns null when the stored content is non-empty but unparseable. The caller
 * MUST abort then: this is an UNATTENDED writer, so building a fresh empty doc
 * and persisting would silently DESTROY the existing (just unreadable-here)
 * prose with no undo and no retry. Only genuinely empty content yields a fresh
 * empty doc to append into.
 */
function buildDoc(schema: Schema, raw: string): ProseMirrorNode | null {
  const t = raw.trim();
  const isEmpty = t === "" || t === "{}" || t === "[]";
  if (!isEmpty) {
    // non-JSON, or JSON the schema rejects → do NOT clobber; bail to the caller
    if (!t.startsWith("{")) return null;
    try {
      return ProseMirrorNode.fromJSON(schema, JSON.parse(t));
    } catch {
      return null;
    }
  }
  const empty = schema.topNodeType.createAndFill();
  if (!empty) throw new Error("failed to build empty ProseMirror doc");
  return empty;
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
 * Supports `append` (end of scene) and anchored `insert` (mid-scene, positioned
 * by `anchorText` content). Plain `insert` (live caret) and `replace` (live doc
 * range) can't be reconstructed headlessly, so those rows are left `proposed`
 * for a human to review in the diff UI.
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
  const { stagingId, sceneId, text, mode, anchorText } = proposal;

  // Headless-appliable: append (end of scene) or anchored insert (mid-scene by
  // content). Plain insert (live cursor) and replace (live range) are not.
  const anchored = mode === "insert" && !!anchorText;
  if (mode !== "append" && !anchored) {
    return { applied: false, reason: "unsupported-mode" };
  }
  if (!text.trim()) return { applied: false, reason: "empty-text" };

  const node = useTreeStore.getState().nodes.find((n) => n.id === sceneId);
  if (!node) return { applied: false, reason: "scene-missing" };
  if (isFileBackedNode(node.sourceUri)) {
    return { applied: false, reason: "file-backed" };
  }

  const schema = getDocSchema();
  // Flush any pending debounced autosave BEFORE reading the DB: if the scene is
  // open with unsaved live edits, appending to the stale DB body and resyncing
  // (below) would silently drop the user's latest typing. saveScene is a no-op
  // when no editor is mounted (the scene cannot be dirty then).
  await saveScene(sceneId);
  const raw = await loadSceneContent(sceneId);

  // Stale 検知: propose 時点の tree_nodes.version (prose_staging.base_version)
  // と現在の version を突き合わせる。saveSceneContent が本文書き込みごとに
  // version を bump する (tree/api.ts) ので、propose 後に human / AI / 復元系の
  // 保存が挟まっていれば不一致になる。不一致なら適用せず `proposed` のまま残し、
  // 既存の scene 用 conflict 導線 (externalWriteStore → ExternalEditConflictBanner)
  // に流す。呼び出し側 (autoAcceptFeed → externalWriteFeed) は not-applied を
  // 手動 diff レビューへ fallback させる。
  //
  // 意図した安全側の挙動 (無人 writer は疑わしければ書かない):
  //  - 直前の saveScene() flush 自体も version を bump するため、シーンが live
  //    editor で開かれている間の自動適用はここでブロックされ、手動レビューに
  //    落ちる (headless 適用が素通りするのはシーンを誰も開いていない時)。
  //  - AI 適用自身も saveSceneContent 経由で bump するので、1 件目の適用前に
  //    propose された 2 件目は base が古くなりブロックされる。
  // baseVersion の無い proposal (in-app 直接 enqueue = diff UI 専用) は比較
  // 不能なので従来動作を維持する。
  if (proposal.baseVersion !== undefined) {
    const currentVersion = await getSceneVersion(sceneId);
    if (currentVersion !== proposal.baseVersion) {
      console.warn(
        `[autoApplyProse] stale base_version for scene ${sceneId}: ` +
          `proposed at v${proposal.baseVersion}, scene is now v${currentVersion}; ` +
          "leaving proposal for manual review",
      );
      useExternalWriteStore.getState().pushConflict({
        sceneId,
        domain: "prose",
        opType: "prose.stale",
        entityId: stagingId,
      });
      return { applied: false, reason: "stale-base-version" };
    }
  }

  const doc = buildDoc(schema, raw);
  // Fail safe: never replace unreadable-but-present prose with an empty doc.
  if (!doc) return { applied: false, reason: "content-unparseable" };

  // Resolve the insertion position: end-of-doc for append, or the anchored
  // block boundary for a content-anchored insert (fail safe on 0/multiple
  // matches — never guess where to splice an unattended write).
  let insertPos: number;
  if (anchored) {
    const resolved = resolveAnchorInsertPos(
      doc,
      anchorText!,
      proposal.anchorPosition ?? "after",
    );
    if ("error" in resolved) return { applied: false, reason: resolved.error };
    insertPos = resolved.pos;
  } else {
    insertPos = doc.content.size;
  }

  // Build the prose as new paragraph node(s) with the `authorship`
  // (source='ai') mark BAKED INTO the text nodes. Marking by node construction —
  // rather than insertText + an addMark range — guarantees the mark covers
  // exactly the inserted text (an inserted position can remap, making a
  // `pos+text.length` range off by one). Splitting on "\n" turns a
  // multi-paragraph draft into real paragraphs.
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
  tr.insert(insertPos, paragraphs);
  const nextDoc = state.apply(tr).doc;

  // Finalize first (cross-poll dedup guard — see ordering note above).
  await agentAcceptProseStage(stagingId);

  await persistSceneBody(sceneId, nextDoc);

  // Timelapse: record the append as a doc.step so the writing-replay chain stays
  // consistent. A live editor emits this via onTransaction; a headless write
  // must record it explicitly or an unrecorded content jump desyncs replay at
  // the next human edit (the cursor halts on the first unapplicable step).
  recordChangeEvent({
    domain: "editor",
    opType: "doc.step",
    sceneId,
    entityType: "scene",
    entityId: sceneId,
    payload: { steps: tr.steps.map((s) => s.toJSON()) },
  });

  // If any live editor shows this scene (tab pane or linear-mode block),
  // mirror the persisted doc into it so its next autosave does not clobber
  // this write (lost-update guard). Subscriber check, NOT a tab-list check:
  // linear-mode editors have no tab.
  if (hasLiveContentSubscriber(sceneId)) {
    useSceneContentStore
      .getState()
      .setLiveContent(sceneId, nextDoc.toJSON(), RESYNC_GROUP);
  }

  return { applied: true };
}
