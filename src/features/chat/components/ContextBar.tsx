import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X, BookOpen, ChevronDown, ChevronUp, Pin } from "lucide-react";
import type { CodexEntry } from "@/features/codex/api";
import type { PinnedSnippetEntryWithData } from "../chatApi";
import type { LayerBreakdown } from "../contextBuilder";
import { PromptPreviewModal } from "./PromptPreviewModal";
import { ContextCreatorButton } from "./ContextCreatorButton";
import { ContextCreatorDialog } from "./ContextCreatorDialog";
import { runContextCreator, type SuggestedEntry } from "../contextCreatorApi";
import { useChatStore } from "../chatStore";
import {
  getModelCapabilities,
  formatContextWindow,
} from "../agent/modelLimits";
import { getTypeLabel } from "../utils/typeLabels";
import { ContextPillGroup } from "./ContextPillGroup";

const GROUP_THRESHOLD = 6;

interface ContextBarProps {
  pinnedEntries: CodexEntry[];
  /** G15: auto-detected entries (excluding pinned) */
  detectedEntries?: CodexEntry[];
  /** G15: always-mode entries (excluding pinned and detected) */
  alwaysEntries?: CodexEntry[];
  /** G16: pinned snippet entries */
  pinnedSnippets?: PinnedSnippetEntryWithData[];
  onUnpin: (entryId: string) => void;
  onPin: (entryId: string) => Promise<void>;
  onOpenPinDialog: () => void;
  contextTokenCount: number;
  contextLayers: LayerBreakdown[];
  systemPrompt: string;
  model: string;
  canUseCreator?: boolean;
}

