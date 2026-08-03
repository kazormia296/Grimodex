import { createPortal } from "react-dom";
import { lazy, Suspense, type RefObject } from "react";
import type { Editor } from "@tiptap/react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { MentionPopup } from "@/features/chat/components/MentionPopup";
import type {
  CodexMentionPopupState,
  MentionItem,
  MentionRole,
} from "@/features/codex/CodexMentionExtension";
import type { AbMessage } from "@/features/ab-test/abHarness";
import { InlineAIToolbar } from "@/features/editor/inlineAi/InlineAIToolbar";
import { SlashCommandPopup } from "@/features/editor/inlineAi/SlashCommandPopup";
import { ReorderOverlay } from "@/features/editor/reorder/ReorderOverlay";
import type { InlineAiCommand } from "@/features/editor/inlineAi/inlineAiTypes";
import type {
  ReorderGranularity,
  ReorderUnit,
} from "@/features/editor/reorder/types";

const AbInlineDialog = lazy(async () => {
  const module = await import("@/features/ab-test/AbInlineDialog");
  return { default: module.AbInlineDialog };
});

const InlineAIPalette = lazy(async () => {
  const module = await import("@/features/editor/inlineAi/InlineAIPalette");
  return { default: module.InlineAIPalette };
});

export interface AbInlineState {
  messages: AbMessage[];
  mode: "insert" | "replace";
  originalRange: { from: number; to: number } | null;
  insertPos: number | null;
  projectId: string;
  projectionKey: string;
  /** Immutable document generation captured when the A/B request started. */
  documentSnapshot: ProseMirrorNode;
}

interface EditorPaneOverlaysProps {
  editor: Editor | null;
  paletteOpen: boolean;
  palettePreselect: InlineAiCommand | null;
  onClosePalette: () => void;
  onSubmitPalette: (command: InlineAiCommand, prompt: string) => void;
  onSubmitPaletteAb: (command: InlineAiCommand, prompt: string) => void;
  abInline: AbInlineState | null;
  onCloseAb: () => void;
  onAdoptAb: (text: string) => void;
  onAccept: () => void;
  onReject: () => void;
  onRetry: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  isInlineAiOwner: boolean;
  mentionPopup: CodexMentionPopupState | null;
  mentionIndex: number;
  onMentionSelect: (item: MentionItem) => void;
  onMentionIndexChange: (index: number) => void;
  onMentionSelectWithRole: (item: MentionItem, role: MentionRole) => void;
  paragraphReorder: {
    open: boolean;
    units: ReorderUnit[];
    order: number[];
    onOrderChange: (order: number[]) => void;
    granularity: ReorderGranularity;
    onGranularityChange: (granularity: ReorderGranularity) => void;
    loading: boolean;
    errorMessage: string | null;
    canConfirm: boolean;
    onConfirm: () => void;
    onCancel: () => void;
  };
  bunsetsuAvailable: boolean;
  phraseAvailable: boolean;
  wordAvailable: boolean;
}

/** Floating editors, mention UI, and reorder UI kept outside the body layout. */
export function EditorPaneOverlays({
  editor,
  paletteOpen,
  palettePreselect,
  onClosePalette,
  onSubmitPalette,
  onSubmitPaletteAb,
  abInline,
  onCloseAb,
  onAdoptAb,
  onAccept,
  onReject,
  onRetry,
  anchorRef,
  isInlineAiOwner,
  mentionPopup,
  mentionIndex,
  onMentionSelect,
  onMentionIndexChange,
  onMentionSelectWithRole,
  paragraphReorder,
  bunsetsuAvailable,
  phraseAvailable,
  wordAvailable,
}: EditorPaneOverlaysProps) {
  return (
    <>
      {editor && paletteOpen && (
        <Suspense fallback={null}>
          <InlineAIPalette
            editor={editor}
            open
            preselectedCommand={palettePreselect}
            onClose={onClosePalette}
            onSubmit={onSubmitPalette}
            onSubmitAb={onSubmitPaletteAb}
          />
        </Suspense>
      )}
      {abInline && (
        <Suspense fallback={null}>
          <AbInlineDialog
            open
            onOpenChange={(next) => {
              if (!next) onCloseAb();
            }}
            projectId={abInline.projectId}
            messages={abInline.messages}
            onAdopt={onAdoptAb}
          />
        </Suspense>
      )}
      <InlineAIToolbar
        onAccept={onAccept}
        onReject={onReject}
        onRetry={onRetry}
        anchorRef={anchorRef}
        isOwner={isInlineAiOwner}
      />
      <SlashCommandPopup />
      {mentionPopup &&
        createPortal(
          <MentionPopup
            items={mentionPopup.items}
            selectedIndex={mentionIndex}
            onSelect={onMentionSelect}
            onChangeIndex={onMentionIndexChange}
            clientRect={mentionPopup.clientRect}
            onSelectWithRole={onMentionSelectWithRole}
          />,
          document.body,
        )}
      <ReorderOverlay
        open={paragraphReorder.open}
        units={paragraphReorder.units}
        order={paragraphReorder.order}
        onOrderChange={paragraphReorder.onOrderChange}
        granularity={paragraphReorder.granularity}
        onGranularityChange={paragraphReorder.onGranularityChange}
        loading={paragraphReorder.loading}
        errorMessage={paragraphReorder.errorMessage}
        canConfirm={paragraphReorder.canConfirm}
        onConfirm={paragraphReorder.onConfirm}
        onCancel={paragraphReorder.onCancel}
        bunsetsuAvailable={bunsetsuAvailable}
        phraseAvailable={phraseAvailable}
        wordAvailable={wordAvailable}
      />
    </>
  );
}
