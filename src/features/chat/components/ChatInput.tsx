import { useRef, useEffect, useState, useCallback } from "react";
import type { MutableRefObject } from "react";
import { Send, Square, Wrench, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { useEditor, EditorContent } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import { useAiSettingsStore } from "../store";
import { useChatStore } from "../chatStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { getModelCapabilities } from "../agent/modelLimits";
import { getChatInputExtensions } from "../extensions/chatInputExtensions";
import { useCodexHighlight } from "@/features/editor/useCodexHighlight";
import type { MentionPopupState } from "../extensions/ChatMentionExtension";
import type { CommandPopupState } from "../extensions/ChatSlashCommandExtension";
import { MentionPopup } from "./MentionPopup";
import { ChatCommandPopup } from "./ChatCommandPopup";
import type { CodexEntry } from "@/features/codex/api";

interface ChatInputProps {
  onSend: (markdown: string) => void;
  disabled?: boolean;
  editorRef?: MutableRefObject<Editor | null>;
  isGlobalChat?: boolean;
  onMentionPin?: (entryId: string) => void;
}

export function ChatInput({
  onSend,
  disabled,
  editorRef,
  isGlobalChat = false,
  onMentionPin,
}: ChatInputProps) {
  const { t } = useTranslation();
  const isStreaming = disabled ?? false;

  const stopGeneration = useChatStore((s) => s.stopGeneration);
  const buildPromptForCopy = useChatStore((s) => s.buildPromptForCopy);
  const agentMode = useChatStore((s) => s.agentMode);
  const messages = useChatStore((s) => s.messages);
  const editUserMessage = useChatStore((s) => s.editUserMessage);
  const setAgentMode = useChatStore((s) => s.setAgentMode);

  const aiSettings = useAiSettingsStore((s) => s.settings);
  const saveSettings = useAiSettingsStore((s) => s.saveSettings);
  const allModels = useAiSettingsStore((s) => s.models);
  const loadModels = useAiSettingsStore((s) => s.loadModels);
  const modelWhitelistRaw = useSettingsStore((s) => s.get("ai.modelWhitelist"));
  const models = (() => {
    try {
      const whitelist: string[] = JSON.parse(modelWhitelistRaw || "[]");
      if (whitelist.length === 0) return allModels;
      return allModels.filter((m) => whitelist.includes(m.id));
    } catch {
      return allModels;
    }
  })();

  const currentModel = aiSettings?.model ?? "";
  const caps = getModelCapabilities(currentModel);

  const [optionsOpen, setOptionsOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const optionsRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);

  // ポップアップ状態
  const [mentionPopup, setMentionPopup] = useState<MentionPopupState | null>(
    null,
  );
  const [mentionIndex, setMentionIndex] = useState(0);
  const [commandPopup, setCommandPopup] = useState<CommandPopupState | null>(
    null,
  );
  const [commandIndex, setCommandIndex] = useState(0);

  // G18: ↑キーで直前ユーザーメッセージを入力欄に復帰
  const editLastFnRef = useRef<() => void>(() => {});

  const placeholder = isStreaming
    ? t("chat.placeholderStreaming")
    : isGlobalChat
      ? t("chat.placeholderGlobal")
      : t("chat.placeholderScene");

  const handleSubmit = useCallback(
    (markdown: string) => {
      if (isStreaming) return;
      onSend(markdown);
    },
    [isStreaming, onSend],
  );

  const handleStop = () => {
    stopGeneration();
  };

  const editor = useEditor({
    extensions: getChatInputExtensions({
      placeholder,
      onSubmit: handleSubmit,
      onStop: handleStop,
      onEditLast: () => editLastFnRef.current(),
      setMentionPopup: (state) => {
        setMentionPopup(state);
        setMentionIndex(0);
      },
      setCommandPopup: (state) => {
        setCommandPopup(state);
        setCommandIndex(0);
      },
    }),
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        class: "chat-input-prosemirror",
      },
    },
  });

  // editorRef を親に公開
  useEffect(() => {
    if (editorRef) editorRef.current = editor;
  }, [editor, editorRef]);

  // G18: editLastFnRef を最新の messages/editor に合わせて更新
  useEffect(() => {
    editLastFnRef.current = () => {
      if (!editor) return;
      const userMessages = messages.filter((m) => m.role === "user");
      const last = userMessages[userMessages.length - 1];
      if (!last) return;
      const content = editUserMessage(last.id);
      if (content) {
        editor.commands.setContent(content);
        editor.commands.focus("end");
      }
    };
  }, [editor, messages, editUserMessage]);

  // Codexハイライト有効化（チャット入力はCodexQuickに影響させない）
  useCodexHighlight(editor, { skipMatchedIds: true });

  // ストリーミング中は編集不可
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!isStreaming);
  }, [editor, isStreaming]);

  // 外部クリックでポップオーバーを閉じる
  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (optionsRef.current && !optionsRef.current.contains(e.target as Node))
        setOptionsOpen(false);
      if (modelRef.current && !modelRef.current.contains(e.target as Node))
        setModelOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, []);

  const modelLabel = (() => {
    if (!currentModel) return t("chat.noModel");
    const parts = currentModel.split("/");
    return parts[parts.length - 1];
  })();

  const handleOpenModelMenu = () => {
    if (!modelOpen) loadModels();
    setModelOpen((v) => !v);
  };

  const handleSelectModel = async (modelId: string) => {
    if (!aiSettings) return;
    await saveSettings({ ...aiSettings, model: modelId });
    setModelOpen(false);
  };

  const handleToggleThinking = async () => {
    if (!aiSettings) return;
    await saveSettings({
      ...aiSettings,
      thinkingEnabled: !aiSettings.thinkingEnabled,
    });
  };

  // @メンション選択: エントリ挿入 + 自動ピン
  const handleMentionSelect = useCallback(
    (entry: CodexEntry) => {
      mentionPopup?.command?.(entry);
      setMentionPopup(null);
      onMentionPin?.(entry.id);
    },
    [mentionPopup, onMentionPin],
  );

  // /コマンド選択
  const handleCommandSelect = useCallback(
    (cmd: import("../extensions/chatCommands").ChatCommand) => {
      commandPopup?.command?.(cmd);
      setCommandPopup(null);
    },
    [commandPopup],
  );

  const handleSendClick = () => {
    if (!editor || isStreaming) return;
    const text = editor.getText().trim();
    if (!text) return;
    const markdownStorage = editor.storage as unknown as Record<
      string,
      { getMarkdown?: () => string } | undefined
    >;
    const markdown: string = markdownStorage.markdown?.getMarkdown?.() ?? text;
    onSend(markdown);
    editor.commands.clearContent();
  };

  const handleSendContextMenu = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      if (!editor) return;
      const markdownStorage = editor.storage as unknown as Record<
        string,
        { getMarkdown?: () => string } | undefined
      >;
      const text = editor.getText().trim();
      const markdown: string =
        markdownStorage.markdown?.getMarkdown?.() ?? text;
      try {
        const prompt = await buildPromptForCopy(markdown);
        await navigator.clipboard.writeText(prompt);
        toast.success(t("chat.promptCopied"));
      } catch {
        toast.error(t("chat.copyFailed"));
      }
    },
    [editor, buildPromptForCopy],
  );

  const canUseTools = caps.supportsTools;
  const canThink =
    caps.supportsThinking ||
    caps.supportsAdaptiveThinking ||
    caps.supportsReasoning;

  return (
    <div className="border-t border-border p-3">
      {/* @メンション補完ポップアップ */}
      {mentionPopup && (
        <MentionPopup
          items={mentionPopup.items}
          selectedIndex={mentionIndex}
          onSelect={handleMentionSelect}
          onChangeIndex={setMentionIndex}
          clientRect={mentionPopup.clientRect}
        />
      )}

      {/* /コマンド補完ポップアップ */}
      {commandPopup && (
        <ChatCommandPopup
          items={commandPopup.items}
          selectedIndex={commandIndex}
          onSelect={handleCommandSelect}
          onChangeIndex={setCommandIndex}
          clientRect={commandPopup.clientRect}
        />
      )}

      {/* TipTap エディタ入力エリア */}
      <div className="flex gap-2">
        <div className="chat-input-editor flex-1 rounded-md border border-input bg-background text-sm focus-within:ring-1 focus-within:ring-ring">
          <EditorContent editor={editor} />
        </div>

        {/* Send / Stop ボタン */}
        {isStreaming ? (
          <button
            type="button"
            onClick={stopGeneration}
            aria-label={t("chat.stopAriaLabel")}
            title={t("chat.stopTitle")}
            className="inline-flex items-center justify-center rounded-md bg-destructive px-3 py-2 text-destructive-foreground hover:bg-destructive/90"
          >
            <Square className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSendClick}
            onContextMenu={handleSendContextMenu}
            disabled={!editor || editor.getText().trim().length === 0}
            aria-label={t("chat.sendAriaLabel")}
            title={t("chat.sendTitle")}
            className="inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* 下段: 🛠️ オプション + モデル選択 */}
      <div className="mt-1.5 flex items-center justify-between">
        {/* 🛠️ オプションポップオーバー */}
        <div className="relative" ref={optionsRef}>
          <button
            type="button"
            onClick={() => setOptionsOpen((v) => !v)}
            disabled={!canUseTools && !canThink}
            title={t("chat.aiOptions")}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Wrench className="h-3 w-3" />
          </button>

          {optionsOpen && (
            <div className="absolute bottom-full left-0 z-20 mb-1 min-w-[180px] rounded-md border border-border bg-popover py-1 shadow-md">
              {/* Agent mode トグル */}
              <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent">
                <input
                  type="checkbox"
                  checked={agentMode}
                  onChange={(e) => setAgentMode(e.target.checked)}
                  disabled={!canUseTools}
                  className="h-3 w-3"
                />
                <span className={!canUseTools ? "opacity-40" : ""}>
                  {t("chat.agentMode")}
                </span>
              </label>

              {/* Thinking トグル */}
              <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent">
                <input
                  type="checkbox"
                  checked={aiSettings?.thinkingEnabled ?? true}
                  onChange={handleToggleThinking}
                  disabled={!canThink}
                  className="h-3 w-3"
                />
                <span className={!canThink ? "opacity-40" : ""}>
                  {t("chat.thinkingMode")}
                </span>
              </label>

              {/* RAG トグル (未実装) */}
              <label className="flex cursor-not-allowed items-center gap-2 px-3 py-1.5 text-xs opacity-40">
                <input type="checkbox" disabled className="h-3 w-3" />
                {t("chat.ragUnimplemented")}
              </label>
            </div>
          )}
        </div>

        {/* モデル選択 */}
        <div className="relative" ref={modelRef}>
          <button
            type="button"
            onClick={handleOpenModelMenu}
            className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            title={t("chat.changeModel")}
          >
            <span className="max-w-[120px] truncate">{modelLabel}</span>
            <ChevronDown className="h-3 w-3 shrink-0" />
          </button>

          {modelOpen && (
            <div className="absolute bottom-full right-0 z-20 mb-1 max-h-48 min-w-[200px] overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-md">
              {models.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">
                  {t("chat.loadingModels")}
                </p>
              ) : (
                models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => handleSelectModel(m.id)}
                    className={[
                      "w-full px-3 py-1.5 text-left text-xs hover:bg-accent",
                      m.id === currentModel
                        ? "font-medium text-foreground"
                        : "text-muted-foreground",
                    ].join(" ")}
                  >
                    {m.name || m.id}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
