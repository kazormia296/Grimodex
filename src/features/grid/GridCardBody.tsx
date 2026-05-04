import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { parseBeatPreview } from "./parseBeatPreview";
import { InlineSynopsisEditor } from "@/features/editor/InlineSynopsisEditor";
import { useGridStore } from "./gridStore";

type Tab = "beat" | "synopsis";

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
      return (
        <ol className="m-0 flex list-none flex-col gap-1 p-0">
          {beats.map((line, i) => (
            <li
              key={i}
              className="flex items-start gap-1.5 text-[11px] leading-snug text-foreground/80"
            >
              <span className="mt-px shrink-0 font-mono text-[9px] tabular-nums text-muted-foreground/60">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className={compact ? "line-clamp-1" : "line-clamp-2"}>
                {line}
              </span>
            </li>
          ))}
        </ol>
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
