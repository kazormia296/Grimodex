import { useMemo, useState } from "react";
import { Search, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AiProvider } from "../types";
import { getProviderLabel } from "../providerLabels";
import {
  filterCatalog,
  groupCatalogByDeveloper,
  type CatalogModel,
  type CatalogSection,
} from "../chatModelCatalog";

interface ChatModelMenuProps {
  sections: CatalogSection[];
  loading: boolean;
  /** 現在選択中(プロバイダ + モデル ID + OpenAI 互換エンドポイント)。ハイライト用。 */
  current: {
    provider: AiProvider | undefined;
    modelId: string;
    /** OpenAI 互換で別エンドポイントを選んでいるときの endpoint id(他は undefined)。 */
    endpointId?: string | null;
  };
  onSelect: (model: CatalogModel) => void;
  /**
   * ビューポート内に収まる利用可能高さ(px)。アンカーの位置から算出して渡す。
   * 未指定時は 60vh にフォールバック。これを超える分はリストが内部スクロールする。
   */
  maxHeight?: number;
  /**
   * 任意: リスト先頭に固定する「継承 / 既定」行(beat ブロックのモデルピッカー用)。
   * チャット入力欄では使わない(省略)。検索クエリには影響されず常に先頭に出す。
   */
  inheritOption?: {
    label: string;
    active: boolean;
    onSelect: () => void;
  };
}

/**
 * チャット入力欄のモデル選択メニュー(複数プロバイダ横断)。
 * - 上部に横断検索。
 * - プロバイダをセクション見出しにした縦グループリスト。
 * - OpenRouter のみデベロッパーで二段ネスト(モデル数が多いため)。
 *
 * ポップオーバーの portal / アンカリングは呼び出し側(ChatInput)が担い、本コンポーネントは
 * 中身(検索 + リスト)だけを描画する。
 */
export function ChatModelMenu({
  sections,
  loading,
  current,
  onSelect,
  maxHeight,
  inheritOption,
}: ChatModelMenuProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () => filterCatalog(sections, query),
    [sections, query],
  );

  const isCurrent = (model: CatalogModel) =>
    model.provider === current.provider &&
    model.id === current.modelId &&
    // OpenAI 互換は同一モデル名が複数エンドポイントに出るため endpointId まで一致を要求する
    // (他プロバイダは双方 undefined で従来どおり)。
    (model.endpointId ?? undefined) === (current.endpointId ?? undefined);

  const renderModel = (model: CatalogModel) => (
    <button
      key={`${model.provider}:${model.endpointId ?? ""}:${model.id}`}
      type="button"
      onClick={() => onSelect(model)}
      className={[
        "flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs hover:bg-accent",
        isCurrent(model)
          ? "font-medium text-foreground"
          : "text-muted-foreground",
      ].join(" ")}
    >
      <Check
        className={[
          "h-3 w-3 shrink-0",
          isCurrent(model) ? "opacity-100" : "opacity-0",
        ].join(" ")}
      />
      <span className="truncate">{model.name}</span>
    </button>
  );

  const renderSectionBody = (section: CatalogSection) => {
    // OpenRouter は 1 プロバイダ内に多数のデベロッパーが混在するため二段ネスト。
    if (section.provider === "openrouter") {
      return groupCatalogByDeveloper(section.models).map(([dev, models]) => (
        <div key={dev || "_"}>
          {dev && (
            <div className="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/70">
              {dev}
            </div>
          )}
          {models.map(renderModel)}
        </div>
      ));
    }
    return section.models.map(renderModel);
  };

  return (
    // maxHeight はアンカー(ChatInput)が算出したビューポート可用高さ。
    // 内部の検索バーは固定(shrink-0)、リストは min-h-0 で縮んで内部スクロールする。
    <div
      className="flex w-72 flex-col"
      style={{ maxHeight: maxHeight != null ? `${maxHeight}px` : "60vh" }}
    >
      {/* 横断検索 */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2.5 py-1.5">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- ピッカーを開いたら即検索できるように
          autoFocus
          placeholder={t("chat.searchModelsPlaceholder")}
          aria-label={t("chat.searchModelsPlaceholder")}
          className="w-full bg-transparent text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
        />
      </div>

      <div className="min-h-0 overflow-y-auto py-1">
        {inheritOption && (
          <button
            type="button"
            data-testid="model-inherit-option"
            onClick={inheritOption.onSelect}
            className={[
              "flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs hover:bg-accent",
              inheritOption.active
                ? "font-medium text-foreground"
                : "text-muted-foreground",
            ].join(" ")}
          >
            <Check
              className={[
                "h-3 w-3 shrink-0",
                inheritOption.active ? "opacity-100" : "opacity-0",
              ].join(" ")}
            />
            <span className="truncate">{inheritOption.label}</span>
          </button>
        )}
        {sections.length === 0 && loading ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            {t("chat.loadingModels")}
          </p>
        ) : filtered.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            {t("chat.noModelsFound")}
          </p>
        ) : (
          filtered.map((section) => (
            <div key={section.endpointId ?? section.provider}>
              <div className="px-3 pt-1.5 pb-0.5 text-[11px] font-semibold text-foreground/80">
                {section.provider === "openai-compatible" &&
                section.endpointLabel
                  ? `${getProviderLabel(section.provider, t)}: ${section.endpointLabel}`
                  : getProviderLabel(section.provider, t)}
              </div>
              {renderSectionBody(section)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
