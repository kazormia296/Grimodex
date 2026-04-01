/**
 * Agent Trace v0.1.0 export types and conversion logic.
 *
 * MIME type: application/vnd.agent-trace.record+json
 * Grimodex extensions use the `dev.grimodex.*` namespace.
 */

import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { AuthorshipSource } from "./AuthorshipMark";

// ── Agent Trace schema types ───────────────────────────────────

export interface AgentTraceSpan {
  /** Start offset (character index, 0-based) */
  start: number;
  /** End offset (exclusive) */
  end: number;
  /** Attribution source */
  source: AuthorshipSource;
  /** Model identifier in provider/model format */
  model: string | null;
  /** Trace identifier (UUID) */
  traceId: string | null;
  /** Tool that produced this span */
  toolName: string | null;
  /** Tool version */
  toolVersion: string | null;
  /** Whether this attribution was manually set by the user */
  manualOverride: boolean;
}

export interface AgentTraceRecord {
  /** Schema version */
  version: "0.1.0";
  /** MIME type */
  type: "application/vnd.agent-trace.record+json";
  /** When the record was generated */
  generatedAt: string;
  /** Document identifier */
  documentId: string;
  /** Document title (Grimodex extension) */
  "dev.grimodex.documentTitle": string;
  /** SHA-256 hash of the full document text */
  contentHash: string;
  /** Total character count */
  totalChars: number;
  /** Attribution spans */
  spans: AgentTraceSpan[];
}

// ── Conversion logic ───────────────────────────────────────────

interface RawSpan {
  start: number;
  end: number;
  source: AuthorshipSource;
  model: string | null;
  traceId: string | null;
  toolName: string | null;
  toolVersion: string | null;
  manualOverride: boolean;
}

/**
 * Extract character-level authorship marks from a ProseMirror document
 * and merge adjacent spans with identical attributes into coarser spans.
 */
export function extractSpans(doc: ProseMirrorNode): AgentTraceSpan[] {
  const raw: RawSpan[] = [];
  let offset = 0;

  doc.descendants((node) => {
    if (!node.isText) return;

    const len = node.text?.length ?? 0;
    const mark = node.marks.find((m) => m.type.name === "authorship");

    if (mark) {
      raw.push({
        start: offset,
        end: offset + len,
        source: mark.attrs.source as AuthorshipSource,
        model: mark.attrs.model ?? null,
        traceId: mark.attrs.traceId ?? null,
        toolName: mark.attrs.toolName ?? null,
        toolVersion: mark.attrs.toolVersion ?? null,
        manualOverride: mark.attrs.manualOverride === true,
      });
    } else {
      // Unmarked text defaults to human
      raw.push({
        start: offset,
        end: offset + len,
        source: "human",
        model: null,
        traceId: null,
        toolName: null,
        toolVersion: null,
        manualOverride: false,
      });
    }

    offset += len;
  });

  // Merge adjacent spans with identical attributes
  return mergeSpans(raw);
}

function spanAttrsEqual(a: RawSpan, b: RawSpan): boolean {
  return (
    a.source === b.source &&
    a.model === b.model &&
    a.traceId === b.traceId &&
    a.toolName === b.toolName &&
    a.toolVersion === b.toolVersion &&
    a.manualOverride === b.manualOverride
  );
}

function mergeSpans(spans: RawSpan[]): AgentTraceSpan[] {
  if (spans.length === 0) return [];

  const merged: AgentTraceSpan[] = [];
  let current = { ...spans[0] };

  for (let i = 1; i < spans.length; i++) {
    const next = spans[i];
    if (current.end === next.start && spanAttrsEqual(current, next)) {
      current.end = next.end;
    } else {
      merged.push(current);
      current = { ...next };
    }
  }
  merged.push(current);

  return merged;
}

/**
 * Compute SHA-256 hex hash of the given text.
 * Uses Web Crypto API (available in browser and Tauri webview).
 */
export async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build a complete Agent Trace record from a ProseMirror document.
 */
export async function buildAgentTraceRecord(
  doc: ProseMirrorNode,
  documentId: string,
  documentTitle: string,
): Promise<AgentTraceRecord> {
  const fullText = doc.textContent;
  const contentHash = await sha256(fullText);
  const spans = extractSpans(doc);

  return {
    version: "0.1.0",
    type: "application/vnd.agent-trace.record+json",
    generatedAt: new Date().toISOString(),
    documentId,
    "dev.grimodex.documentTitle": documentTitle,
    contentHash,
    totalChars: fullText.length,
    spans,
  };
}

/**
 * Serialize an Agent Trace record to a JSON string for export.
 */
export function serializeRecord(record: AgentTraceRecord): string {
  return JSON.stringify(record, null, 2);
}
