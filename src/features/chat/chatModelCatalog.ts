import type { AiModel, AiProvider } from "./types";
import { AI_PROVIDERS, modelDeveloper } from "./types";
import { overrideApiVariantForProvider } from "./aiNovelist";

/**
 * チャット入力欄のモデルピッカー(複数プロバイダ横断)で使う純ロジック。
 * UI 非依存 — プロバイダ別のモデル一覧を「セクション(プロバイダ見出し)」へ整列し、
 * 検索フィルタを掛けるだけ。表示ラベルの解決(i18n)とレンダリングは呼び出し側。
 */

/** ピッカー 1 行分のモデル。 */
export interface CatalogModel {
  id: string;
  name: string;
  provider: AiProvider;
  /**
   * 送信時に渡す解決済み API 経路(variant)。null = backend 既定解決。
   * 別プロバイダ選択時はこの値を chatModelVariantOverride として持たせる
   * (active provider の models 一覧に依存させない)。
   */
  variant: string | null;
}

/** プロバイダ 1 つ分のセクション(見出し + モデル列)。 */
export interface CatalogSection {
  provider: AiProvider;
  models: CatalogModel[];
}

/**
 * 1 プロバイダ分の AiModel[] を CatalogModel[] へ変換する。
 * variant は別プロバイダ送信で「明示が必要な経路」のみ持たせる
 * (overrideApiVariantForProvider: sakana=responses / 他=null=backend 既定解決)。
 * 注意: resolveModelApiVariant は persisted 無しだと任意モデルに "legacy" を返すため
 * 別プロバイダ送信には使えない(sakana が legacy に化け、ai のべりすと以外も legacy 化する)。
 */
function toCatalogModels(
  provider: AiProvider,
  models: AiModel[],
): CatalogModel[] {
  const variant = overrideApiVariantForProvider(provider);
  return models.map((m) => ({
    id: m.id,
    name: m.name || m.id,
    provider,
    variant,
  }));
}

/**
 * プロバイダ別モデル一覧を整列されたセクション配列にする。
 * - active プロバイダのセクションを先頭に置く(現在の文脈を最優先で見せる)。
 * - 残りは AI_PROVIDERS の定義順。
 * - モデルが 0 件のプロバイダはセクションごと落とす(空見出しを出さない)。
 */
export function buildModelCatalog(input: {
  activeProvider: AiProvider;
  providerModels: { provider: AiProvider; models: AiModel[] }[];
}): CatalogSection[] {
  const { activeProvider, providerModels } = input;
  const byProvider = new Map<AiProvider, AiModel[]>();
  for (const { provider, models } of providerModels) {
    // 同一プロバイダが複数回来ても最初の非空を採用(冪等)。
    if (!byProvider.has(provider) && models.length > 0) {
      byProvider.set(provider, models);
    }
  }

  const order: AiProvider[] = [
    activeProvider,
    ...AI_PROVIDERS.filter((p) => p !== activeProvider),
  ];

  const sections: CatalogSection[] = [];
  for (const provider of order) {
    const models = byProvider.get(provider);
    if (!models || models.length === 0) continue;
    sections.push({ provider, models: toCatalogModels(provider, models) });
  }
  return sections;
}

/**
 * 1 セクション分のモデルをデベロッパー(モデル ID のスラッシュ前)でサブグループ化する。
 * OpenRouter のように 1 プロバイダ内に多数のデベロッパーが混在する場合の二段表示用。
 * groupModelsByDeveloper(types) の CatalogModel 版(variant/provider を型保持する)。
 * 戻り値: [developerLabel, CatalogModel[]] のタプル配列(デベロッパー名昇順・空は末尾)。
 */
export function groupCatalogByDeveloper(
  models: CatalogModel[],
): [string, CatalogModel[]][] {
  const map = new Map<string, CatalogModel[]>();
  for (const m of models) {
    const dev = modelDeveloper(m.id);
    if (!map.has(dev)) map.set(dev, []);
    map.get(dev)!.push(m);
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => a.name.localeCompare(b.name));
  }
  return [...map.entries()].sort(([a], [b]) => {
    if (a === "") return 1;
    if (b === "") return -1;
    return a.localeCompare(b);
  });
}

/**
 * セクション群を検索クエリで絞る。クエリはモデル名 / モデル ID に対する
 * 部分一致(大文字小文字無視)。マッチが 0 件のセクションは落とす。
 * 空クエリはそのまま返す。
 */
export function filterCatalog(
  sections: CatalogSection[],
  query: string,
): CatalogSection[] {
  const q = query.trim().toLowerCase();
  if (!q) return sections;
  const out: CatalogSection[] = [];
  for (const section of sections) {
    const models = section.models.filter(
      (m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
    );
    if (models.length > 0) out.push({ ...section, models });
  }
  return out;
}

/**
 * グローバルなモデル whitelist(設定でチェックしたモデル id の配列)でセクションを絞る。
 *
 * `ai.modelWhitelist` は **全プロバイダ横断のグローバルな絞り込み**(設定 UI は
 * アクティブプロバイダのモデルを見せるが、保存先は単一のグローバル id 配列)。よって
 * ピッカーでも **全プロバイダのセクションに適用**し、チェックの入っていないモデルは
 * 出さない(アクティブプロバイダだけ絞ると、別プロバイダのセクションに未チェックの
 * モデルが残るバグになる)。
 *
 * whitelist が空なら絞り込み無効(全件表示=従来挙動)。マッチ 0 件のセクションは落とす。
 */
export function applyModelWhitelist(
  sections: CatalogSection[],
  whitelist: string[],
): CatalogSection[] {
  if (whitelist.length === 0) return sections;
  const allow = new Set(whitelist);
  const out: CatalogSection[] = [];
  for (const section of sections) {
    const models = section.models.filter((m) => allow.has(m.id));
    if (models.length > 0) out.push({ ...section, models });
  }
  return out;
}
