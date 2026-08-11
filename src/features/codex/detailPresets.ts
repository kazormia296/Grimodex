import type { CodexDetailDefinition } from "./detailApi";
import { createDefinition, listDefinitionsByType } from "./detailApi";
import type { GenreValue } from "@/features/project/genreOptions";
import type {
  DetailProjectionKind,
  DetailTemporalPolicy,
  StateFacet,
} from "./details/semanticBindingTypes";

export interface DetailFieldPresetSemantic {
  readonly facetKey: StateFacet;
  readonly projectionKind: DetailProjectionKind;
  readonly temporalPolicy: DetailTemporalPolicy;
}

export interface DetailFieldPreset {
  readonly name: string;
  readonly fieldType: "text" | "dropdown";
  /** dropdown のみ。fieldConfig JSON の options に展開される */
  readonly options?: readonly string[];
  readonly includeInContext: boolean;
  readonly semantic?: DetailFieldPresetSemantic;
}

export type DetailPresetsByType = Readonly<
  Record<string, readonly DetailFieldPreset[]>
>;

const ROLE_CURRENT_SEMANTIC = Object.freeze({
  facetKey: "role.current",
  projectionKind: "enum",
  temporalPolicy: "base-and-phase",
} as const satisfies DetailFieldPresetSemantic);

const IDENTITY_AGE_SEMANTIC = Object.freeze({
  facetKey: "identity.age",
  projectionKind: "scalar-text",
  temporalPolicy: "derived",
} as const satisfies DetailFieldPresetSemantic);

const GOAL_ACTIVE_SEMANTIC = Object.freeze({
  facetKey: "goal.active",
  projectionKind: "summary-text",
  temporalPolicy: "phase-on-durable-change",
} as const satisfies DetailFieldPresetSemantic);

const text = (
  name: string,
  semantic?: DetailFieldPresetSemantic,
): DetailFieldPreset => ({
  name,
  fieldType: "text",
  includeInContext: true,
  ...(semantic ? { semantic } : {}),
});

const dropdown = (
  name: string,
  options: readonly string[],
  semantic?: DetailFieldPresetSemantic,
): DetailFieldPreset => ({
  name,
  fieldType: "dropdown",
  options,
  includeInContext: true,
  ...(semantic ? { semantic } : {}),
});

