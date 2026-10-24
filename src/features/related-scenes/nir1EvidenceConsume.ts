import type { Editor } from "@tiptap/react";
import type { Nir1EvidenceQualifyResponse } from "@/../electron/shared/relatedScenesSearchWire";
import { qualifyNir1GraphEvidence } from "@/features/narrative-semantic-core/nir1GraphApi";
import type {
  Nir1EvidenceEditorCapture,
  Nir1EvidenceEditorState,
} from "./nir1EvidenceNavigationState";
import type {
  Nir1EvidenceClaim,
  Nir1GraphOnlyTarget,
} from "./nir1EvidenceNavigation";
import {
  resolveNir1EvidenceRange,
  resolveNir1GraphOnlyRange,
  serializeProseMirrorDocument,
  type Nir1EvidenceRange,
} from "./nir1EvidenceRange";

/**
 * The startup hook's claim, capture and editor, and the startup modules it
 * uses, passed in rather than imported: this lazy module never statically
 * imports a startup module (DR-CP3B-10, DR-CB3-35 (3)).
 */
export interface Nir1EvidenceConsumeInput {
  readonly claim: Nir1EvidenceClaim;
  readonly capture: Nir1EvidenceEditorCapture;
  readonly editor: Editor;
  readonly documentJson: string;
  readonly cancelled: () => boolean;
  readonly captureState: () => Nir1EvidenceEditorState | null;
  readonly beforeSelection: () => void;
  readonly isEditorCurrent: (
    captured: Nir1EvidenceEditorCapture | null,
    current: Nir1EvidenceEditorState,
  ) => boolean;
  readonly qualifyEvidence: (
    identity: string,
  ) => Promise<Nir1EvidenceQualifyResponse>;
  readonly digest: (text: string) => Promise<string>;
}

/** The editor-side match of an IR (digest, full quote) or Graph-only target. */
export async function consumeNir1Evidence(
  input: Nir1EvidenceConsumeInput,
): Promise<void> {
  const { claim, capture, editor } = input;
  const range = claim.graphOnly
    ? await graphOnlyRange(input, claim.graphOnly)
    : await irRange(input);
  if (!range || range.status !== "highlight") return;
  // No await between this final generation check and selection. Never
  // clamp a stale range or use a prefix/Raw jump fallback.
  const final = input.captureState();
  if (!final || !claim.isCurrent() || !input.isEditorCurrent(capture, final))
    return;
  input.beforeSelection();
  editor
    .chain()
    .focus()
    .setTextSelection(range.selection)
    .scrollIntoView()
    .run();
}

async function irRange(
  input: Nir1EvidenceConsumeInput,
): Promise<Nir1EvidenceRange | null> {
  const { claim, capture, editor, documentJson } = input;
  const serialized = serializeProseMirrorDocument(documentJson, "database");
  if (!serialized.ok) return null;
  const canonicalDigest = await input.digest(serialized.canonical.text);
  const qualified = await input.qualifyEvidence(claim.identity);
  const current = input.captureState();
  if (
    input.cancelled() ||
    !claim.isCurrent() ||
    qualified.status !== "qualified" ||
    qualified.bindingKey !== claim.identity ||
    qualified.queryBinding !== claim.queryBinding ||
    qualified.sceneId !== claim.sceneId ||
    !current ||
    !input.isEditorCurrent(capture, current) ||
    capture.binding.kind !== "tree" ||
    capture.binding.id !== claim.sceneId ||
    capture.binding.loadedVersion !== qualified.sourceVersion
  )
    return null;
  if (editor.isDestroyed || canonicalDigest !== qualified.canonicalTextDigest)
    return null;
  const range = resolveNir1EvidenceRange({
    documentJson,
    fullQuote: qualified.fullQuote,
    normalizerVersion: qualified.normalizerVersion,
  });
  if (
    range.status !== "highlight" ||
    range.canonicalRange.start !== qualified.canonicalRange.start ||
    range.canonicalRange.end !== qualified.canonicalRange.end
  )
    return null;
  return range;
}

/**
 * DR-CP3A-26: no digest and no full quote. Native re-reads and compares the
 * body; the renderer matches its own editor text at the range against the
 * disclosed excerpt. Every click qualifies again (never a previous answer).
 */
async function graphOnlyRange(
  input: Nir1EvidenceConsumeInput,
  target: Nir1GraphOnlyTarget,
): Promise<Nir1EvidenceRange | null> {
  const { claim, capture, editor } = input;
  const qualified = await qualifyNir1GraphEvidence(claim.identity);
  const current = input.captureState();
  if (
    input.cancelled() ||
    !claim.isCurrent() ||
    qualified.status !== "qualified" ||
    qualified.bindingKey !== claim.identity ||
    qualified.queryBinding !== claim.queryBinding ||
    qualified.sceneId !== claim.sceneId ||
    qualified.canonicalRange.start !== target.canonicalRange.start ||
    qualified.canonicalRange.end !== target.canonicalRange.end ||
    !current ||
    !input.isEditorCurrent(capture, current) ||
    capture.binding.kind !== "tree" ||
    capture.binding.id !== claim.sceneId ||
    editor.isDestroyed
  )
    return null;
  return resolveNir1GraphOnlyRange({
    documentJson: input.documentJson,
    canonicalRange: target.canonicalRange,
    excerpt: target.excerpt,
  });
}
