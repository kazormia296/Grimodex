import { useCallback, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  BookOpen,
  MapPin,
  Package,
  Plus,
  User as UserIcon,
} from "lucide-react";
import type { CodexEntry, CodexEntryType } from "../api";
import type { CodexTag } from "../tagApi";
import { useFitsInline } from "@/hooks/useFitsInline";
import { useFitFontSize } from "@/hooks/useFitFontSize";
import { useAutoGrowHeight } from "@/hooks/useAutoGrowHeight";
import { useCurrentProject } from "@/features/project/projectStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { codexNameFontStyle } from "./codexNameFont";
import { AliasesChip } from "./AliasesChip";
import { AliasesField } from "./AliasesField";
import { EntryHeroAvatar } from "./EntryHeroAvatar";
import { TagSelector } from "./TagSelector";
import { TagsChip } from "./TagsChip";
import { TypeBadge } from "./TypeBadge";
import { ChipSkeletonList } from "@/components/ui/skeleton-patterns";
import type { ReadingMap } from "../reading";
import { HeroReading } from "./HeroReading";

const KICKER_ICON: Record<CodexEntryType, typeof UserIcon> = {
  character: UserIcon,
  location: MapPin,
  item: Package,
  lore: BookOpen,
};

// 名前の駅名標サイズ。収まれば BASE のまま、はみ出すと MIN まで縮小し、
// それでも収まらなければ折り返す。PADDING は textarea の text content box と
// container 幅の差: px-1.5 (6px×2) + border-transparent (1px×2) = 14px。
const NAME_BASE_PX = 50;
const NAME_MIN_PX = 24;
const NAME_PADDING_PX = 14;

interface CodexEntryHeaderProps {
  entry: CodexEntry;
  name: string;
  type: CodexEntryType;
  icon: string | null;
  aliases: string[];
  readings: ReadingMap;
  showReading: boolean;
  selectedTags: CodexTag[];
  tagsLoading?: boolean;
  onNameChange: (value: string) => void;
  onNameCommit: () => void;
  onPrimaryReadingCommit: (reading: string) => void;
  onTypeChange: (type: CodexEntryType) => void;
  onIconChange: (icon: string | null) => void;
  onAliasesChange: (aliases: string[]) => void;
  onOpenReadings: () => void;
  onTagsChange: (tags: CodexTag[]) => void;
  /** Slot for top-right utility buttons (e.g. history / delete). */
  topActions?: ReactNode;
  /** Slot for top-left utility button (e.g. back). */
  leadingAction?: ReactNode;
}

