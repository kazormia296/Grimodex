import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Mapping, StepMap } from "@tiptap/pm/transform";

const SCENE_BEAT_NODE_NAME = "sceneBeat";
const MAX_PREVIEW_BEATS = 8;
const MAX_PREVIEW_CHARS = 60;

export interface SceneBeatSnapshot {
  id: string;
  beatType: string;
  pov: string | null;
  content: unknown[];
  previewText: string;
  pos: number;
}

/**
 * Per-editor index of placed Beats. It is built once when a document is
 * loaded, then advanced with ProseMirror step maps instead of walking the
 * complete document after every Beat edit.
 */
export interface SceneBeatIndex {
  readonly doc: ProseMirrorNode;
  readonly byId: ReadonlyMap<string, SceneBeatSnapshot>;
  readonly orderedIds: readonly string[];
}

interface TransactionStepLike {
  getMap(): StepMap;
  toJSON?(): unknown;
}

export interface SceneBeatIndexTransactionLike {
  readonly before: ProseMirrorNode;
  readonly doc: ProseMirrorNode;
  readonly steps: readonly TransactionStepLike[];
  readonly docs?: readonly ProseMirrorNode[];
  readonly mapping: Mapping;
}

export interface SceneBeatIndexUpdate {
  index: SceneBeatIndex;
  removed: SceneBeatSnapshot[];
  addedIds: string[];
  rebuilt: boolean;
}

function normalizePreview(text: string): string {
  return text
    .trim()
    .replace(/[\n\r\t]+/g, " ")
    .trim()
    .slice(0, MAX_PREVIEW_CHARS);
}

function snapshotSceneBeat(
  node: ProseMirrorNode,
  pos: number,
): SceneBeatSnapshot | null {
  if (node.type.name !== SCENE_BEAT_NODE_NAME) return null;
  const id = node.attrs.id as string | null;
  if (!id) return null;
  return {
    id,
    beatType: (node.attrs.beatType ?? "free") as string,
    pov: (node.attrs.pov ?? null) as string | null,
    content: node.content.toJSON() as unknown[],
    previewText: normalizePreview(node.textContent),
    pos,
  };
}

export function buildSceneBeatIndex(doc: ProseMirrorNode): SceneBeatIndex {
  const byId = new Map<string, SceneBeatSnapshot>();
  const orderedIds: string[] = [];
  doc.descendants((node, pos) => {
    const snapshot = snapshotSceneBeat(node, pos);
    if (!snapshot) return true;
    byId.set(snapshot.id, snapshot);
    orderedIds.push(snapshot.id);
    return false;
  });
  return { doc, byId, orderedIds };
}

function mapSnapshots(
  index: SceneBeatIndex,
  mapping: { map(pos: number, assoc?: number): number },
  doc: ProseMirrorNode,
): SceneBeatIndex {
  if (index.byId.size === 0) {
    return { doc, byId: index.byId, orderedIds: index.orderedIds };
  }
  const byId = new Map<string, SceneBeatSnapshot>();
  for (const [id, snapshot] of index.byId) {
    byId.set(id, {
      ...snapshot,
      // A Beat starting exactly at an insertion boundary belongs after the
      // inserted content, hence assoc=1.
      pos: mapping.map(snapshot.pos, 1),
    });
  }
  return { doc, byId, orderedIds: index.orderedIds };
}

/**
 * Advance positions for a transaction known not to touch a sceneBeat. This is
 * O(Beat count), but performs no document traversal and preserves the index
 * needed by a later structural Beat transaction.
 */
export function mapSceneBeatIndex(
  index: SceneBeatIndex,
  mapping: Mapping,
  doc: ProseMirrorNode,
): SceneBeatIndex {
  return mapSnapshots(index, mapping, doc);
}

function isDocumentPosition(doc: ProseMirrorNode, pos: number): boolean {
  return Number.isInteger(pos) && pos >= 0 && pos <= doc.content.size;
}

