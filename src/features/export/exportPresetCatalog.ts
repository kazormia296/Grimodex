/**
 * exportPresetCatalog.ts — プリセット選択 UI（ExportPresetPicker）の optgroup
 * グルーピングを「プロジェクト言語」基準で組み立てる。
 *
 * 設計:
 *  - 表示順はプロジェクト言語で並べ替える。執筆言語と一致するプラットフォーム群を
 *    先頭（primary）に、もう一方の言語のプラットフォーム群を末尾（secondary）に置く。
 *  - 区分の元データは各プリセット meta の `region`（exportPresets.ts）。ここでは
 *    region を使って ja/en/汎用 を振り分けるが、aozora だけは「青空文庫テキスト」
 *    という汎用テキスト寄りの性格上、ja プロジェクトでは generic グループ側に置く
 *    （既存挙動の維持）。en プロジェクトでは日本語プラットフォーム群にまとめる。
 *  - HTML <select> は optgroup を畳めないので「畳む」=末尾にまとめて表示の意。
 */
import type { ExportPresetId } from "./types";
import {
  EXPORT_PRESET_IDS,
  EXPORT_PRESETS,
  type ExportPresetRegion,
} from "./exportPresets";

type BuiltinPresetId = Exclude<ExportPresetId, "custom">;

/** region 別のビルトイン ID（EXPORT_PRESET_IDS の宣言順を維持） */
function idsByRegion(region: ExportPresetRegion): BuiltinPresetId[] {
  return EXPORT_PRESET_IDS.filter(
    (id): id is BuiltinPresetId =>
      id !== "custom" &&
      EXPORT_PRESETS[id as BuiltinPresetId].region === region,
  );
}

export interface PresetGroup {
  /** optgroup ラベルの i18n キー */
  labelKey: string;
  ids: BuiltinPresetId[];
}

export interface PresetGroups {
  /** 執筆言語に一致する主プラットフォーム群（先頭表示） */
  primary: PresetGroup;
  /** 言語共通の汎用プリセット群（中段表示） */
  generic: PresetGroup;
  /** もう一方の言語のプラットフォーム群（末尾にまとめる） */
  secondary: PresetGroup;
}

/**
 * プロジェクト言語に応じた optgroup グルーピングを返す。
 *
 * @param projectLanguage settingsStore.projectLanguage（"ja" / "en" / ...）
 * @param currentPresetId 現在選択中のプリセット。region 不一致でも必ず
 *   いずれかのグループに含めるための安全網（保存済み narou を英語プロジェクトで
 *   開いても選択肢から消えないようにする）。
 */
export function getPresetGroups(
  projectLanguage: string,
  currentPresetId?: ExportPresetId,
): PresetGroups {
  // aozora は region "ja" だが UI 上は ja プロジェクトの generic 側に置くため除外。
  const jaPublishing = idsByRegion("ja").filter((id) => id !== "aozora");
  const enPublishing = idsByRegion("en");
  const genericCommon = idsByRegion("all");
  const aozora: BuiltinPresetId[] = ["aozora"];

  const groups: PresetGroups =
    projectLanguage === "en"
      ? {
          primary: {
            labelKey: "export.settings.preset.builtinGroup",
            ids: enPublishing,
          },
          generic: {
            labelKey: "export.settings.preset.genericGroup",
            ids: genericCommon,
          },
          secondary: {
            labelKey: "export.settings.preset.japanesePlatformsGroup",
            ids: [...jaPublishing, ...aozora],
          },
        }
      : {
          primary: {
            labelKey: "export.settings.preset.builtinGroup",
            ids: jaPublishing,
          },
          generic: {
            labelKey: "export.settings.preset.genericGroup",
            ids: [...aozora, ...genericCommon],
          },
          secondary: {
            labelKey: "export.settings.preset.englishPlatformsGroup",
            ids: enPublishing,
          },
        };

  // 安全網: 現在選択中のビルトインが（将来 region が増えた等の理由で）どの
  // グループにも入らない場合は secondary に追加して必ず選択可能にする。
  if (currentPresetId && currentPresetId !== "custom") {
    const present = [
      ...groups.primary.ids,
      ...groups.generic.ids,
      ...groups.secondary.ids,
    ].includes(currentPresetId);
    if (!present) {
      groups.secondary = {
        ...groups.secondary,
        ids: [...groups.secondary.ids, currentPresetId],
      };
    }
  }

  return groups;
}