export function ContextBar({
  pinnedEntries,
  detectedEntries = [],
  alwaysEntries = [],
  pinnedSnippets = [],
  onUnpin,
  onPin,
  onOpenPinDialog,
  contextTokenCount,
  contextLayers,
  systemPrompt,
  model,
  canUseCreator = false,
}: ContextBarProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const allContextEntries = [
    ...pinnedEntries,
    ...detectedEntries,
    ...alwaysEntries,
  ];
  const useGrouping =
    allContextEntries.length + pinnedSnippets.length > GROUP_THRESHOLD;

  // type別グループマップ (pinned only — detected/always are shown separately)
  const groupMap = new Map<string, CodexEntry[]>();
  if (useGrouping) {
    for (const entry of pinnedEntries) {
      const group = groupMap.get(entry.type) ?? [];
      group.push(entry);
      groupMap.set(entry.type, group);
    }
  }

  function toggleGroup(type: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  const pinnedIds = pinnedEntries.map((e) => e.id);

  async function handleCreatorSearch(
    instruction: string,
  ): Promise<SuggestedEntry[]> {
    return runContextCreator(instruction, pinnedIds, model);
  }

  async function handleCreatorAddSelected(
    entries: SuggestedEntry[],
  ): Promise<void> {
    for (const entry of entries) {
      await onPin(entry.id);
    }
  }

  const l3 = contextLayers.find((l) => l.layer === "L3");
  const sceneTokens = l3?.used ?? 0;

  const ctxWindowLabel = model
    ? formatContextWindow(getModelCapabilities(model).contextWindow)
    : null;

  return (
    <>
      <div className="border-b border-border" data-testid="context-bar">
        {/* ヘッダー行: クリックで折りたたみ */}
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex w-full items-center justify-between px-4 py-1 text-xs text-muted-foreground hover:bg-muted/30"
        >
          <span className="font-medium">Context</span>
          <div className="flex items-center gap-2">
            {contextTokenCount > 0 && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPreviewOpen(true);
                  }}
                  className="rounded bg-muted px-1.5 py-0.5 text-xs hover:bg-accent"
                  title={t("chat.context.showPrompt")}
                >
                  ~{contextTokenCount.toLocaleString()} tokens
                </button>
                {ctxWindowLabel && (
                  <span className="text-xs text-muted-foreground/60">
                    / {ctxWindowLabel}
                  </span>
                )}
              </div>
            )}
            {collapsed ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronUp className="h-3 w-3" />
            )}
          </div>
        </button>

        {/* ピル行 */}
        {!collapsed && (
          <div className="flex flex-wrap items-center gap-1 px-4 pb-1.5">
            {/* L1: Project (常に存在するなら表示) */}
            {contextLayers.find((l) => l.layer === "L1" && l.used > 0) && (
              <span
                className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                title={t("chat.context.projectInfo")}
              >
                Project
              </span>
            )}
            {/* L3: Scene + トークン数 */}
            {sceneTokens > 0 && (
              <span
                className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                title={t("chat.context.sceneTokens", {
                  count: sceneTokens.toLocaleString(),
                })}
              >
                Scene: {sceneTokens.toLocaleString()}
              </span>
            )}
            {/* ピン留め Codex エントリ */}
            {useGrouping
              ? Array.from(groupMap.entries()).map(([type, groupEntries]) => (
                  <ContextPillGroup
                    key={type}
                    type={type}
                    label={getTypeLabel(type)}
                    count={groupEntries.length}
                    expanded={expandedGroups.has(type)}
                    onToggle={() => toggleGroup(type)}
                    entries={groupEntries}
                    onUnpin={onUnpin}
                  />
                ))
              : pinnedEntries.map((entry) => (
                  <span
                    key={entry.id}
                    className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-xs"
                  >
                    {entry.name}
                    <button
                      type="button"
                      onClick={() => onUnpin(entry.id)}
                      className="hover:text-destructive"
                      aria-label={t("chat.context.unpinEntry", {
                        name: entry.name,
                      })}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
            {/* G15: auto-detected entries */}
            {detectedEntries.map((entry) => (
              <span
                key={entry.id}
                data-testid="detected-pill"
                className="inline-flex items-center gap-1 rounded-full bg-accent/50 px-2 py-0.5 text-xs"
              >
                {entry.name}
                <span className="text-muted-foreground/70">auto</span>
                <button
                  type="button"
                  onClick={() => onPin(entry.id)}
                  className="hover:text-foreground text-muted-foreground/70"
                  aria-label={t("chat.context.pinEntry", { name: entry.name })}
                >
                  <Pin className="h-3 w-3" />
                </button>
              </span>
            ))}
            {/* G15: always-mode entries */}
            {alwaysEntries.map((entry) => (
              <span
                key={entry.id}
                data-testid="always-pill"
                className="inline-flex items-center gap-1 rounded-full bg-accent/50 px-2 py-0.5 text-xs"
              >
                {entry.name}
                <span className="text-muted-foreground/70">auto</span>
                <button
                  type="button"
                  onClick={() => onPin(entry.id)}
                  className="hover:text-foreground text-muted-foreground/70"
                  aria-label={t("chat.context.pinEntry", { name: entry.name })}
                >
                  <Pin className="h-3 w-3" />
                </button>
              </span>
            ))}
            {/* G16: ピン留め Snippet エントリ */}
            {pinnedSnippets.map((snippet) => (
              <span
                key={snippet.id}
                className="inline-flex items-center gap-1 rounded-full bg-purple-100 px-2 py-0.5 text-xs text-purple-800"
              >
                {snippet.title}
                <button
                  type="button"
                  onClick={() => onUnpin(snippet.id)}
                  className="hover:text-destructive"
                  aria-label={t("chat.context.unpinEntry", {
                    name: snippet.title,
                  })}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            {/* ピン留めボタン */}
            <button
              type="button"
              onClick={onOpenPinDialog}
              className="inline-flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent"
              aria-label={t("chat.context.pinCodexSnippet")}
            >
              <BookOpen className="h-3 w-3" />
              {t("chat.context.pin")}
            </button>
            {/* ✦ AI コンテキスト提案ボタン */}
            <ContextCreatorButton
              onClick={() => setCreatorOpen(true)}
              disabled={!canUseCreator}
            />
          </div>
        )}

        {/* ContextCreator ダイアログ (ピル行の下に展開) */}
        {!collapsed && creatorOpen && (
          <ContextCreatorDialog
            onSearch={handleCreatorSearch}
            onAddSelected={handleCreatorAddSelected}
            onClose={() => setCreatorOpen(false)}
          />
        )}
      </div>

      {previewOpen && (
        <PromptPreviewModal
          systemPrompt={systemPrompt}
          layers={contextLayers}
          totalTokens={contextTokenCount}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </>
  );
}

/** chatStore から systemPrompt を取得するためのラッパー */
export function ContextBarConnected(
  props: Omit<ContextBarProps, "systemPrompt">,
) {
  // messages の先頭の system メッセージからプロンプトを取得
  const systemPrompt = useChatStore((s) => {
    const sys = s.messages.find((m) => m.role === "system");
    return sys?.content ?? "";
  });
  return <ContextBar {...props} systemPrompt={systemPrompt} />;
}
