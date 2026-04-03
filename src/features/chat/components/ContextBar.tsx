import { useState } from "react";
import { X, BookOpen, ChevronDown, ChevronUp } from "lucide-react";
import type { CodexEntry } from "@/features/codex/api";
import type { LayerBreakdown } from "../contextBuilder";
import { PromptPreviewModal } from "./PromptPreviewModal";
import { ContextCreatorButton } from "./ContextCreatorButton";
import { ContextCreatorDialog } from "./ContextCreatorDialog";
import { runContextCreator, type SuggestedEntry } from "../contextCreatorApi";
import { useChatStore } from "../chatStore";

interface ContextBarProps {
  pinnedEntries: CodexEntry[];
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
  onUnpin,
  onPin,
  onOpenPinDialog,
  contextTokenCount,
  contextLayers,
  systemPrompt,
  model,
  canUseCreator = false,
}: ContextBarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [creatorOpen, setCreatorOpen] = useState(false);

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
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setPreviewOpen(true);
                }}
                className="rounded bg-muted px-1.5 py-0.5 text-xs hover:bg-accent"
                title="プロンプト全文を表示"
              >
                ~{contextTokenCount.toLocaleString()} tokens
              </button>
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
                title="プロジェクト情報"
              >
                Project
              </span>
            )}
            {/* L3: Scene + トークン数 */}
            {sceneTokens > 0 && (
              <span
                className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                title={`シーン: ${sceneTokens.toLocaleString()} tokens`}
              >
                Scene: {sceneTokens.toLocaleString()}
              </span>
            )}
            {/* ピン留め Codex エントリ */}
            {pinnedEntries.map((entry) => (
              <span
                key={entry.id}
                className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-xs"
              >
                {entry.name}
                <button
                  type="button"
                  onClick={() => onUnpin(entry.id)}
                  className="hover:text-destructive"
                  aria-label={`${entry.name}のピン留め解除`}
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
              aria-label="Codexをピン留め"
            >
              <BookOpen className="h-3 w-3" />
              ピン留め
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
