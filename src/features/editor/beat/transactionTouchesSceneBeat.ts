import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { StepMap } from "@tiptap/pm/transform";

interface TransactionStepLike {
  getMap(): StepMap;
  toJSON?(): unknown;
}

/**
 * Structural subset of a ProseMirror Transaction used by the beat change
 * detector. Keeping the input structural makes the helper straightforward to
 * exercise while allowing a Transaction to be passed directly.
 */
export interface SceneBeatTransactionLike {
  readonly before: ProseMirrorNode;
  readonly doc: ProseMirrorNode;
  readonly steps: readonly TransactionStepLike[];
  readonly docs?: readonly ProseMirrorNode[];
}

const SCENE_BEAT_NODE_NAME = "sceneBeat";

function isDocumentPosition(doc: ProseMirrorNode, pos: number): boolean {
  return Number.isInteger(pos) && pos >= 0 && pos <= doc.content.size;
}

function positionIsInsideSceneBeat(doc: ProseMirrorNode, pos: number): boolean {
  if (!isDocumentPosition(doc, pos)) return false;

  const resolved = doc.resolve(pos);
  for (let depth = resolved.depth; depth >= 0; depth -= 1) {
    if (resolved.node(depth).type.name === SCENE_BEAT_NODE_NAME) return true;
  }
  return false;
}

function rangeTouchesSceneBeat(
  doc: ProseMirrorNode,
  from: number,
  to: number,
): boolean | null {
  if (
    !isDocumentPosition(doc, from) ||
    !isDocumentPosition(doc, to) ||
    from > to
  ) {
    return null;
  }

  // Insertions have an empty range in the old document. Resolving their
  // position is what tells us whether text was inserted inside a sceneBeat.
  if (
    positionIsInsideSceneBeat(doc, from) ||
    positionIsInsideSceneBeat(doc, to)
  ) {
    return true;
  }

  let found = false;
  doc.nodesBetween(from, to, (node) => {
    if (node.type.name !== SCENE_BEAT_NODE_NAME) return true;
    found = true;
    return false;
  });
  return found;
}

function positionTargetsSceneBeat(
  doc: ProseMirrorNode,
  pos: number,
): boolean | null {
  if (!isDocumentPosition(doc, pos)) return null;
  return (
    doc.nodeAt(pos)?.type.name === SCENE_BEAT_NODE_NAME ||
    positionIsInsideSceneBeat(doc, pos)
  );
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

/**
 * Handle document-changing steps whose StepMap is empty, such as mark and
 * attribute steps. `null` means the step shape is unknown, so callers must
 * conservatively assume that it can affect a sceneBeat.
 */
function maplessStepTouchesSceneBeat(
  step: TransactionStepLike,
  before: ProseMirrorNode,
  after: ProseMirrorNode,
): boolean | null {
  const json = readStepJson(step);
  const stepType = json?.stepType;

  if (stepType === "docAttr") return false;

  if (stepType === "addMark" || stepType === "removeMark") {
    const from = json?.from;
    const to = json?.to;
    if (typeof from !== "number" || typeof to !== "number") return null;
    const beforeResult = rangeTouchesSceneBeat(before, from, to);
    const afterResult = rangeTouchesSceneBeat(after, from, to);
    if (beforeResult === null || afterResult === null) return null;
    return beforeResult || afterResult;
  }

  if (
    stepType === "attr" ||
    stepType === "addNodeMark" ||
    stepType === "removeNodeMark"
  ) {
    const pos = json?.pos;
    if (typeof pos !== "number") return null;
    const beforeResult = positionTargetsSceneBeat(before, pos);
    const afterResult = positionTargetsSceneBeat(after, pos);
    if (beforeResult === null || afterResult === null) return null;
    return beforeResult || afterResult;
  }

  return null;
}

/**
 * Return whether a ProseMirror transaction can affect any sceneBeat node.
 *
 * Replacement ranges are inspected in the document immediately before and
 * after each step. This catches edits inside a beat as well as inserting,
 * removing, or moving the beat node itself. Unknown or malformed step shapes
 * return `true`, preserving correctness at the cost of the occasional scan.
 */
export function transactionTouchesSceneBeat(
  transaction: SceneBeatTransactionLike,
): boolean {
  const { steps } = transaction;
  if (steps.length === 0) return false;

  const stepDocuments = transaction.docs;
  if (stepDocuments && stepDocuments.length !== steps.length) return true;
  if (!stepDocuments && steps.length > 1) return true;

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const before =
      stepDocuments?.[index] ??
      (steps.length === 1 ? transaction.before : undefined);
    const after =
      index + 1 < steps.length ? stepDocuments?.[index + 1] : transaction.doc;

    if (!before || !after) return true;

    let mappedRangeCount = 0;
    let mappedRangeTouchesSceneBeat = false;
    let invalidMappedRange = false;
    try {
      step.getMap().forEach((oldStart, oldEnd, newStart, newEnd) => {
        mappedRangeCount += 1;
        const oldResult = rangeTouchesSceneBeat(before, oldStart, oldEnd);
        const newResult = rangeTouchesSceneBeat(after, newStart, newEnd);
        if (oldResult === null || newResult === null) {
          invalidMappedRange = true;
          return;
        }
        if (oldResult || newResult) {
          mappedRangeTouchesSceneBeat = true;
        }
      });
    } catch {
      return true;
    }
    if (invalidMappedRange || mappedRangeTouchesSceneBeat) return true;

    if (mappedRangeCount === 0) {
      const maplessResult = maplessStepTouchesSceneBeat(step, before, after);
      if (maplessResult !== false) return true;
    }
  }

  return false;
}
