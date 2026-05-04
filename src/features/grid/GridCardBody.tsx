import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { parseBeatPreview } from "./parseBeatPreview";
import { InlineSynopsisEditor } from "@/features/editor/InlineSynopsisEditor";
import {
  editUnplacedBeatFromGrid,
  loadBeatTextByIndex,
} from "@/features/editor/beat/editUnplacedBeatFromGrid";
import { useGridStore } from "./gridStore";

type Tab = "beat" | "synopsis";

const BEAT_VISIBLE_LIMIT = 3;

interface Props {
  nodeId: string;
  synopsis: string | null;
  unplacedBeatPreview: string | null;
  showSynopsis: boolean;
  showBeats: boolean;
  compact?: boolean;
  onEditingChange?: (editing: boolean) => void;
  /** Called when the empty Beat tab's "+ Beat を追加" prompt is clicked. */
  onRequestAddBeat?: () => void;
}

export function GridCardBody({
  nodeId,
  synopsis,
  unplacedBeatPreview,
  showSynopsis,
  showBeats,
  compact,
  onEditingChange,
  onRequestAddBeat,
}: Props) {
  const { t } = useTranslation();

  const beats = parseBeatPreview(unplacedBeatPreview);
  const hasBeats = !!beats && beats.length > 0;
  const hasSynopsis = !!synopsis?.trim();

  const beatTabVisible = showBeats;
  const synopsisTabVisible = showSynopsis;
  const tabCount = (beatTabVisible ? 1 : 0) + (synopsisTabVisible ? 1 : 0);

  const cardTabMode = useGridStore((s) => s.cardTabMode);
  const setCardTabMode = useGridStore((s) => s.setCardTabMode);

  const [beatsExpanded, setBeatsExpanded] = useState(false);

  // Per-card default (used when global mode === "auto").
  const localDefault: Tab | null =
    beatTabVisible && hasBeats
      ? "beat"
      : synopsisTabVisible
        ? "synopsis"
        : beatTabVisible
          ? "beat"
          : null;

  const [localTab, setLocalTab] = useState<Tab | null>(localDefault);

  // If toggles change such that current local tab disappears, snap to a valid one.
  useEffect(() => {
    if (localTab === "beat" && !beatTabVisible) {
      setLocalTab(synopsisTabVisible ? "synopsis" : null);
    } else if (localTab === "synopsis" && !synopsisTabVisible) {
      setLocalTab(beatTabVisible ? "beat" : null);
    } else if (localTab === null && (beatTabVisible || synopsisTabVisible)) {
      setLocalTab(localDefault);
    }
  }, [localTab, beatTabVisible, synopsisTabVisible, localDefault]);

  // Effective tab: respects global override; falls back if hidden by display toggles.
  function resolveForced(forced: Tab): Tab | null {
    if (forced === "beat") {
      if (beatTabVisible) return "beat";
      return synopsisTabVisible ? "synopsis" : null;
    }
    if (synopsisTabVisible) return "synopsis";
    return beatTabVisible ? "beat" : null;
  }

  const tab: Tab | null =
    cardTabMode === "auto" ? localTab : resolveForced(cardTabMode);

  function handleTabClick(next: Tab) {
    if (cardTabMode === "auto") {
      setLocalTab(next);
    } else {
      // Sync mode: tab click broadcasts to every card via the store.
      setCardTabMode(next);
    }
  }

  // Both toggles off → empty placeholder
  if (!beatTabVisible && !synopsisTabVisible) {
    return (
      <div className="px-3 pb-2 pt-1">
        <p className="text-[10px] italic text-muted-foreground/50">
          {t("grid.card.empty", "空のシーン")}
        </p>
      </div>
    );
  }

  function renderBeatBody() {
    if (hasBeats && beats) {
      const overflow = beats.length > BEAT_VISIBLE_LIMIT;
      const visible =
        overflow && !beatsExpanded ? beats.slice(0, BEAT_VISIBLE_LIMIT) : beats;
      const hidden = beats.length - visible.length;
      return (
        <div className="flex flex-col gap-1">
          <ol className="m-0 flex list-none flex-col gap-1 p-0">
            {visible.map((line, i) => (
              <BeatListItem
                key={i}
                sceneId={nodeId}
                index={i}
                previewText={line}
                compact={compact}
                clamp={!beatsExpanded}
                onEditingChange={onEditingChange}
              />
            ))}
          </ol>
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              aria-label={t("grid.card.addBeatPrompt", "＋ Beat を追加")}
              title={t("grid.card.addBeatPrompt", "＋ Beat を追加")}
              className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                onRequestAddBeat?.();
              }}
            >
              <Plus className="h-3 w-3" />
              <span>Beat</span>
            </button>
            {overflow && (
              <button
                type="button"
                className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  setBeatsExpanded((v) => !v);
                }}
              >
                {beatsExpanded ? (
                  <>
                    <ChevronUp className="h-3 w-3" />
                    <span>{t("grid.card.collapseBeats", "折りたたむ")}</span>
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-3 w-3" />
                    <span>
                      {t("grid.card.moreBeats", "他 {{n}} 件", { n: hidden })}
                    </span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      );
    }
    return (
      <button
        type="button"
        className="text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
        onClick={(e) => {
          e.stopPropagation();
          onRequestAddBeat?.();
        }}
      >
        {t("grid.card.addBeatPrompt", "＋ Beat を追加")}
      </button>
    );
  }

  function renderSynopsisBody() {
    if (hasSynopsis) {
      return (
        <InlineSynopsisEditor
          nodeId={nodeId}
          synopsis={synopsis}
          className="cursor-text rounded text-[11px] text-muted-foreground hover:bg-accent/30"
          placeholder={t("grid.card.synopsisPlaceholder", "シノプシスを追加…")}
          triggerOn="doubleClick"
          onEditingChange={onEditingChange}
        />
      );
    }
    return (
      <InlineSynopsisEditor
        nodeId={nodeId}
        synopsis={null}
        className="cursor-text rounded text-[10px] text-muted-foreground/60 hover:bg-accent/30"
        placeholder={t("grid.card.addSynopsisPrompt", "＋ シノプシスを追加")}
        triggerOn="doubleClick"
        onEditingChange={onEditingChange}
      />
    );
  }

  return (
    <div className="flex flex-col">
      {tabCount > 1 && (
        <div
          role="tablist"
          aria-label={t("grid.card.tabs", "シーン情報タブ")}
          className="flex gap-3 border-b px-3"
        >
          {beatTabVisible && (
            <TabButton
              active={tab === "beat"}
              onClick={() => handleTabClick("beat")}
              label={`Beat${hasBeats && beats ? ` · ${beats.length}` : ""}`}
              dim={!hasBeats}
            />
          )}
          {synopsisTabVisible && (
            <TabButton
              active={tab === "synopsis"}
              onClick={() => handleTabClick("synopsis")}
              label="Synopsis"
              dim={!hasSynopsis}
            />
          )}
        </div>
      )}

      <div className="px-3 pb-2 pt-2 min-h-[3.5rem]">
        {tab === "beat" && renderBeatBody()}
        {tab === "synopsis" && renderSynopsisBody()}
      </div>
    </div>
  );
}

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  label: string;
  dim?: boolean;
}