export function CodexEntryHeader({
  entry,
  name,
  type,
  icon,
  aliases,
  readings,
  showReading,
  selectedTags,
  tagsLoading = false,
  onNameChange,
  onNameCommit,
  onPrimaryReadingCommit,
  onTypeChange,
  onIconChange,
  onAliasesChange,
  onOpenReadings,
  onTagsChange,
  topActions,
  leadingAction,
}: CodexEntryHeaderProps) {
  const { t } = useTranslation();
  const KickerIcon = KICKER_ICON[type] ?? UserIcon;
  const originalName = useRef(name);

  // 名称欄の表示用スタイル (font/weight/字間)。フォントは設定 codex.entryTitleFont で
  // 変更可 (既定は言語別: 英語プロジェクトは駅名標フォントを Helvetica 系 TeX Gyre Heros
  // の Bold・やや詰め字間に差し替える)。名前は作品の内容なので、フォント既定の言語判定は
  // UI 言語ではなくプロジェクト言語で行う (editor-en-typography と同流儀。Heros は CJK
  // グリフを持たないため、UI 言語で切り替えると日本語名が壊れる)。計測 span と可視
  // textarea で必ず同じ値を使う (字幅に効く weight/字間も含め採寸の整合のため —
  // codexNameFont.ts 参照)。
  const entryTitleFont = useSettingsStore((s) => s.get("codex.entryTitleFont"));
  const nameFontStyle = codexNameFontStyle(
    useCurrentProject()?.language,
    entryTitleFont,
  );

  // 名前を 1 行に収まるよう自動縮小 (収まる時は NAME_BASE_PX のまま)。下限を割ると
  // textarea の soft-wrap で折り返す。
  const nameRef = useRef<HTMLTextAreaElement>(null);
  const { containerRef, measureRef, fontSize } = useFitFontSize({
    baseSizePx: NAME_BASE_PX,
    minSizePx: NAME_MIN_PX,
    horizontalPaddingPx: NAME_PADDING_PX,
  });

  // 折り返しで増えた行に合わせて textarea を縦に伸ばす。内容・フォントだけでなく
  // 幅変化にも追従する必要がある (フォントが下限に張り付くと fontSize が変わらず
  // 幅だけ縮むため、deps では捉えられず折り返しがクリップされる)。
  useAutoGrowHeight(nameRef, `${name}|${fontSize}`);

  const handleFocus = useCallback(() => {
    originalName.current = name;
  }, [name]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // IME 変換確定の Enter (長い日本語名で頻出) を commit と誤認しない。
      if (e.nativeEvent.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        e.currentTarget.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onNameChange(originalName.current);
        e.currentTarget.blur();
      }
    },
    [onNameChange],
  );

  const tagsFit = useFitsInline();
  const aliasesFit = useFitsInline();

  return (
    <div className="shrink-0 px-7 pt-3">
      {/* Kicker row: [back?] [type-icon] [TypeBadge]    [history][delete] */}
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {leadingAction}
          <KickerIcon
            className="h-3 w-3 shrink-0 text-muted-foreground/80"
            strokeWidth={2}
          />
          <TypeBadge type={type} onChange={onTypeChange} />
        </div>
        {topActions && (
          <div className="flex shrink-0 items-center gap-0.5">{topActions}</div>
        )}
      </div>

      {/* Hero block: name + tags + aliases (left col) | avatar (right col).
          Chip rows live inside col 1 so they wrap/group at the avatar's left
          edge instead of extending under it. */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-6">
        <div ref={containerRef} className="relative min-w-0">
          <HeroReading
            name={name}
            readings={readings}
            enabled={showReading}
            onCommit={onPrimaryReadingCommit}
            onOpen={onOpenReadings}
          />
          {/* 計測専用: 常に BASE サイズ・1 行・max-content。可視 textarea とは独立
              させて縮小⇄計測のフィードバックループを断つ。 */}
          <span
            ref={measureRef}
            aria-hidden="true"
            className="pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap"
            style={{
              width: "max-content",
              fontSize: `${NAME_BASE_PX}px`,
              ...nameFontStyle,
            }}
          >
            {name}
          </span>
          <textarea
            ref={nameRef}
            data-testid="codex-detail-name"
            rows={1}
            value={name}
            placeholder={t("codex.namePlaceholder")}
            // textarea は input と違いペーストの改行を保持する。タイトルは論理的に
            // 1 行 (折り返しは見た目のみ) なので改行をスペースに畳む。
            onChange={(e) =>
              onNameChange(e.target.value.replace(/\r?\n/g, " "))
            }
            onFocus={handleFocus}
            onBlur={onNameCommit}
            onKeyDown={handleKeyDown}
            className="-ml-1.5 block w-full resize-none overflow-hidden rounded border border-transparent bg-transparent px-1.5 py-0.5 leading-[1.1] text-foreground transition-colors hover:bg-accent/40 focus:border-transparent focus:bg-transparent focus:outline-none focus:ring-2 focus:ring-primary"
            style={{
              fontSize: `${fontSize}px`,
              ...nameFontStyle,
            }}
          />

          {/* Aliases row — individual chips if they fit, otherwise grouped chip */}
          <div ref={aliasesFit.containerRef} className="relative mt-1 min-w-0">
            <AliasesMeasure
              ref={aliasesFit.measureRef}
              label={t("codex.aliasesLabel")}
              aliases={aliases}
              addLabel={t("codex.addAlias")}
            />
            {aliasesFit.fits ? (
              <AliasesField
                label={t("codex.aliasesLabel")}
                aliases={aliases}
                onChange={onAliasesChange}
                variant="hero"
              />
            ) : (
              <AliasesChip aliases={aliases} onChange={onAliasesChange} />
            )}
          </div>

          {/* Tags row — individual pills if they fit, otherwise grouped chip */}
          <div
            ref={tagsFit.containerRef}
            data-testid="codex-detail-tags"
            className="relative mt-2 min-w-0"
          >
            {tagsLoading ? (
              <ChipSkeletonList testId="codex-detail-tags-loading" />
            ) : (
              <>
                <TagsMeasure
                  ref={tagsFit.measureRef}
                  tags={selectedTags}
                  addLabel={t("codex.tagSelector.addTag")}
                />
                {tagsFit.fits ? (
                  <TagSelector
                    entryId={entry.id}
                    entryType={type}
                    selectedTags={selectedTags}
                    onTagsChange={onTagsChange}
                  />
                ) : (
                  <TagsChip
                    entryId={entry.id}
                    entryType={type}
                    selectedTags={selectedTags}
                    onTagsChange={onTagsChange}
                  />
                )}
              </>
            )}
          </div>
        </div>

        <EntryHeroAvatar
          icon={icon}
          entryType={type}
          name={name}
          onIconChange={onIconChange}
        />
      </div>
    </div>
  );
}

/* ---------- measure-only stand-ins (no testids, no interaction) ---------- */

interface TagsMeasureProps {
  ref: React.Ref<HTMLDivElement>;
  tags: CodexTag[];
  addLabel: string;
}

function TagsMeasure({ ref, tags, addLabel }: TagsMeasureProps) {
  return (
    <div
      ref={ref}
      aria-hidden="true"
      style={{ width: "max-content" }}
      className="pointer-events-none invisible absolute left-0 top-0 flex flex-nowrap items-center gap-1"
    >
      {tags.map((tag) => (
        <span
          key={tag.id}
          className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
        >
          {tag.name}
          <span className="ml-0.5">×</span>
        </span>
      ))}
      <span className="rounded-full border border-dashed px-1.5 py-0.5 text-[10px]">
        {addLabel}
      </span>
    </div>
  );
}

interface AliasesMeasureProps {
  ref: React.Ref<HTMLDivElement>;
  label: string;
  aliases: string[];
  addLabel: string;
}

function AliasesMeasure({
  ref,
  label,
  aliases,
  addLabel,
}: AliasesMeasureProps) {
  return (
    <div
      ref={ref}
      aria-hidden="true"
      style={{ width: "max-content" }}
      className="pointer-events-none invisible absolute left-0 top-0 flex flex-nowrap items-center gap-1.5"
    >
      <span className="text-[11px] tracking-[0.04em]">{label}</span>
      {aliases.map((alias, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1.5 rounded border py-[3px] pl-[9px] pr-[4px] text-xs"
        >
          {alias}
          <span>×</span>
        </span>
      ))}
      <span className="inline-flex items-center gap-1 rounded border border-dashed px-2 py-[3px] text-xs">
        <Plus className="h-2.5 w-2.5" />
        {addLabel}
      </span>
    </div>
  );
}
