/**
 * Trash 復元: text-fragment / structure 系から ProseMirror エディタ本文への挿入
 * (設計書 §5-C / §16.1)。
 *
 * 文字屑 (text-fragment) は spans を順に挿入し authorship mark を再付与する。
 * 構造アイテム (scene/codex/snippet/etc) はテキスト化したうえで挿入する。
 */
import type { Editor } from "@tiptap/core";
import { extractPlainText } from "@/features/codex/prosemirrorTextExtractor";
import type {
  CodexEntryPayload,
  ForeshadowPayload,
  GridChapterPayload,
  MapStickyPayload,
  ScenePayload,
  SnippetPayload,
  TextFragmentPayload,
  TrashItemData,
  TrashSpan,
} from "./types";

interface InsertContent {
  type: "text";
  text: string;
  marks?: Array<{
    type: string;
    attrs?: Record<string, unknown>;
  }>;
}

/**
 * 文字屑の spans を ProseMirror の content node 配列に変換。
 * authorship mark の各属性は AuthorshipMark.ts の default を踏襲。
 */
function spansToContent(spans: TrashSpan[]): InsertContent[] {
  return spans
    .filter((s) => s.text.length > 0)
    .map((span) => ({
      type: "text" as const,
      text: span.text,
      marks: [
        {
          type: "authorship",
          attrs: {
            source: span.source,
            timestamp: span.timestamp ?? null,
            model: span.model ?? null,
            chatMessageId: span.chatMessageId ?? null,
            traceId: span.traceId ?? null,
          },
        },
      ],
    }));
}

/**
 * 構造アイテム → 挿入用テキスト。各 subKind の payload からプレーンテキストを抽出。
 */
function structureItemToText(item: TrashItemData): string {
  switch (item.subKind) {
    case "scene": {
      const p = item.payload as ScenePayload;
      const body = extractPlainText(p.body ?? "");
      return p.title ? `${p.title}\n\n${body}` : body;
    }
    case "codex-entry": {
      const p = item.payload as CodexEntryPayload;
      const body = extractPlainText(p.body ?? "");
      return p.name ? `${p.name}\n\n${body}` : body;
    }
    case "snippet": {
      const p = item.payload as SnippetPayload;
      return extractPlainText(p.body ?? "");
    }
    case "map-sticky": {
      const p = item.payload as MapStickyPayload;
      return extractPlainText(p.body ?? "");
    }
    case "foreshadow": {
      const p = item.payload as ForeshadowPayload;
      return p.intent ? `${p.title} — ${p.intent}` : p.title;
    }
    case "grid-chapter": {
      const p = item.payload as GridChapterPayload;
      return p.title;
    }
    default:
      return item.previewText;
  }
}

/**
 * Trash item をエディタにテキスト挿入する。
 * - text-fragment: spans を authorship mark つきで挿入
 * - 構造アイテム: テキスト化して 1 つの paragraph に挿入 (authorship=human)
 *
 * 戻り値: 挿入できた文字数。0 = 何も挿入されなかった (空 payload など)。
 *
 * `programmaticInsert` メタを立てるので AiEditedPlugin 等の自動再分類は走らない。
 */
export function insertTrashItemIntoEditor(
  editor: Editor,
  item: TrashItemData,
): number {
  if (item.kind === "text-fragment") {
    const payload = item.payload as TextFragmentPayload;
    const content = spansToContent(payload.spans ?? []);
    if (content.length === 0) {
      // spans が空 (純テキスト保持のみ) → previewText を fallback で挿入
      const text = payload.text ?? item.previewText;
      if (!text) return 0;
      content.push({
        type: "text",
        text,
        marks: [
          {
            type: "authorship",
            attrs: {
              source: "human",
              timestamp: null,
              model: null,
              chatMessageId: null,
              traceId: null,
            },
          },
        ],
      });
    }
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.setMeta("programmaticInsert", true);
        tr.setMeta("trashBin.skip", true); // 再キャプチャ防止
        return true;
      })
      .insertContent(content)
      .run();
    return content.reduce((n, c) => n + [...c.text].length, 0);
  }

  // 構造アイテム → テキスト化
  const text = structureItemToText(item);
  if (!text) return 0;
  editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.setMeta("programmaticInsert", true);
      tr.setMeta("trashBin.skip", true);
      return true;
    })
    .insertContent(text)
    .run();
  return [...text].length;
}
