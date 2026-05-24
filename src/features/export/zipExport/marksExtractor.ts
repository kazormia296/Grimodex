interface PMNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: PMMark[];
  content?: PMNode[];
}

interface PMMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export type ExtractedMarkType =
  | "authorship"
  | "comment"
  | "annotation"
  | "lintDisable";

export interface ExtractedMark {
  type: ExtractedMarkType;
  from: number;
  to: number;
  attrs: Record<string, unknown>;
}

export interface MarksSidecar {
  schemaVersion: 1;
  marks: ExtractedMark[];
}

const EXCLUDED_MARKS = new Set(["foreshadowSetup", "foreshadowPayoff"]);

const MARK_TYPE_MAP: Record<string, ExtractedMarkType> = {
  authorship: "authorship",
  comment: "comment",
  peAnnotation: "annotation",
  lintDisable: "lintDisable",
};

function mapMarkType(pmType: string): ExtractedMarkType | null {
  return MARK_TYPE_MAP[pmType] ?? null;
}

function normalizeAttrs(
  type: ExtractedMarkType,
  attrs: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const raw = attrs ?? {};
  switch (type) {
    case "authorship":
      return {
        source: raw.source ?? "human",
        timestamp: raw.timestamp ?? null,
        model: raw.model ?? null,
        chatMessageId: raw.chatMessageId ?? null,
        traceId: raw.traceId ?? null,
        toolName: raw.toolName ?? null,
        toolVersion: raw.toolVersion ?? null,
        manualOverride: raw.manualOverride ?? false,
        originalLength: raw.originalLength ?? null,
      };
    case "comment":
      return {
        text: raw.text ?? "",
        createdAt: raw.createdAt ?? null,
      };
    case "annotation":
      return {
        annotationId: raw.annotationId ?? null,
        category: raw.category ?? "consistency_anchor",
        severity: raw.severity ?? "warning",
        status: raw.status ?? "open",
      };
    case "lintDisable":
      return {
        rules: Array.isArray(raw.rules) ? raw.rules : ["*"],
      };
  }
}

function isLeafBlock(type: string): boolean {
  return type === "paragraph" || type === "heading" || type === "codeBlock";
}

/** Walk a ProseMirror JSON doc and collect exportable mark ranges. */
export function extractMarksFromPmDoc(contentJson: string): MarksSidecar {
  if (!contentJson || contentJson === "{}") {
    return { schemaVersion: 1, marks: [] };
  }

  let doc: PMNode;
  try {
    doc = JSON.parse(contentJson) as PMNode;
  } catch {
    return { schemaVersion: 1, marks: [] };
  }

  const marks: ExtractedMark[] = [];

  function walk(node: PMNode, pos: number): number {
    if (node.type === "text") {
      const text = node.text ?? "";
      const len = text.length;
      for (const mark of node.marks ?? []) {
        if (EXCLUDED_MARKS.has(mark.type)) continue;
        const mapped = mapMarkType(mark.type);
        if (!mapped) continue;
        marks.push({
          type: mapped,
          from: pos,
          to: pos + len,
          attrs: normalizeAttrs(mapped, mark.attrs),
        });
      }
      return pos + len;
    }

    if (node.type === "ruby") {
      const base = (node.attrs?.base as string) ?? "";
      return pos + base.length;
    }

    if (node.type === "sceneBeat" || node.type === "horizontalRule") {
      return pos;
    }

    const children = node.content ?? [];
    if (children.length === 0) {
      return isLeafBlock(node.type) ? pos + 1 : pos;
    }

    let cursor = pos + 1;
    for (const child of children) {
      cursor = walk(child, cursor);
    }
    return cursor + 1;
  }

  walk(doc, 0);
  return { schemaVersion: 1, marks };
}
