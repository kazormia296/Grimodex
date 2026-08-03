import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { AuthorshipSource } from "@/features/attribution/AuthorshipMark";
import type { MentionRole } from "@/features/codex/CodexMentionExtension";
import type { UnplacedBeat } from "@/features/editor/beat/unplacedBeatsStore";
import { extractUnplacedBeatPreview } from "@/features/editor/beat/unplacedBeatPreview";

const MAX_PREVIEW_BEATS = 8;
const MAX_PREVIEW_CHARS = 60;

export interface SceneAuthorshipSpanInput {
  fromPos: number;
  toPos: number;
  source: AuthorshipSource;
  model: string | null;
  timestamp: string | null;
  chatMsgId: string | null;
  traceId: string | null;
}

export interface SceneForeshadowSetupInput {
  id: string;
  foreshadowId: string;
  fromPos: number;
  toPos: number;
}

export interface SceneForeshadowPayoffInput {
  foreshadowId: string;
  fromPos: number;
  toPos: number;
}

export interface SceneAnnotationAnchorInput {
  id: string;
  rangeStart: number;
  rangeEnd: number;
  textSnapshot: string;
}

export interface SceneBeatMentionInput {
  beatId: string;
  codexId: string;
  role: MentionRole;
}

export interface SceneBodyDerivedSnapshot {
  contentJson: string;
  charCount: number;
  placedBeatPreview: string | null;
  unplacedBeatsDoc: string;
  unplacedBeatPreview: string | null;
  authorshipSpans: SceneAuthorshipSpanInput[];
  foreshadowSetups: SceneForeshadowSetupInput[];
  foreshadowPayoffs: SceneForeshadowPayoffInput[];
  annotationAnchors: SceneAnnotationAnchorInput[];
  beatMentions: SceneBeatMentionInput[];
  beatPovOverrides: string[];
  docContentSize: number;
}

/**
 * Derive the tree badge ratio from the exact sidecars already persisted by
 * Electron's scene-body bundle. This mirrors projectStats' denominator rule
 * without issuing a second DB read immediately after save.
 */
export function deriveSceneAiRatio(
  snapshot: Pick<SceneBodyDerivedSnapshot, "charCount" | "authorshipSpans">,
): number | undefined {
  let ai = 0;
  let unknown = 0;
  for (const span of snapshot.authorshipSpans) {
    const length = Math.max(0, span.toPos - span.fromPos);
    if (span.source === "ai") ai += length;
    else if (span.source === "unknown") unknown += length;
  }
  const total = Math.max(snapshot.charCount, ai + unknown);
  return total > 0 ? Math.round((ai / total) * 100) : undefined;
}

const ROLE_PRIORITY: Record<MentionRole, number> = {
  actor: 2,
  target: 1,
  mentioned: 0,
};

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function authorshipSource(value: unknown): AuthorshipSource {
  if (value === "human" || value === "ai" || value === "unknown") {
    return value;
  }
  throw new Error(
    `Invalid authorship source in scene document: ${String(value)}`,
  );
}

function mentionRole(value: unknown): MentionRole {
  return value === "actor" || value === "target" || value === "mentioned"
    ? value
    : "mentioned";
}

function previewLine(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed
    .replace(/[\n\r\t]+/g, " ")
    .trim()
    .slice(0, MAX_PREVIEW_CHARS);
}

/**
 * Build every synchronous scene-save derivative in one ProseMirror traversal.
 *
 * `doc.toJSON()` still performs the serialization required for persistence, but
 * char count, preview, attribution, anchors, mentions and POV cache all share
 * this single `descendants` pass instead of independently walking the document.
 */
