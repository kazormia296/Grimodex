import { useCallback, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/core";
import { useChatStore } from "./chatStore";
import * as chatApi from "./chatApi";
import type { ChatMessage as ChatMessageType } from "./chatTypes";
import { stripToolProtocol } from "./toolProtocol";
import { useCodexStore } from "@/features/codex/codexStore";
import { requestOpenInCodex } from "@/features/codex/multiwindow/codexSelectionRouting";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { useEditorStore } from "@/features/editor/editorStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { restoreSceneMentionChips } from "./components/ChatInput";
import { normalizeModelId } from "@/features/attribution/AuthorshipMark";
import type { AiSettings } from "./types";
import { toast } from "sonner";
import i18next from "@/lib/i18n";
import { canScheduleQuiescenceMutation } from "@/application/lifecycle/quiescenceLease";

export interface ChatExtractionDialogState {
  open: boolean;
  messageId: string;
  content: string;
  messageRole: "user" | "assistant";
}

export interface ChatSnippetDialogState {
  open: boolean;
  messageId: string;
  initialContent: string;
  messageRole: "user" | "assistant";
}

export function wholeMessageContent(msg: ChatMessageType | undefined): string {
  if (!msg) return "";
  return msg.role === "assistant"
    ? stripToolProtocol(msg.content)
    : msg.content;
}

interface UseChatMessageActionsOptions {
  aiSettings: AiSettings | null;
  chatEditorRef: RefObject<Editor | null>;
  syncInsertedToEditorMetadata: (messageId: string) => void;
}

const emptyCodexDialog = (): ChatExtractionDialogState => ({
  open: false,
  messageId: "",
  content: "",
  messageRole: "assistant",
});

const emptySnippetDialog = (): ChatSnippetDialogState => ({
  open: false,
  messageId: "",
  initialContent: "",
  messageRole: "assistant",
});

export function useChatMessageActions({
  aiSettings,
  chatEditorRef,
  syncInsertedToEditorMetadata,
}: UseChatMessageActionsOptions) {
  const editUserMessage = useChatStore((s) => s.editUserMessage);
  const deleteMessage = useChatStore((s) => s.deleteMessage);
  const regenerate = useChatStore((s) => s.regenerate);
  const createCodexEntry = useCodexStore((s) => s.create);
  const createSnippet = useSnippetStore((s) => s.create);
  const rawInsertFromChat = useEditorStore((s) => s.insertFromChat);
  const [extractionDialog, setExtractionDialog] =
    useState<ChatExtractionDialogState>(emptyCodexDialog);
  const [snippetDialog, setSnippetDialog] =
    useState<ChatSnippetDialogState>(emptySnippetDialog);
  const canMutateMessage = useCallback((messageId: string): boolean => {
    try {
      if (!canScheduleQuiescenceMutation()) return false;
      chatApi.assertMessageMutationAllowed(messageId);
      return true;
    } catch {
      toast.error(i18next.t("chat.pendingCompletedTurnPersistence"));
      return false;
    }
  }, []);

  const handleExtractCodexDetailed = useCallback(
    (messageId: string, selectedText: string | null) => {
      if (!canMutateMessage(messageId)) return;
      const msg = useChatStore
        .getState()
        .messages.find((message) => message.id === messageId);
      setExtractionDialog({
        open: true,
        messageId,
        content: selectedText ?? wholeMessageContent(msg),
        messageRole: msg?.role === "user" ? "user" : "assistant",
      });
    },
    [canMutateMessage],
  );

  const handleExtractCodexQuick = useCallback(
    async (messageId: string) => {
      if (!canMutateMessage(messageId)) return;
      const msg = useChatStore
        .getState()
        .messages.find((message) => message.id === messageId);
      if (!msg) return;
      const text = wholeMessageContent(msg);
      const name =
        text.replace(/\n/g, " ").slice(0, 30).trimEnd() || "Untitled";
      const entry = await createCodexEntry({
        name,
        type: "lore",
        summary: text,
        sourceChatMessageId: messageId,
      });
      if (!entry) return;
      await chatApi.updateMessageMetadata(messageId, {
        extractedCodex: [entry.id],
      });
      void requestOpenInCodex(entry.id);
    },
    [canMutateMessage, createCodexEntry],
  );

  const handleSaveSnippetDetailed = useCallback(
    (messageId: string, selectedText: string | null) => {
      if (!canMutateMessage(messageId)) return;
      const msg = useChatStore
        .getState()
        .messages.find((message) => message.id === messageId);
      setSnippetDialog({
        open: true,
        messageId,
        initialContent: selectedText ?? wholeMessageContent(msg),
        messageRole: msg?.role === "user" ? "user" : "assistant",
      });
    },
    [canMutateMessage],
  );

  const handleSaveSnippetQuick = useCallback(
    async (messageId: string) => {
      if (!canMutateMessage(messageId)) return;
      const msg = useChatStore
        .getState()
        .messages.find((message) => message.id === messageId);
      if (!msg) return;
      const content = wholeMessageContent(msg);
      const title =
        content.replace(/\n/g, " ").slice(0, 30).trimEnd() || "Untitled";
      const snippet = await createSnippet(
        {
          title,
          content,
          sourceChatMessageId: messageId,
          contentSource: msg.role === "assistant" ? "ai" : "human",
        },
        { silent: true },
      );
      if (!snippet) return;
      await chatApi.updateMessageMetadata(messageId, {
        extractedSnippets: [snippet.id],
      });
      useLayoutStore.getState().showPanel("snippets");
      useSnippetStore.getState().requestSelectEntry(snippet.id);
    },
    [canMutateMessage, createSnippet],
  );

  const saveCodexExtraction = useCallback(
    async (data: Parameters<typeof createCodexEntry>[0]) => {
      if (
        extractionDialog.messageId &&
        !canMutateMessage(extractionDialog.messageId)
      ) {
        return;
      }
      const entry = await createCodexEntry(data);
      if (entry && extractionDialog.messageId) {
        await chatApi.updateMessageMetadata(extractionDialog.messageId, {
          extractedCodex: [entry.id],
        });
      }
      setExtractionDialog(emptyCodexDialog());
      if (entry) void requestOpenInCodex(entry.id);
    },
    [canMutateMessage, createCodexEntry, extractionDialog.messageId],
  );

  const saveSnippetExtraction = useCallback(
    async (data: Parameters<typeof createSnippet>[0]) => {
      if (
        snippetDialog.messageId &&
        !canMutateMessage(snippetDialog.messageId)
      ) {
        return;
      }
      const snippet = await createSnippet(data, { silent: true });
      if (snippet && snippetDialog.messageId) {
        await chatApi.updateMessageMetadata(snippetDialog.messageId, {
          extractedSnippets: [snippet.id],
        });
      }
      if (snippet) {
        useLayoutStore.getState().showPanel("snippets");
        useSnippetStore.getState().requestSelectEntry(snippet.id);
      }
      setSnippetDialog(emptySnippetDialog());
    },
    [canMutateMessage, createSnippet, snippetDialog.messageId],
  );

  const insertFromChat = useCallback(
    (content: string, messageId: string) => {
      if (!canMutateMessage(messageId)) return;
      const model = aiSettings?.model
        ? normalizeModelId(aiSettings.provider, aiSettings.model)
        : null;
      if (rawInsertFromChat(content, messageId, model ?? undefined)) {
        syncInsertedToEditorMetadata(messageId);
      }
    },
    [
      aiSettings,
      canMutateMessage,
      rawInsertFromChat,
      syncInsertedToEditorMetadata,
    ],
  );

  const handleEditMessage = useCallback(
    (messageId: string) => {
      const { content, mentionedSceneIds } = editUserMessage(messageId);
      const editor = chatEditorRef.current;
      if (!content || !editor) return;
      editor.commands.setContent(content);
      if (mentionedSceneIds && mentionedSceneIds.length > 0) {
        restoreSceneMentionChips(editor, mentionedSceneIds);
      }
      editor.commands.focus("end");
    },
    [chatEditorRef, editUserMessage],
  );

  const handleDeleteMessage = useCallback(
    (messageId: string) => deleteMessage(messageId),
    [deleteMessage],
  );
  const handleRegenerate = useCallback(
    (messageId: string) => regenerate(messageId),
    [regenerate],
  );
  const handleRetryWithAgent = useCallback(
    (messageId: string) => regenerate(messageId, { withAgentMode: true }),
    [regenerate],
  );

  return {
    extractionDialog,
    snippetDialog,
    handleExtractCodexDetailed,
    handleExtractCodexQuick,
    handleSaveSnippetDetailed,
    handleSaveSnippetQuick,
    saveCodexExtraction,
    saveSnippetExtraction,
    closeCodexExtraction: () => setExtractionDialog(emptyCodexDialog()),
    closeSnippetExtraction: () => setSnippetDialog(emptySnippetDialog()),
    insertFromChat,
    handleEditMessage,
    handleDeleteMessage,
    handleRegenerate,
    handleRetryWithAgent,
  };
}