function addSceneBeatAtDepth(
  doc: ProseMirrorNode,
  pos: number,
  out: Map<string, SceneBeatSnapshot>,
): boolean {
  if (!isDocumentPosition(doc, pos)) return false;
  const resolved = doc.resolve(pos);
  for (let depth = resolved.depth; depth >= 1; depth -= 1) {
    const node = resolved.node(depth);
    if (node.type.name !== SCENE_BEAT_NODE_NAME) continue;
    const snapshot = snapshotSceneBeat(node, resolved.before(depth));
    if (snapshot) out.set(snapshot.id, snapshot);
    return true;
  }
  return true;
}

function collectSceneBeats(
  doc: ProseMirrorNode,
  from: number,
  to: number,
): Map<string, SceneBeatSnapshot> | null {
  if (
    !isDocumentPosition(doc, from) ||
    !isDocumentPosition(doc, to) ||
    from > to
  ) {
    return null;
  }

  const out = new Map<string, SceneBeatSnapshot>();
  if (!addSceneBeatAtDepth(doc, from, out)) return null;
  if (!addSceneBeatAtDepth(doc, to, out)) return null;

  const nodeAtFrom = doc.nodeAt(from);
  if (nodeAtFrom) {
    const snapshot = snapshotSceneBeat(nodeAtFrom, from);
    if (snapshot) out.set(snapshot.id, snapshot);
  }

  doc.nodesBetween(from, to, (node, pos) => {
    const snapshot = snapshotSceneBeat(node, pos);
    if (!snapshot) return true;
    out.set(snapshot.id, snapshot);
    return false;
  });
  return out;
}

function readStepJson(
  step: TransactionStepLike,
): Record<string, unknown> | null {
  if (!step.toJSON) return null;
  try {
    const json = step.toJSON();
    if (!json || typeof json !== "object" || Array.isArray(json)) return null;
    return json as Record<string, unknown>;
  } catch {
    return null;
  }
}

function mergeSnapshots(
  target: Map<string, SceneBeatSnapshot>,
  source: Map<string, SceneBeatSnapshot> | null,
): boolean {
  if (source === null) return false;
  for (const [id, snapshot] of source) target.set(id, snapshot);
  return true;
}

function collectMaplessStepSides(
  step: TransactionStepLike,
  before: ProseMirrorNode,
  after: ProseMirrorNode,
): {
  oldBeats: Map<string, SceneBeatSnapshot>;
  newBeats: Map<string, SceneBeatSnapshot>;
} | null {
  const json = readStepJson(step);
  const stepType = json?.stepType;
  const oldBeats = new Map<string, SceneBeatSnapshot>();
  const newBeats = new Map<string, SceneBeatSnapshot>();

  if (stepType === "docAttr") return { oldBeats, newBeats };

  if (stepType === "addMark" || stepType === "removeMark") {
    const from = json?.from;
    const to = json?.to;
    if (typeof from !== "number" || typeof to !== "number") return null;
    if (!mergeSnapshots(oldBeats, collectSceneBeats(before, from, to))) {
      return null;
    }
    if (!mergeSnapshots(newBeats, collectSceneBeats(after, from, to))) {
      return null;
    }
    return { oldBeats, newBeats };
  }

  if (
    stepType === "attr" ||
    stepType === "addNodeMark" ||
    stepType === "removeNodeMark"
  ) {
    const pos = json?.pos;
    if (typeof pos !== "number") return null;
    if (!mergeSnapshots(oldBeats, collectSceneBeats(before, pos, pos))) {
      return null;
    }
    if (!mergeSnapshots(newBeats, collectSceneBeats(after, pos, pos))) {
      return null;
    }
    return { oldBeats, newBeats };
  }

  return null;
}

function collectStepSides(
  step: TransactionStepLike,
  before: ProseMirrorNode,
  after: ProseMirrorNode,
): {
  oldBeats: Map<string, SceneBeatSnapshot>;
  newBeats: Map<string, SceneBeatSnapshot>;
} | null {
  const oldBeats = new Map<string, SceneBeatSnapshot>();
  const newBeats = new Map<string, SceneBeatSnapshot>();
  let mappedRangeCount = 0;
  let valid = true;

  try {
    step.getMap().forEach((oldStart, oldEnd, newStart, newEnd) => {
      mappedRangeCount += 1;
      if (
        !mergeSnapshots(
          oldBeats,
          collectSceneBeats(before, oldStart, oldEnd),
        ) ||
        !mergeSnapshots(newBeats, collectSceneBeats(after, newStart, newEnd))
      ) {
        valid = false;
      }
    });
  } catch {
    return null;
  }

  if (!valid) return null;
  if (mappedRangeCount > 0) return { oldBeats, newBeats };
  return collectMaplessStepSides(step, before, after);
}

