import {
  DOMParser as ProseMirrorDOMParser,
  Node as ProseMirrorNode,
  type Schema,
} from "@tiptap/pm/model";
import type { ReplayEvent } from "./replayEngine";
import type { DecodedSnapshot } from "./snapshots";

export interface ReplayStart<E extends ReplayEvent = ReplayEvent> {
  initialDoc: ProseMirrorNode;
  replayEvents: E[];
}

function createEmptyDocument(schema: Schema): ProseMirrorNode {
  const empty = schema.topNodeType.createAndFill();
  if (!empty) {
    throw new Error("timelapse: could not build an initial document");
  }
  return empty;
}

function invalidSnapshotPayload(cause?: unknown): Error {
  return new Error(
    "timelapse: invalid snapshot payload",
    cause === undefined ? undefined : { cause },
  );
}

function isEmptyObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.keys(value).length === 0
  );
}

const LEGACY_EDITOR_HTML_ROOTS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "ul",
  "ol",
  "li",
  "hr",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "s",
  "strike",
  "del",
  "code",
  "span",
]);

function looksLikeLegacyHtml(value: string): boolean {
  const leadingTag = /^\s*<\/?([a-z][a-z0-9-]*)\b[^>]*>/i.exec(value);
  return (
    leadingTag !== null &&
    LEGACY_EDITOR_HTML_ROOTS.has(leadingTag[1].toLowerCase())
  );
}

/**
 * Decode both canonical editor snapshots and bodies written by older mini
 * editors. Native stores the authoritative body byte-for-byte, so the replay
 * boundary is the one place that can safely normalize legacy HTML/plain text
 * without changing persistence or subsequent `doc.step` positions.
 */
export function decodeReplaySnapshotPayload(
  schema: Schema,
  payload: unknown,
): ProseMirrorNode {
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (trimmed === "" || trimmed === "{}") {
      return createEmptyDocument(schema);
    }

    if (typeof globalThis.DOMParser !== "function") {
      throw invalidSnapshotPayload(
        new Error("DOMParser is unavailable for a legacy text snapshot"),
      );
    }
    const legacyDocument = new globalThis.DOMParser().parseFromString(
      "<body></body>",
      "text/html",
    );
    if (looksLikeLegacyHtml(payload)) {
      const parsed = new globalThis.DOMParser().parseFromString(
        payload,
        "text/html",
      );
      legacyDocument.body.replaceChildren(...parsed.body.childNodes);
    } else {
      // Do not interpret plain-text bodies as markup. Besides preserving the
      // exact visible text, this keeps script-like prose inert.
      legacyDocument.body.textContent = payload;
    }
    try {
      return ProseMirrorDOMParser.fromSchema(schema).parse(
        legacyDocument.body,
        { preserveWhitespace: true },
      );
    } catch (error) {
      throw invalidSnapshotPayload(error);
    }
  }

  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw invalidSnapshotPayload();
  }
  if (isEmptyObject(payload)) return createEmptyDocument(schema);

  try {
    return ProseMirrorNode.fromJSON(schema, payload as never);
  } catch (error) {
    throw invalidSnapshotPayload(error);
  }
}

/**
 * Decide the replay starting point (P7.7 / §4.5).
 */
export function buildReplayStart<E extends ReplayEvent>(
  schema: Schema,
  events: E[],
  snapshot: Pick<DecodedSnapshot, "payload" | "anchorSequence"> | null,
): ReplayStart<E> {
  if (snapshot) {
    const initialDoc = decodeReplaySnapshotPayload(schema, snapshot.payload);
    const replayEvents = events.filter(
      (e) => e.sequence > snapshot.anchorSequence,
    );
    return { initialDoc, replayEvents };
  }
  const empty = createEmptyDocument(schema);
  return { initialDoc: empty, replayEvents: events };
}
