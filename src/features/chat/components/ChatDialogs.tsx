import type { ComponentProps } from "react";
import { CodexExtractionDialog } from "@/features/codex/CodexExtractionDialog";
import { SnippetExtractionDialog } from "@/features/snippets/SnippetExtractionDialog";
import { SessionsPanel } from "./SessionsPanel";
import { ChatMessageContextMenu } from "./ChatMessageContextMenu";
import { PromptPreviewModal } from "./PromptPreviewModal";
import { getModelCapabilities } from "../agent/modelLimits";
import type {
  ChatExtractionDialogState,
  ChatSnippetDialogState,
} from "../useChatMessageActions";
import type { MessagePromptSnapshot } from "../chatApi";

export interface ChatContextMenuState {
  messageId: string;
  messageRole: "user" | "assistant";
  messageContent: string;
  selectedText: string | null;
  x: number;
  y: number;
}

interface ChatDialogsProps {
  extractionDialog: ChatExtractionDialogState;
  snippetDialog: ChatSnippetDialogState;
  onSaveCodex: ComponentProps<typeof CodexExtractionDialog>["onSave"];
  onCloseCodex: ComponentProps<typeof CodexExtractionDialog>["onClose"];
  onSaveSnippet: ComponentProps<typeof SnippetExtractionDialog>["onSave"];
  onCloseSnippet: ComponentProps<typeof SnippetExtractionDialog>["onClose"];
  sessionsPanelOpen: boolean;
  sceneTitle: string;
  activeSceneId: string | null;
  onCloseSessions: () => void;
  contextMenu: ChatContextMenuState | null;
  contextMutationsDisabled: boolean;
  onCloseContextMenu: () => void;
  contextActions: Pick<
    ComponentProps<typeof ChatMessageContextMenu>,
    | "onInsert"
    | "onExtractCodexQuick"
    | "onExtractCodexDetailed"
    | "onSaveSnippetQuick"
    | "onSaveSnippetDetailed"
    | "onCopy"
    | "onEdit"
    | "onDelete"
    | "onRegenerate"
  >;
  promptViewOpen: boolean;
  promptViewSnapshot: MessagePromptSnapshot | null;
  onClosePrompt: () => void;
}

export function ChatDialogs({
  extractionDialog,
  snippetDialog,
  onSaveCodex,
  onCloseCodex,
  onSaveSnippet,
  onCloseSnippet,
  sessionsPanelOpen,
  sceneTitle,
  activeSceneId,
  onCloseSessions,
  contextMenu,
  contextMutationsDisabled,
  onCloseContextMenu,
  contextActions,
  promptViewOpen,
  promptViewSnapshot,
  onClosePrompt,
}: ChatDialogsProps) {
  return (
    <>
      <CodexExtractionDialog
        open={extractionDialog.open}
        messageId={extractionDialog.messageId}
        initialContent={extractionDialog.content}
        messageRole={extractionDialog.messageRole}
        onSave={onSaveCodex}
        onClose={onCloseCodex}
      />
      <SnippetExtractionDialog
        open={snippetDialog.open}
        initialContent={snippetDialog.initialContent}
        messageId={snippetDialog.messageId}
        messageRole={snippetDialog.messageRole}
        onSave={onSaveSnippet}
        onClose={onCloseSnippet}
      />
      {sessionsPanelOpen && (
        <SessionsPanel
          sceneTitle={sceneTitle}
          activeSceneId={activeSceneId ?? ""}
          onClose={onCloseSessions}
          mutationsDisabled={contextMutationsDisabled}
        />
      )}
      {contextMenu && (
        <ChatMessageContextMenu
          {...contextMenu}
          mutationsDisabled={contextMutationsDisabled}
          onClose={onCloseContextMenu}
          {...contextActions}
        />
      )}
      {promptViewOpen && promptViewSnapshot && (
        <PromptPreviewModal
          systemPrompt={promptViewSnapshot.systemPrompt}
          layers={promptViewSnapshot.layers}
          totalTokens={promptViewSnapshot.totalTokens ?? 0}
          model={promptViewSnapshot.model ?? undefined}
          contextWindow={
            promptViewSnapshot.model
              ? getModelContextWindow(promptViewSnapshot.model)
              : 0
          }
          onClose={onClosePrompt}
        />
      )}
    </>
  );
}

function getModelContextWindow(model: string): number {
  // Kept local to the dialog boundary so ChatPanel does not know prompt modal
  // capability details.
  return getModelCapabilities(model).contextWindow;
}
