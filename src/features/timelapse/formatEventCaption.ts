/**
 * 執筆タイムラプス動画 — change_event を下部キャプション用の短いラベルに変換する。
 */

import type { ChangeEvent } from "@/db/schema";
import i18next from "i18next";
import type { BodyDiff, DiffOp } from "./bodyDiff";

export type CaptionSegmentKind = "meta" | "add" | "del" | "eq";

export interface CaptionSegment {
  text: string;
  kind: CaptionSegmentKind;
}

export interface FormattedCaption {
  segments: CaptionSegment[];
}

interface ParsedPayload {
  [key: string]: unknown;
}

export function parseEventPayload(
  event: Pick<ChangeEvent, "payload">,
): ParsedPayload {
  try {
    return JSON.parse(event.payload) as ParsedPayload;
  } catch {
    return {};
  }
}

function t(key: string, opts?: Record<string, unknown>): string {
  return i18next.t(key, { ...opts, defaultValue: key });
}

function metaLine(text: string): FormattedCaption {
  return { segments: [{ text, kind: "meta" }] };
}

function diffToSegments(diff: BodyDiff): CaptionSegment[] {
  const out: CaptionSegment[] = [];
  for (const [op, text] of diff.segments) {
    const kind: CaptionSegmentKind =
      op === 1 ? "add" : op === -1 ? "del" : "eq";
    out.push({ text, kind });
  }
  if (diff.truncated) {
    out.push({ text: "…", kind: "meta" });
  }
  return out;
}

function formatDiffs(
  diffs: Record<string, BodyDiff>,
  prefix: string,
): FormattedCaption | null {
  const keys = Object.keys(diffs);
  if (keys.length === 0) return null;
  const segments: CaptionSegment[] = [{ text: `${prefix}: `, kind: "meta" }];
  for (const key of keys) {
    const d = diffs[key];
    if (!d?.segments?.length) continue;
    segments.push({ text: `[${key}] `, kind: "meta" });
    segments.push(...diffToSegments(d));
  }
  return segments.length > 1 ? { segments } : null;
}

/** Collect open tool panel ids from a layout.snapshot payload. */
export function collectOpenPanels(payload: ParsedPayload): string[] {
  const layout = payload.layout as
    | {
        regions?: Record<string, { slots?: { activePanel?: string | null }[] }>;
        center?: {
          editorOpen?: boolean;
          segments?: { kind: string; activePanel?: string | null }[];
        };
      }
    | undefined;
  if (!layout) return [];
  const panels = new Set<string>();
  if (layout.center?.editorOpen) panels.add("editor");
  for (const seg of layout.center?.segments ?? []) {
    if (seg.kind === "tool" && seg.activePanel) panels.add(seg.activePanel);
  }
  for (const region of Object.values(layout.regions ?? {})) {
    for (const slot of region.slots ?? []) {
      if (slot.activePanel) panels.add(slot.activePanel);
    }
  }
  return [...panels].sort();
}

function formatLayoutSnapshot(
  payload: ParsedPayload,
  prevPanels: string[] | null,
): FormattedCaption | null {
  const current = collectOpenPanels(payload);
  const preset = payload.activePresetId as string | undefined;
  if (prevPanels) {
    const prevSet = new Set(prevPanels);
    const curSet = new Set(current);
    const opened = current.filter((p) => !prevSet.has(p));
    const closed = prevPanels.filter((p) => !curSet.has(p));
    if (opened.length === 0 && closed.length === 0 && !preset) {
      return null;
    }
    const parts: string[] = [];
    if (opened.length) {
      parts.push(
        t("timelapse.caption.layoutOpened", { panels: opened.join(", ") }),
      );
    }
    if (closed.length) {
      parts.push(
        t("timelapse.caption.layoutClosed", { panels: closed.join(", ") }),
      );
    }
    if (preset) {
      parts.push(t("timelapse.caption.layoutPreset", { preset }));
    }
    return metaLine(parts.join(" · "));
  }
  return metaLine(
    t("timelapse.caption.layoutState", {
      panels: current.length ? current.join(", ") : "—",
    }),
  );
}

const CHAT_TEXT_MAX = 80;

function truncateChat(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= CHAT_TEXT_MAX) return oneLine;
  return `${oneLine.slice(0, CHAT_TEXT_MAX)}…`;
}

/**
 * Caption dispatch for the planning / annotation / version / per-project-config
 * domains added in the record-all-domains expansion. These are metadata-only
 * (no doc.step), so a compact "<label> <verb> <name>" summary is enough for the
 * chrome band. Keeping one generic i18n key + per-domain labels + verbs avoids a
 * key explosion across ~16 domains × their op types. Also covers the
 * Rust-recorded `event` / `prose` / `foreshadow` events for parity.
 */
