import { Node, mergeAttributes, type RawCommands } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { SceneBeatNodeView } from "./SceneBeatNodeView";
import { isBeatType, type BeatType } from "./beat/beatTypes";

export { BEAT_TYPES, type BeatType } from "./beat/beatTypes";

/**
 * SceneBeatNode — Placed beat (本文中の Beat block).
 * Inline content: 著者の構成意図テキスト + Codex メンション + 角括弧記法。
 * 生成された prose は generatedProseBlock 側に格納され、Beat 自身は残る。
 */
export const SceneBeatNode = Node.create({
  name: "sceneBeat",
  group: "block",
  content: "inline*",
  defining: true,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-beat-id"),
        renderHTML: (attrs) => (attrs.id ? { "data-beat-id": attrs.id } : {}),
      },
      collapsed: {
        default: false,
        parseHTML: (element) =>
          element.getAttribute("data-collapsed") === "true",
        renderHTML: (attrs) =>
          attrs.collapsed ? { "data-collapsed": "true" } : {},
      },
      beatType: {
        default: "free" as BeatType,
        parseHTML: (element) => {
          const raw = element.getAttribute("data-beat-type");
          return isBeatType(raw) ? raw : "free";
        },
        renderHTML: (attrs) => ({
          "data-beat-type": isBeatType(attrs.beatType)
            ? attrs.beatType
            : "free",
        }),
      },
      pov: {
        default: null as string | null,
        parseHTML: (element) => element.getAttribute("data-pov") || null,
        renderHTML: (attrs) => (attrs.pov ? { "data-pov": attrs.pov } : {}),
      },
      model: {
        default: null as string | null,
        parseHTML: (element) => element.getAttribute("data-beat-model") || null,
        renderHTML: (attrs) =>
          attrs.model ? { "data-beat-model": attrs.model } : {},
      },
      // マルチプロバイダ対応: model だけでなく送信先プロバイダ / API 経路 /
      // OpenAI 互換エンドポイントも beat ごとに永続化する。null = 既定(設定の
      // アクティブプロバイダ)へ継承。旧 beat は model のみ持つ(これらは null)。
      modelProvider: {
        default: null as string | null,
        parseHTML: (element) =>
          element.getAttribute("data-beat-model-provider") || null,
        renderHTML: (attrs) =>
          attrs.modelProvider
            ? { "data-beat-model-provider": attrs.modelProvider }
            : {},
      },
      modelVariant: {
        default: null as string | null,
        parseHTML: (element) =>
          element.getAttribute("data-beat-model-variant") || null,
        renderHTML: (attrs) =>
          attrs.modelVariant
            ? { "data-beat-model-variant": attrs.modelVariant }
            : {},
      },
      modelEndpointId: {
        default: null as string | null,
        parseHTML: (element) =>
          element.getAttribute("data-beat-model-endpoint") || null,
        renderHTML: (attrs) =>
          attrs.modelEndpointId
            ? { "data-beat-model-endpoint": attrs.modelEndpointId }
            : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="scene-beat"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(
        { "data-type": "scene-beat", class: "scene-beat" },
        HTMLAttributes,
      ),
      0,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(SceneBeatNodeView);
  },

  addCommands() {
    return {
      insertSceneBeat:
        (
          attrs?: Partial<{
            id: string;
            beatType: BeatType;
            pov: string | null;
          }>,
        ) =>
        ({ commands }) => {
          const id = attrs?.id ?? crypto.randomUUID();
          return commands.insertContent({
            type: this.name,
            attrs: {
              id,
              beatType: attrs?.beatType ?? "free",
              pov: attrs?.pov ?? null,
              collapsed: false,
            },
          });
        },
    } as Partial<RawCommands>;
  },
});

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    sceneBeat: {
      insertSceneBeat: (
        attrs?: Partial<{
          id: string;
          beatType: BeatType;
          pov: string | null;
        }>,
      ) => ReturnType;
    };
  }
}