/** 全ジャンル共通の基本セット（組み込み4タイプ別） */
export const BASE_DETAIL_PRESETS: DetailPresetsByType = {
  character: [
    dropdown(
      "役割",
      ["主人公", "主要人物", "脇役", "敵対者", "モブ"],
      ROLE_CURRENT_SEMANTIC,
    ),
    text("年齢", IDENTITY_AGE_SEMANTIC),
    text("外見"),
    text("性格"),
    text("口調・一人称"),
    text("動機・目的", GOAL_ACTIVE_SEMANTIC),
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

/**
 * 英語版・全ジャンル共通の基本セット。フィールド名/選択肢は DB に焼き込まれ
 * AI コンテキスト (contextBuilder の `fieldName: value`) にも流れるため、
 * en プロジェクトでは英語で焼き込む。ja とは別オブジェクトにして ja を不変に保つ。
 */
export const BASE_DETAIL_PRESETS_EN: DetailPresetsByType = {
  character: [
    dropdown(
      "Role",
      [
        "Protagonist",
        "Major character",
        "Supporting",
        "Antagonist",
        "Background",
      ],
      ROLE_CURRENT_SEMANTIC,
    ),
    text("Age", IDENTITY_AGE_SEMANTIC),
    text("Appearance"),
    text("Personality"),
    text("Voice & speech style"),
    text("Motivation & goals", GOAL_ACTIVE_SEMANTIC),
  ],
  location: [
    dropdown("Importance", [
      "Main setting",
      "Secondary setting",
      "Mentioned only",
    ]),
    text("Geography & location"),
    text("Atmosphere"),
    text("Inhabitants & factions"),
    text("Sensory details"),
  ],
  item: [
    text("Appearance"),
    text("Owner"),
    text("Abilities & function"),
    text("Origin & history"),
  ],
  lore: [
    dropdown("Category", [
      "History",
      "Culture & customs",
      "Organizations & factions",
      "Laws & rules",
      "Other",
    ]),
    dropdown("In-world awareness", [
      "Common knowledge",
      "Known to few",
      "Hidden/secret",
    ]),
    text("Related characters"),
    text("Impact on the story"),
  ],
};

/** 英語版・ジャンル別の追加フィールド。キーは ja 版と同一 (GenreValue)。 */
export const GENRE_DETAIL_PRESETS_EN: Readonly<
  Partial<Record<GenreValue, DetailPresetsByType>>
> = {
  Fantasy: {
    character: [text("Species/race"), text("Magic & special abilities")],
    location: [text("Ruling power")],
    item: [
      dropdown("Rarity", ["Common", "Rare", "Legendary", "One of a kind"]),
    ],
    lore: [text("Magic & supernatural rules")],
  },
  "Sci-Fi": {
    character: [
      text("Affiliation & origin"),
      text("Augmentations & modifications"),
    ],
    location: [text("Technology level")],
    item: [text("Operating principle")],
    lore: [text("Scientific premise & rationale")],
  },
  Mystery: {
    character: [text("Alibi")],
    location: [text("Layout & floor plan")],
    item: [text("Significance as a clue")],
  },
  Horror: {
    character: [text("Fears & trauma")],
    location: [text("Signs of the uncanny")],
    item: [text("Curse/taboo")],
    lore: [text("Rules of the supernatural")],
  },
  Romance: {
    character: [
      text("View on romance"),
      text("Current feelings toward the other"),
    ],
    location: [text("Shared memories")],
  },
  Thriller: {
    character: [text("Organization"), text("Skills & expertise")],
    location: [text("Security & danger level")],
    item: [text("How it was obtained")],
  },
  Literary: {
    character: [text("Inner conflict"), text("What they symbolize")],
    location: [text("Symbolism")],
    lore: [text("Relation to the theme")],
  },
  Historical: {
    character: [
      dropdown("Relation to history", [
        "Real figure",
        "Based on a real person",
        "Fictional",
      ]),
      text("Status & class"),
    ],
    location: [text("Historical accuracy notes")],
    item: [text("Historical accuracy notes")],
  },
};

/** project 言語に対応する基本/ジャンル別プリセット集合 (en 以外は ja)。 */
function presetsForLang(lang?: string | null): {
  base: DetailPresetsByType;
  byGenre: Readonly<Partial<Record<GenreValue, DetailPresetsByType>>>;
} {
  return lang?.startsWith("en")
    ? { base: BASE_DETAIL_PRESETS_EN, byGenre: GENRE_DETAIL_PRESETS_EN }
    : { base: BASE_DETAIL_PRESETS, byGenre: GENRE_DETAIL_PRESETS };
}

/**
 * 追加フィールドを持つジャンル（ピッカーの選択肢）。ja/en で同一キーなので
 * 言語非依存。
 */
export const PRESET_GENRES: readonly GenreValue[] = Object.keys(
  GENRE_DETAIL_PRESETS,
) as GenreValue[];

export function resolvePresetFields(
  typeSlug: string,
  genre: string | null,
  lang?: string | null,
): DetailFieldPreset[] {
  const { base, byGenre } = presetsForLang(lang);
  const baseFields = base[typeSlug] ?? [];
  const extras = (genre && byGenre[genre as GenreValue]?.[typeSlug]) || [];
  return [...baseFields, ...extras];
}

export interface ApplyDetailPresetResult {
  added: CodexDetailDefinition[];
  skipped: number;
}

/**
 * プリセットのフィールド定義を一括追加する。
 * 既存と同名のフィールドはスキップ（(project, type, name) UNIQUE 準拠の冪等適用）。
 * semantic 付きフィールドは Definition と同じ transaction で Binding を書く。
 */
export async function applyDetailPreset(
  projectId: string,
  typeSlug: string,
  genre: string | null,
  lang?: string | null,
): Promise<ApplyDetailPresetResult> {
  const fields = resolvePresetFields(typeSlug, genre, lang);
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
    const id = crypto.randomUUID();
    const definition = await createDefinition({
      id,
      projectId,
      typeSlug,
      name: field.name,
      fieldType: field.fieldType,
      fieldConfig: field.options
        ? JSON.stringify({ options: field.options })
        : null,
      sortOrder,
      includeInContext: field.includeInContext ? 1 : 0,
      ...(field.semantic
        ? {
            semanticBinding: {
              id: crypto.randomUUID(),
              facetKey: field.semantic.facetKey,
              projectionKind: field.semantic.projectionKind,
              temporalPolicy: field.semantic.temporalPolicy,
              source: "preset" as const,
              confirmed: false,
            },
          }
        : {}),
    });
    added.push(definition);
    existingNames.add(field.name);
  }

  return { added, skipped };
}