const NEW_DOMAIN_LABEL_KEY: Record<string, string> = {
  event: "timelapse.caption.domain.event",
  plot: "timelapse.caption.domain.plot",
  foreshadow: "timelapse.caption.domain.foreshadow",
  review: "timelapse.caption.domain.review",
  labels: "timelapse.caption.domain.labels",
  abtest: "timelapse.caption.domain.abtest",
  prompt: "timelapse.caption.domain.prompt",
  import: "timelapse.caption.domain.import",
  mount: "timelapse.caption.domain.mount",
  trash: "timelapse.caption.domain.trash",
  settings: "timelapse.caption.domain.settings",
  project: "timelapse.caption.domain.project",
  lint: "timelapse.caption.domain.lint",
  attribution: "timelapse.caption.domain.attribution",
  revision: "timelapse.caption.domain.revision",
  prose: "timelapse.caption.domain.prose",
};

const VERB_KEY: Record<string, string> = {
  create: "timelapse.caption.verb.create",
  add: "timelapse.caption.verb.create",
  update: "timelapse.caption.verb.update",
  set: "timelapse.caption.verb.update",
  rename: "timelapse.caption.verb.update",
  color: "timelapse.caption.verb.update",
  reorder: "timelapse.caption.verb.update",
  upsert: "timelapse.caption.verb.update",
  status: "timelapse.caption.verb.update",
  positions: "timelapse.caption.verb.update",
  save: "timelapse.caption.verb.update",
  evaluate: "timelapse.caption.verb.update",
  setup: "timelapse.caption.verb.update",
  meta: "timelapse.caption.verb.update",
  delete: "timelapse.caption.verb.delete",
  remove: "timelapse.caption.verb.delete",
  restore: "timelapse.caption.verb.restore",
  chosen: "timelapse.caption.verb.chosen",
  use: "timelapse.caption.verb.use",
  propose: "timelapse.caption.verb.propose",
  accept: "timelapse.caption.verb.accept",
  discard: "timelapse.caption.verb.discard",
  import: "timelapse.caption.verb.import",
  mark: "timelapse.caption.verb.update",
};

function verbFor(opType: string): string {
  const tail = opType.split(".").pop() ?? opType;
  return t(VERB_KEY[tail] ?? "timelapse.caption.verb.update");
}

