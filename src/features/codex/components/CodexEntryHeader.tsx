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
import { AliasesChip } from "./AliasesChip";
import { AliasesField } from "./AliasesField";
import { EntryHeroAvatar } from "./EntryHeroAvatar";
import { TagSelector } from "./TagSelector";
import { TagsChip } from "./TagsChip";
import { TypeBadge } from "./TypeBadge";

const KICKER_ICON: Record<CodexEntryType, typeof UserIcon> = {
  character: UserIcon,
  location: MapPin,
  item: Package,
  lore: BookOpen,
};

interface CodexEntryHeaderProps {
  entry: CodexEntry;
  name: string;
  type: CodexEntryType;
  icon: string | null;
  aliases: string[];
  selectedTags: CodexTag[];
  onNameChange: (value: string) => void;
  onNameCommit: () => void;
  onTypeChange: (type: CodexEntryType) => void;
  onIconChange: (icon: string | null) => void;
  onAliasesChange: (aliases: string[]) => void;
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
  selectedTags,
  onNameChange,
  onNameCommit,
  onTypeChange,
  onIconChange,
  onAliasesChange,
  onTagsChange,
  topActions,
  leadingAction,
}: CodexEntryHeaderProps) {
  const { t } = useTranslation();
  const KickerIcon = KICKER_ICON[type] ?? UserIcon;
  const originalName = useRef(name);

  const handleFocus = useCallback(() => {
    originalName.current = name;
  }, [name]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
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
        <div className="min-w-0">
          <input
            data-testid="codex-detail-name"
            type="text"
            value={name}
            placeholder={t("codex.namePlaceholder")}
            onChange={(e) => onNameChange(e.target.value)}
            onFocus={handleFocus}
            onBlur={onNameCommit}
            onKeyDown={handleKeyDown}
            className="-ml-1.5 block w-full rounded border border-transparent bg-transparent px-1.5 py-0.5 text-[40px] font-bold leading-[1.05] tracking-[-0.01em] text-foreground transition-colors hover:bg-accent/40 focus:border-transparent focus:bg-transparent focus:outline-none focus:ring-2 focus:ring-primary"
            style={{ fontFamily: "inherit" }}
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
