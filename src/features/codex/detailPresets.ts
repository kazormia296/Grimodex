import type { CodexDetailDefinition } from "./detailApi";
import { createDefinition, listDefinitionsByType } from "./detailApi";
import type { GenreValue } from "@/features/project/genreOptions";

export interface DetailFieldPreset {
  name: string;
  fieldType: "text" | "dropdown";
  /** dropdown のみ。fieldConfig JSON の options に展開される */
  options?: readonly string[];
  includeInContext: boolean;
}

export type DetailPresetsByType = Readonly<
  Record<string, readonly DetailFieldPreset[]>
>;

const text = (name: string): DetailFieldPreset => ({
  name,
  fieldType: "text",
  includeInContext: true,
});

const dropdown = (
  name: string,
  options: readonly string[],
): DetailFieldPreset => ({
  name,
  fieldType: "dropdown",
  options,
  includeInContext: true,
});

/** 全ジャンル共通の基本セット（組み込み4タイプ別） */
export const BASE_DETAIL_PRESETS: DetailPresetsByType = {
  character: [
    dropdown("役割", ["主人公", "主要人物", "脇役", "敵対者", "モブ"]),
    text("年齢"),
    text("外見"),
    text("性格"),
    text("口調・一人称"),
    text("動機・目的"),
  ],
  location: [
    dropdown("重要度", ["主要舞台", "サブ舞台", "言及のみ"]),
    text("地理・位置"),
    text("雰囲気"),
    text("住人・関係勢力"),
    text("五感の特徴"),
  ],
  item: [text("外観"), text("所有者"), text("能力・機能"), text("由来・来歴")],
  lore: [
    dropdown("区分", [
      "歴史",
      "文化・風習",
      "組織・勢力",
      "法則・ルール",
      "その他",
    ]),
    dropdown("作中での認知度", ["周知の事実", "一部のみ知る", "秘匿"]),
    text("関連人物"),
    text("物語への影響"),
  ],
};

/**
 * ジャンル別の追加フィールド。キーは projects.genre の保存値
 * (GENRE_VALUES) に揃える。"Other" は追加なし＝基本セットのみ。
 */
export const GENRE_DETAIL_PRESETS: Readonly<
  Partial<Record<GenreValue, DetailPresetsByType>>
> = {
  Fantasy: {
    character: [text("種族"), text("魔法・特殊能力")],
    location: [text("支配勢力")],
    item: [dropdown("希少度", ["ありふれた", "希少", "伝説級", "唯一無二"])],
    lore: [text("魔法・超常のルール")],
  },
  "Sci-Fi": {
    character: [text("所属・出身"), text("身体拡張・改造")],
    location: [text("技術水準")],
    item: [text("動作原理")],
    lore: [text("科学的設定・根拠")],
  },
  Mystery: {
    character: [text("アリバイ")],
    location: [text("構造・見取り")],
    item: [text("手がかりとしての意味")],
  },
  Horror: {
    character: [text("恐怖の対象・トラウマ")],
    location: [text("怪異・異変の痕跡")],
    item: [text("呪い・禁忌")],
    lore: [text("怪異のルール")],
  },
  Romance: {
    character: [text("恋愛観"), text("相手への現在の感情")],
    location: [text("二人の思い出")],
  },
  Thriller: {
    character: [text("所属組織"), text("特技・スキル")],
    location: [text("警備・危険度")],
    item: [text("入手経路")],
  },
  Literary: {
    character: [text("内面の葛藤"), text("象徴するもの")],
    location: [text("象徴性")],
    lore: [text("主題との関係")],
  },
  Historical: {
    character: [
      dropdown("史実との関係", ["実在人物", "モデルあり", "架空"]),
      text("身分・階級"),
    ],
    location: [text("時代考証メモ")],
    item: [text("時代考証メモ")],
  },
};

/** 追加フィールドを持つジャンル（ピッカーの選択肢） */
export const PRESET_GENRES: readonly GenreValue[] = Object.keys(
  GENRE_DETAIL_PRESETS,
) as GenreValue[];

export function resolvePresetFields(
  typeSlug: string,
  genre: string | null,
): DetailFieldPreset[] {
  const base = BASE_DETAIL_PRESETS[typeSlug] ?? [];
  const extras =
    (genre && GENRE_DETAIL_PRESETS[genre as GenreValue]?.[typeSlug]) || [];
  return [...base, ...extras];
}

export interface ApplyDetailPresetResult {
  added: CodexDetailDefinition[];
  skipped: number;
}

/**
 * プリセットのフィールド定義を一括追加する。
 * 既存と同名のフィールドはスキップ（(project, type, name) UNIQUE 準拠の冪等適用）。
 */
export async function applyDetailPreset(
  projectId: string,
  typeSlug: string,
  genre: string | null,
): Promise<ApplyDetailPresetResult> {
  const fields = resolvePresetFields(typeSlug, genre);
  const existing = await listDefinitionsByType(projectId, typeSlug);
  const existingNames = new Set(existing.map((d) => d.name));
  let sortOrder = Math.max(0, ...existing.map((d) => d.sortOrder));

  const added: CodexDetailDefinition[] = [];
  let skipped = 0;
  for (const field of fields) {
    if (existingNames.has(field.name)) {
      skipped += 1;
      continue;
    }
    sortOrder += 1.0;
    let def: CodexDetailDefinition;
    try {
      def = await createDefinition({
        id: crypto.randomUUID(),
        projectId,
        typeSlug,
        name: field.name,
        fieldType: field.fieldType,
        fieldConfig: field.options
          ? JSON.stringify({ options: field.options })
          : null,
        sortOrder,
        includeInContext: field.includeInContext ? 1 : 0,
      });
    } catch (err) {
      // 並行ライター (別ウィンドウ/MCP) との TOCTOU で UNIQUE に
      // 当たったら冪等スキップに畳む。それ以外は失敗として伝播。
      if (String(err).includes("UNIQUE")) {
        skipped += 1;
        continue;
      }
      throw err;
    }
    added.push(def);
    existingNames.add(field.name);
  }
  return { added, skipped };
}