function pickName(payload: ParsedPayload): string {
  for (const k of [
    "label",
    "title",
    "name",
    "preferred",
    "key",
    "kind",
    "id",
  ]) {
    const v = payload[k];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

function formatNewDomainCaption(
  domain: string,
  opType: string,
  payload: ParsedPayload,
): FormattedCaption | null {
  const labelKey = NEW_DOMAIN_LABEL_KEY[domain];
  if (!labelKey) return null;
  return metaLine(
    t("timelapse.caption.newDomain", {
      label: t(labelKey),
      verb: verbFor(opType),
      name: pickName(payload),
    }).trim(),
  );
}

/**
 * Format a single change_event for the video chrome band. Returns null for
 * events that should not appear as captions (editor scene doc.step, unknown ops).
 */
export function formatEventCaption(
  event: Pick<ChangeEvent, "domain" | "opType" | "payload" | "entityId">,
  options?: { prevLayoutPanels?: string[] | null },
): FormattedCaption | null {
  const { domain, opType } = event;
  const payload = parseEventPayload(event);

  if (domain === "editor" && opType === "doc.step") {
    return null;
  }

  if (domain === "codex" && opType === "doc.step") {
    return metaLine(t("timelapse.caption.codexEditing"));
  }
  if (domain === "snippet" && opType === "doc.step") {
    return metaLine(t("timelapse.caption.snippetEditing"));
  }

  if (opType === "entry.update" && domain === "codex") {
    const diffs = payload.diffs as Record<string, BodyDiff> | undefined;
    if (diffs && Object.keys(diffs).length > 0) {
      return formatDiffs(diffs, t("timelapse.caption.codex"));
    }
    const fields = payload.fields as string[] | undefined;
    if (fields?.length) {
      return metaLine(
        t("timelapse.caption.codexFields", { fields: fields.join(", ") }),
      );
    }
    return null;
  }

  if (opType === "snippet.update" && domain === "snippet") {
    const diffs = payload.diffs as Record<string, BodyDiff> | undefined;
    if (diffs && Object.keys(diffs).length > 0) {
      return formatDiffs(diffs, t("timelapse.caption.snippet"));
    }
    const fields = payload.fields as string[] | undefined;
    if (fields?.length) {
      return metaLine(
        t("timelapse.caption.snippetFields", { fields: fields.join(", ") }),
      );
    }
    return null;
  }

  if (opType === "sticky.update" && domain === "map") {
    const diffs = payload.diffs as Record<string, BodyDiff> | undefined;
    if (diffs?.body) {
      return formatDiffs(
        { body: diffs.body },
        t("timelapse.caption.mapSticky"),
      );
    }
    const fields = payload.fields as string[] | undefined;
    if (fields?.length) {
      return metaLine(
        t("timelapse.caption.mapFields", {
          op: opType,
          fields: fields.join(", "),
        }),
      );
    }
  }

  if (domain === "chat") {
    if (opType === "chat.message.add") {
      const role = String(payload.role ?? "?");
      const text = truncateChat(String(payload.text ?? ""));
      return metaLine(
        t("timelapse.caption.chatAdd", { role, text: text || "…" }),
      );
    }
    if (opType === "chat.message.delete") {
      return metaLine(t("timelapse.caption.chatDelete"));
    }
    if (opType === "chat.message.deleteFrom") {
      return metaLine(t("timelapse.caption.chatDeleteFrom"));
    }
  }

  if (domain === "layout" && opType === "layout.snapshot") {
    return formatLayoutSnapshot(payload, options?.prevLayoutPanels ?? null);
  }

  if (domain === "codex") {
    if (opType === "entry.create") {
      return metaLine(
        t("timelapse.caption.codexCreate", {
          name: String(payload.name ?? ""),
          type: String(payload.type ?? ""),
        }),
      );
    }
    if (opType === "entry.delete") {
      return metaLine(
        t("timelapse.caption.codexDelete", {
          name: String(payload.name ?? ""),
        }),
      );
    }
  }

  if (domain === "snippet") {
    if (opType === "snippet.create") {
      return metaLine(
        t("timelapse.caption.snippetCreate", {
          title: String(payload.title ?? ""),
        }),
      );
    }
    if (opType === "snippet.delete") {
      return metaLine(
        t("timelapse.caption.snippetDelete", {
          title: String(payload.title ?? ""),
        }),
      );
    }
  }

  if (
    domain === "grid" &&
    (opType === "tree.aiScaffold" || opType === "tree.aiReorganize")
  ) {
    const len = (v: unknown) => (Array.isArray(v) ? v.length : 0);
    return metaLine(
      t("timelapse.caption.aiTreeOp", {
        created: len(payload.createdIds),
        moved: len(payload.movedIds),
        renamed: len(payload.renamedIds),
      }),
    );
  }

  if (domain === "grid") {
    return metaLine(
      t("timelapse.caption.gridOp", {
        op: opType,
        title: String(payload.title ?? payload.id ?? ""),
      }),
    );
  }

  if (domain === "map") {
    return metaLine(t("timelapse.caption.mapOp", { op: opType }));
  }

  // Planning / annotation / version / per-project-config domains (+ the
  // Rust-recorded event/prose/foreshadow events).
  const newDomain = formatNewDomainCaption(domain, opType, payload);
  if (newDomain) return newDomain;

  return null;
}

/** Entity key for dual-record suppression (codex/snippet body edits). */
export function entityKeyForEvent(
  event: Pick<ChangeEvent, "domain" | "opType" | "entityId">,
): string | null {
  if (event.opType !== "doc.step") return null;
  if (event.domain === "codex" && event.entityId)
    return `codex:${event.entityId}`;
  if (event.domain === "snippet" && event.entityId) {
    return `snippet:${event.entityId}`;
  }
  return null;
}

/** Keys of entities that had a doc.step in the given event list. */
export function docStepEntityKeys(
  events: readonly Pick<ChangeEvent, "domain" | "opType" | "entityId">[],
): Set<string> {
  const keys = new Set<string>();
  for (const ev of events) {
    const k = entityKeyForEvent(ev);
    if (k) keys.add(k);
  }
  return keys;
}

export function isSceneEditorBodyStep(
  event: Pick<ChangeEvent, "domain" | "opType" | "sceneId">,
): boolean {
  return (
    event.domain === "editor" &&
    event.opType === "doc.step" &&
    event.sceneId != null
  );
}

/** Render target cursor map key. */
export type RenderTargetKey = string;

export function renderKeyFromDocStep(
  event: Pick<ChangeEvent, "domain" | "opType" | "sceneId" | "entityId">,
): RenderTargetKey | null {
  if (event.opType !== "doc.step") return null;
  if (event.domain === "editor" && event.sceneId) {
    return `scene:${event.sceneId}`;
  }
  if (event.domain === "codex" && event.entityId) {
    return `codex:${event.entityId}`;
  }
  if (event.domain === "snippet" && event.entityId) {
    return `snippet:${event.entityId}`;
  }
  return null;
}

export type { DiffOp };