function sortedIds(byId: ReadonlyMap<string, SceneBeatSnapshot>): string[] {
  return [...byId.values()]
    .sort((a, b) => a.pos - b.pos || a.id.localeCompare(b.id))
    .map((snapshot) => snapshot.id);
}

function diffIndexes(
  before: SceneBeatIndex,
  after: SceneBeatIndex,
): Pick<SceneBeatIndexUpdate, "removed" | "addedIds"> {
  const removed: SceneBeatSnapshot[] = [];
  const addedIds: string[] = [];
  for (const [id, snapshot] of before.byId) {
    if (!after.byId.has(id)) removed.push(snapshot);
  }
  for (const id of after.byId.keys()) {
    if (!before.byId.has(id)) addedIds.push(id);
  }
  return { removed, addedIds };
}

/**
 * Apply only the ranges changed by each step. Unknown future step shapes fall
 * back to a single full rebuild, preserving correctness.
 */
export function updateSceneBeatIndex(
  sourceIndex: SceneBeatIndex,
  transaction: SceneBeatIndexTransactionLike,
): SceneBeatIndexUpdate {
  const initial =
    sourceIndex.doc === transaction.before
      ? sourceIndex
      : buildSceneBeatIndex(transaction.before);
  const stepDocuments = transaction.docs;
  if (
    transaction.steps.length === 0 ||
    (stepDocuments && stepDocuments.length !== transaction.steps.length) ||
    (!stepDocuments && transaction.steps.length > 1)
  ) {
    const index =
      transaction.steps.length === 0
        ? mapSceneBeatIndex(initial, transaction.mapping, transaction.doc)
        : buildSceneBeatIndex(transaction.doc);
    return {
      index,
      ...diffIndexes(initial, index),
      rebuilt: transaction.steps.length > 0,
    };
  }

  let current = initial;
  for (let index = 0; index < transaction.steps.length; index += 1) {
    const step = transaction.steps[index];
    const before =
      stepDocuments?.[index] ??
      (transaction.steps.length === 1 ? transaction.before : undefined);
    const after =
      index + 1 < transaction.steps.length
        ? stepDocuments?.[index + 1]
        : transaction.doc;
    if (!before || !after) {
      const rebuilt = buildSceneBeatIndex(transaction.doc);
      return {
        index: rebuilt,
        ...diffIndexes(initial, rebuilt),
        rebuilt: true,
      };
    }

    const sides = collectStepSides(step, before, after);
    if (!sides) {
      const rebuilt = buildSceneBeatIndex(transaction.doc);
      return {
        index: rebuilt,
        ...diffIndexes(initial, rebuilt),
        rebuilt: true,
      };
    }

    const mapped = mapSnapshots(current, step.getMap(), after);
    const byId = new Map(mapped.byId);
    let requiresResort =
      sides.oldBeats.size !== sides.newBeats.size ||
      [...sides.oldBeats.keys()].some((id) => !sides.newBeats.has(id));
    for (const id of sides.oldBeats.keys()) byId.delete(id);
    for (const [id, snapshot] of sides.newBeats) {
      if (mapped.byId.get(id)?.pos !== snapshot.pos) requiresResort = true;
      byId.set(id, snapshot);
    }
    current = {
      doc: after,
      byId,
      orderedIds: requiresResort ? sortedIds(byId) : mapped.orderedIds,
    };
  }

  return {
    index: current,
    ...diffIndexes(initial, current),
    rebuilt: false,
  };
}

export function placedBeatPreviewFromIndex(index: SceneBeatIndex): string {
  const items: string[] = [];
  for (const id of index.orderedIds) {
    const previewText = index.byId.get(id)?.previewText;
    if (!previewText) continue;
    items.push(previewText);
    if (items.length >= MAX_PREVIEW_BEATS) break;
  }
  return JSON.stringify(items);
}