export function deriveSceneBodySnapshot(
  doc: ProseMirrorNode,
  unplacedBeats: UnplacedBeat[],
  includeSidecars = true,
): SceneBodyDerivedSnapshot {
  let charCount = 0;
  const placedPreview: string[] = [];
  const authorshipSpans: SceneAuthorshipSpanInput[] = [];
  const foreshadowSetups: SceneForeshadowSetupInput[] = [];
  const foreshadowPayoffs: SceneForeshadowPayoffInput[] = [];
  const annotationById = new Map<
    string,
    { rangeStart: number; rangeEnd: number; texts: string[] }
  >();
  const beatMentionByKey = new Map<string, SceneBeatMentionInput>();
  const beatPovOverrides = new Set<string>();
  // Preserve saveAuthorshipSpans' existing contract: marks created before
  // timestamp tracking was introduced receive the time of this save.
  const fallbackAuthorshipTimestamp = new Date().toISOString();

  doc.descendants((node, pos, parent) => {
    const nodeType = node.type.name;

    if (nodeType === "sceneBeat") {
      if (placedPreview.length < MAX_PREVIEW_BEATS) {
        const line = previewLine(node.textContent);
        if (line) placedPreview.push(line);
      }
      const pov = nullableString(node.attrs.pov);
      if (pov) beatPovOverrides.add(pov);
    }

    if (node.isText && parent?.type.name !== "sceneBeat") {
      charCount += node.text?.length ?? 0;
    }

    if (!includeSidecars) return true;

    if (nodeType === "mention" && parent?.type.name === "sceneBeat") {
      const beatId = nullableString(parent.attrs.id);
      const codexId = nullableString(node.attrs.id);
      if (beatId && codexId) {
        const role = mentionRole(node.attrs.role);
        const key = `${beatId}::${codexId}`;
        const current = beatMentionByKey.get(key);
        if (!current || ROLE_PRIORITY[role] > ROLE_PRIORITY[current.role]) {
          beatMentionByKey.set(key, { beatId, codexId, role });
        }
      }
    }

    if (!node.isText) return true;
    const text = node.text ?? "";
    const toPos = pos + text.length;

    const authorship = node.marks.find(
      (mark) => mark.type.name === "authorship",
    );
    if (authorship) {
      authorshipSpans.push({
        fromPos: pos,
        toPos,
        source: authorshipSource(authorship.attrs.source),
        model: nullableString(authorship.attrs.model),
        timestamp:
          nullableString(authorship.attrs.timestamp) ??
          fallbackAuthorshipTimestamp,
        chatMsgId: nullableString(authorship.attrs.chatMessageId),
        traceId: nullableString(authorship.attrs.traceId),
      });
    }

    const setup = node.marks.find(
      (mark) => mark.type.name === "foreshadowSetup",
    );
    if (setup) {
      const id = nullableString(setup.attrs.setupId);
      const foreshadowId = nullableString(setup.attrs.foreshadowId);
      if (id && foreshadowId) {
        foreshadowSetups.push({ id, foreshadowId, fromPos: pos, toPos });
      }
    }

    const payoff = node.marks.find(
      (mark) => mark.type.name === "foreshadowPayoff",
    );
    if (payoff) {
      const foreshadowId = nullableString(payoff.attrs.foreshadowId);
      if (foreshadowId) {
        foreshadowPayoffs.push({ foreshadowId, fromPos: pos, toPos });
      }
    }

    const annotation = node.marks.find(
      (mark) => mark.type.name === "peAnnotation",
    );
    if (annotation) {
      const id = nullableString(annotation.attrs.annotationId);
      if (id) {
        const current = annotationById.get(id);
        if (current) {
          current.rangeEnd = toPos;
          current.texts.push(text);
        } else {
          annotationById.set(id, {
            rangeStart: pos,
            rangeEnd: toPos,
            texts: [text],
          });
        }
      }
    }
    return true;
  });

  const unplacedBeatsDoc = JSON.stringify(unplacedBeats);
  const unplacedPreviewJson = extractUnplacedBeatPreview(unplacedBeats);

  return {
    contentJson: JSON.stringify(doc.toJSON()),
    charCount,
    placedBeatPreview:
      placedPreview.length > 0 ? JSON.stringify(placedPreview) : null,
    unplacedBeatsDoc,
    unplacedBeatPreview:
      unplacedPreviewJson === "[]" ? null : unplacedPreviewJson,
    authorshipSpans,
    foreshadowSetups,
    foreshadowPayoffs,
    annotationAnchors: Array.from(
      annotationById,
      ([id, { rangeStart, rangeEnd, texts }]) => ({
        id,
        rangeStart,
        rangeEnd,
        textSnapshot: texts.join(""),
      }),
    ),
    beatMentions: Array.from(beatMentionByKey.values()),
    beatPovOverrides: Array.from(beatPovOverrides),
    docContentSize: doc.content.size,
  };
}