interface BeatListItemProps {
  sceneId: string;
  index: number;
  previewText: string;
  compact?: boolean;
  /** When true, line-clamp the text to 1 (compact) or 2 lines. */
  clamp: boolean;
  onEditingChange?: (editing: boolean) => void;
}

function BeatListItem({
  sceneId,
  index,
  previewText,
  compact,
  clamp,
  onEditingChange,
}: BeatListItemProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [savedDraft, setSavedDraft] = useState<string | null>(null);
  const beatIdRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const committedRef = useRef(false);

  async function startEdit() {
    if (editing) return;
    const loaded = await loadBeatTextByIndex(sceneId, index);
    if (!loaded) return;
    beatIdRef.current = loaded.id;
    setDraft(loaded.text);
    setSavedDraft(loaded.text);
    committedRef.current = false;
    setEditing(true);
    onEditingChange?.(true);
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  }

  async function commit() {
    if (committedRef.current) return;
    committedRef.current = true;
    const beatId = beatIdRef.current;
    setEditing(false);
    onEditingChange?.(false);
    if (!beatId) return;
    const next = draft.trim();
    const prev = (savedDraft ?? "").trim();
    if (next === prev) return;
    try {
      await editUnplacedBeatFromGrid(sceneId, beatId, next);
    } catch {
      // swallow — store rolled back inside helper
    }
  }

  function cancel() {
    if (committedRef.current) return;
    committedRef.current = true;
    setEditing(false);
    onEditingChange?.(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  }

  // Auto-resize textarea to fit content (preserves visible newlines).
  useLayoutEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [editing, draft]);

  return (
    <li className="flex items-start gap-1.5 text-[11px] leading-snug text-foreground/80">
      <span className="mt-px shrink-0 font-mono text-[9px] tabular-nums text-muted-foreground/60">
        {String(index + 1).padStart(2, "0")}
      </span>
      {editing ? (
        <textarea
          ref={inputRef}
          rows={1}
          className="flex-1 min-w-0 resize-none overflow-hidden rounded bg-accent px-1 py-0.5 text-[11px] leading-snug outline-none focus:ring-1 focus:ring-ring"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={handleKeyDown}
          onClick={(e) => e.stopPropagation()}
          title={t(
            "grid.card.beatEditHint",
            "Enter で確定、Shift+Enter で改行、Esc で取消",
          )}
        />
      ) : (
        <span
          className={cn(
            "flex-1 cursor-text rounded hover:bg-accent/30",
            clamp && (compact ? "line-clamp-1" : "line-clamp-2"),
          )}
          onDoubleClick={(e) => {
            e.stopPropagation();
            void startEdit();
          }}
        >
          {previewText}
        </span>
      )}
    </li>
  );
}

function TabButton({ active, onClick, label, dim }: TabButtonProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "relative font-mono text-[9.5px] uppercase tracking-wider py-1.5 transition-colors",
        "-mb-px border-b border-transparent",
        active
          ? "text-foreground border-primary"
          : dim
            ? "text-muted-foreground/40 hover:text-muted-foreground/70"
            : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}
