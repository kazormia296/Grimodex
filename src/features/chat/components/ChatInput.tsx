import { useRef, useEffect, useState, useCallback } from "react";
import type { MutableRefObject } from "react";
import {
  Send,
  Square,
  ChevronDown,
  Sparkles,
  Bot,
  BotOff,
  Lightbulb,
  LightbulbOff,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { useEditor, EditorContent, useEditorState } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import { Button } from "@/components/ui/button";
import { useAiSettingsStore } from "../store";
import { useChatStore } from "../chatStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { resolveModelCapabilities } from "../agent/modelLimits";
import { resolveAinoveristApiVariant } from "../aiNovelist";
import { getChatInputExtensions } from "../extensions/chatInputExtensions";
import { useCodexHighlight } from "@/features/editor/useCodexHighlight";
import { CodexPopover } from "@/features/editor/CodexPopover";
import type { MentionPopupState } from "../extensions/ChatMentionExtension";
import type { CommandPopupState } from "../extensions/ChatSlashCommandExtension";
import { MentionPopup } from "./MentionPopup";
import { ChatCommandPopup } from "./ChatCommandPopup";
import type { MentionItem } from "@/features/codex/CodexMentionExtension";
import { useTreeStore } from "@/features/tree/treeStore";
import { shouldSuggestAgentMode } from "../agentSuggestion";

interface ChatInputProps {
  onSend: (
    markdown: string,
    options?: {
      overrideAgentMode?: boolean;
      /** @ で指定された scene ID 一覧（送信時に context へ一時 pin される） */
      mentionedSceneIds?: string[];
    },
  ) => void;
  disabled?: boolean;
  /** AIポリシーまたはプロバイダ未設定により送信不可の場合 true */
  policyDisabled?: boolean;
  editorRef?: MutableRefObject<Editor | null>;
  onMentionPin?: (entryId: string) => void;
  onDetectedEntries?: (entryIds: string[]) => void;
  /** 入力欄にテキストがあるかどうかを親に通知（QuickActionStrip の表示制御用） */
  onHasTextChange?: (hasText: boolean) => void;
}

/**
 * 編集再開時の chip 再構築ヘルパー。
 *
 * tiptap-markdown は mention ノードを `@Title` の plain text として
 * シリアライズするため、`editor.setContent(markdown)` の往復で chip が
 * 消える。metadata に保存していた scene id から tree store でタイトルを
 * 引き直し、doc 内の `@Title` 出現箇所を mention ノードに置換する。
 *
 * - tree から消えた scene id は単に無視する（旧メッセージの参照保護）。
 * - 同じ Title が複数あっても最初の出現のみ置換する（同名 scene の運用は
 *   そもそも紛らわしいので、復元が完全でなくても妥協する）。
 */
export function restoreSceneMentionChips(
  editor: Editor,
  sceneIds: string[],
): void {
  const scenes = useTreeStore.getState().scenes;
  const idToTitle = new Map(scenes.map((s) => [s.id, s.title]));
  const mentionType = editor.schema.nodes.mention;
  if (!mentionType) return;

  for (const id of sceneIds) {
    const title = idToTitle.get(id);
    if (!title) continue;
    const needle = `@${title}`;

    // doc を走査して text ノードから needle を探す。見つかったらその範囲を
    // mention ノード + 直後のスペースに置換する。
    let replaced = false;
    editor.state.doc.descendants((node, pos) => {
      if (replaced) return false;
      if (!node.isText || !node.text) return;
      const idx = node.text.indexOf(needle);
      if (idx < 0) return;
      const from = pos + idx;
      const to = from + needle.length;
      editor
        .chain()
        .focus()
        .insertContentAt({ from, to }, [
          {
            type: "mention",
            attrs: { id, label: title, kind: "scene", role: "mentioned" },
          },
          { type: "text", text: " " },
        ])
        .run();
      replaced = true;
    });
  }
}

export function ChatInput({
  onSend,
  disabled,
  policyDisabled,
  editorRef,
  onMentionPin,
  onDetectedEntries,
  onHasTextChange,
}: ChatInputProps) {
  const { t } = useTranslation();
  const isStreaming = disabled ?? false;

  const stopGeneration = useChatStore((s) => s.stopGeneration);
  const buildPromptForCopy = useChatStore((s) => s.buildPromptForCopy);
  const agentMode = useChatStore((s) => s.agentMode);
  const messages = useChatStore((s) => s.messages);
  const editUserMessage = useChatStore((s) => s.editUserMessage);
  const setAgentMode = useChatStore((s) => s.setAgentMode);
  const pendingLookupText = useChatStore((s) => s.pendingLookupText);
  const setPendingLookupText = useChatStore((s) => s.setPendingLookupText);
  const chatScope = useChatStore((s) => s.chatScope);

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

  const currentModel =
    aiSettings?.provider === "cli"
      ? (aiSettings.cli?.model ?? "")
      : (aiSettings?.model ?? "");
  const selectedApiVariant = resolveAinoveristApiVariant(
    currentModel,
    models,
    aiSettings?.modelApiVariant,
  );
  const caps = resolveModelCapabilities(
    currentModel,
    aiSettings,
    selectedApiVariant,
  );

  const [modelOpen, setModelOpen] = useState(false);
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
    : chatScope === "project"
      ? t("chat.placeholderGlobal")
      : chatScope === "folder"
        ? t("chat.placeholderFolder", { kind: t("chat.scope.chapter") })
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
      const { content, mentionedSceneIds } = editUserMessage(last.id);
      if (content) {
        editor.commands.setContent(content);
        // tiptap-markdown は mention を `@Title` plain text にシリアライズ
        // してしまうため、metadata に保存していた scene id から chip を
        // 再構築する。markdown 上の `@Title` 出現箇所を mention ノードに
        // 置換する形を取る。
        if (mentionedSceneIds && mentionedSceneIds.length > 0) {
          restoreSceneMentionChips(editor, mentionedSceneIds);
        }
        editor.commands.focus("end");
      }
    };
  }, [editor, messages, editUserMessage]);

  // C: エディタ「チャットで調べる」から渡されたテキストを入力欄に pre-fill
  useEffect(() => {
    if (!editor || !pendingLookupText) return;
    editor.commands.setContent(pendingLookupText);
    editor.commands.focus("end");
    setPendingLookupText(null);
  }, [editor, pendingLookupText, setPendingLookupText]);

  // Codexハイライト有効化（チャット入力はCodexQuickに影響させない）
  useCodexHighlight(editor, { skipMatchedIds: true });

  // codexHighlightResult トランザクションを監視して検出エントリIDを通知
  useEffect(() => {
    if (!editor || !onDetectedEntries) return;
    const handler = ({
      transaction,
    }: {
      transaction: { getMeta: (key: string) => unknown };
    }) => {
      const result = transaction.getMeta("codexHighlightResult") as
        | Array<{ entryId: string }>
        | undefined;
      if (result !== undefined) {
        const ids = [...new Set(result.map((m) => m.entryId))];
        onDetectedEntries(ids);
      }
    };
    editor.on("transaction", handler);
    return () => {
      editor.off("transaction", handler);
    };
  }, [editor, onDetectedEntries]);

  // エディタのテキスト有無 + @メンション有無をリアクティブに購読
  const editorState = useEditorState({
    editor,
    selector: (ctx) => {
      const text = ctx.editor.getText().trim();
      let hasMentions = false;
      ctx.editor.state.doc.descendants((node) => {
        if (node.type.name === "mention") hasMentions = true;
      });
      return { hasText: text.length > 0, text, hasMentions };
    },
  });
  const hasText = editorState?.hasText ?? false;

  useEffect(() => {
    onHasTextChange?.(hasText);
  }, [hasText, onHasTextChange]);

  // Agent mode サジェスト: 入力が安定して 500ms 経過してから判定 (チップ点滅防止)
  const [suggestAgent, setSuggestAgent] = useState(false);
  const [suggestionDismissed, setSuggestionDismissed] = useState(false);
  useEffect(() => {
    if (!editorState) return;
    const handle = window.setTimeout(() => {
      setSuggestAgent(
        shouldSuggestAgentMode({
          text: editorState.text,
          hasMentions: editorState.hasMentions,
        }),
      );
    }, 500);
    return () => window.clearTimeout(handle);
  }, [editorState]);
  // 入力空になったら却下フラグもリセット
  useEffect(() => {
    if (!hasText) setSuggestionDismissed(false);
  }, [hasText]);

  // ストリーミング中は編集不可
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!isStreaming);
  }, [editor, isStreaming]);

  // 外部クリックでモデル選択ポップオーバーを閉じる
  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (modelRef.current && !modelRef.current.contains(e.target as Node))
        setModelOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, []);

  const modelLabel = (() => {
    if (!currentModel) {
      if (aiSettings?.provider === "cli") {
        return aiSettings.cli?.kind ?? "cli";
      }
      return t("chat.noModel");
    }
    const parts = currentModel.split("/");
    return parts[parts.length - 1];
  })();

  const handleOpenModelMenu = () => {
    if (!modelOpen) loadModels();
    setModelOpen((v) => !v);
  };

  const handleSelectModel = async (modelId: string) => {
    if (!aiSettings) return;
    if (aiSettings.provider === "cli") {
      const cli = aiSettings.cli ?? {
        kind: "claude" as const,
        binaryPath: "",
        model: "",
      };
      await saveSettings({
        ...aiSettings,
        cli: { ...cli, model: modelId },
      });
      setModelOpen(false);
      return;
    }
    // AI のべりすと: model 切替時に apiVariant を再解決して同時に永続化する。
    // chat 経路は毎送信で動的に再計算するので影響ないが、Inline AI / Beat /
    // foreshadow 等 FE が apiVariant を渡さない経路は settings.modelApiVariant
    // を fallback として読むため、ここで stale 値を残すと legacy モデルが v1
    // エンドポイントへ送られる等のミスルーティングが起きる。
    const apiVariant = resolveAinoveristApiVariant(
      modelId,
      models,
      aiSettings.modelApiVariant,
    );
    await saveSettings({
      ...aiSettings,
      model: modelId,
      modelApiVariant: apiVariant ?? null,
    });
    setModelOpen(false);
  };

  const handleToggleThinking = async () => {
    if (!aiSettings) return;
    // 常時推論モデルは thinkingEnabled:false を書かせない（トグルは ON 固定）。
    if (caps.supportsReasoning && caps.canDisableReasoning === false) return;
    await saveSettings({
      ...aiSettings,
      thinkingEnabled: !aiSettings.thinkingEnabled,
    });
  };

  // @メンション選択: エントリ挿入 + (codex のみ) 自動ピン
  // scene mention は送信時に metadata 経由で per-message pin されるので
  // ここでは何もしない。
  const handleMentionSelect = useCallback(
    (item: MentionItem) => {
      mentionPopup?.command?.(item);
      setMentionPopup(null);
      if (item.kind === "codex") {
        onMentionPin?.(item.id);
      }
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

  // 現在の doc から `@シーン名` メンションされた scene ID 群を抽出する。
  // 送信用と preview-copy 用で同じロジックを共有して prompt が食い違わない
  // ようにする。
  const collectMentionedSceneIds = useCallback((): string[] | undefined => {
    if (!editor) return undefined;
    const sceneIdSet = new Set<string>();
    editor.state.doc.descendants((node) => {
      if (node.type.name !== "mention") return;
      const kind = node.attrs.kind as string | undefined;
      const id = node.attrs.id as string | undefined;
      if (kind === "scene" && id) sceneIdSet.add(id);
    });
    return sceneIdSet.size > 0 ? Array.from(sceneIdSet) : undefined;
  }, [editor]);

  const handleSendClick = (options?: { overrideAgentMode?: boolean }) => {
    if (!editor || isStreaming) return;
    const text = editor.getText().trim();
    if (!text) return;
    const markdownStorage = editor.storage as unknown as Record<
      string,
      { getMarkdown?: () => string } | undefined
    >;
    const markdown: string = markdownStorage.markdown?.getMarkdown?.() ?? text;
    const mentionedSceneIds = collectMentionedSceneIds();
    onSend(markdown, { ...options, mentionedSceneIds });
    editor.commands.clearContent();
  };

  const handleSendWithAgent = () => {
    handleSendClick({ overrideAgentMode: true });
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
      const mentionedSceneIds = collectMentionedSceneIds();
      try {
        const prompt = await buildPromptForCopy(markdown, {
          mentionedSceneIds,
        });
        await navigator.clipboard.writeText(prompt);
        toast.success(t("chat.promptCopied"));
      } catch {
        toast.error(t("chat.copyFailed"));
      }
    },
    [editor, buildPromptForCopy, collectMentionedSceneIds, t],
  );

  const canUseTools = caps.supportsTools;
  const canThink =
    caps.supportsThinking ||
    caps.supportsAdaptiveThinking ||
    caps.supportsReasoning;
  // 常時推論モデル（o-series / pre-5.1 gpt-5 等）はトグルを ON 固定・操作不可にする。
  const reasoningLockedOn =
    caps.supportsReasoning && caps.canDisableReasoning === false;
  const effectiveThinkingEnabled =
    reasoningLockedOn || (aiSettings?.thinkingEnabled ?? true);

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

      {/* Codex ハイライトポップオーバー（入力エリア用） */}
      <CodexPopover editor={editor} />

      {/* Agent mode サジェストチップ (探索系の問いを検出した時のみ) */}
      {suggestAgent &&
        !agentMode &&
        canUseTools &&
        !suggestionDismissed &&
        !isStreaming && (
          <div className="mb-1.5 flex items-center justify-between gap-2 rounded-md border border-border bg-accent/30 px-2.5 py-1 text-xs">
            <button
              type="button"
              onClick={handleSendWithAgent}
              className="inline-flex flex-1 items-center gap-1.5 text-left text-foreground hover:text-foreground/80"
              title={t("chat.agentSuggestTitle")}
            >
              <Sparkles className="h-3 w-3 shrink-0 text-primary" />
              <span>{t("chat.agentSuggestLabel")}</span>
            </button>
            <button
              type="button"
              onClick={() => setSuggestionDismissed(true)}
              aria-label={t("chat.agentSuggestDismiss")}
              className="inline-flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

      {/* shadcn chat-01 風: 入力欄＋下段ツール列を 1 枚の角丸カードに内包 */}
      <div className="rounded-2xl border border-input bg-background shadow-sm transition-colors focus-within:ring-1 focus-within:ring-ring">
        {/* TipTap エディタ */}
        <div className="chat-input-editor">
          <EditorContent editor={editor} />
        </div>

        {/* 下段ツール列（カード内） */}
        <div className="flex items-center gap-1 px-2 pb-1.5 pt-0.5">
          {/* Agent mode chip: ツール非対応モデルでは disabled + 理由ツールチップ */}
          <button
            type="button"
            onClick={() => setAgentMode(!agentMode)}
            disabled={!canUseTools}
            aria-pressed={agentMode}
            title={
              !canUseTools ? t("chat.agentUnavailable") : t("chat.agentMode")
            }
            className={[
              "flex items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors",
              !canUseTools
                ? "cursor-not-allowed text-muted-foreground/40"
                : agentMode
                  ? "bg-primary/10 text-primary hover:bg-primary/15"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
            ].join(" ")}
          >
            {agentMode ? (
              <Bot className="h-3 w-3 shrink-0" />
            ) : (
              <BotOff className="h-3 w-3 shrink-0" />
            )}
            <span>{t("chat.agentMode")}</span>
          </button>

          {/* Thinking chip: 非対応は disabled、常時推論は ON 固定 + 理由ツールチップ */}
          <button
            type="button"
            onClick={handleToggleThinking}
            disabled={!canThink || reasoningLockedOn}
            aria-pressed={effectiveThinkingEnabled}
            title={
              !canThink
                ? t("chat.thinkingUnavailable")
                : reasoningLockedOn
                  ? t("chat.thinkingAlwaysOn")
                  : t("chat.thinkingMode")
            }
            className={[
              "flex items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors",
              !canThink
                ? "cursor-not-allowed text-muted-foreground/40"
                : reasoningLockedOn
                  ? "cursor-not-allowed bg-primary/10 text-primary"
                  : effectiveThinkingEnabled
                    ? "bg-primary/10 text-primary hover:bg-primary/15"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
            ].join(" ")}
          >
            {effectiveThinkingEnabled ? (
              <Lightbulb className="h-3 w-3 shrink-0" />
            ) : (
              <LightbulbOff className="h-3 w-3 shrink-0" />
            )}
            <span>{t("chat.thinkingMode")}</span>
          </button>

          {/* モデル選択 chip */}
          <div className="relative" ref={modelRef}>
            <button
              type="button"
              onClick={handleOpenModelMenu}
              className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground active:scale-[0.97] transition-transform duration-75"
              title={t("chat.changeModel")}
            >
              <span className="max-w-[120px] truncate">{modelLabel}</span>
              <ChevronDown className="h-3 w-3 shrink-0" />
            </button>

            {modelOpen && (
              <div className="absolute bottom-full left-0 z-20 mb-1 max-h-48 min-w-[200px] overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-md">
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

          {/* 右端: Send / Stop 円形ボタン */}
          <div className="ml-auto">
            {isStreaming ? (
              <Button
                type="button"
                variant="destructive"
                size="icon"
                onClick={stopGeneration}
                aria-label={t("chat.stopAriaLabel")}
                title={t("chat.stopTitle")}
                className="size-8 rounded-full active:scale-95 transition-transform duration-75"
              >
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                type="button"
                size="icon"
                onClick={() => handleSendClick()}
                onContextMenu={handleSendContextMenu}
                disabled={!editor || !hasText || (policyDisabled ?? false)}
                aria-label={t("chat.sendAriaLabel")}
                title={t("chat.sendTitle")}
                className="size-8 rounded-full active:scale-95 transition-transform duration-75"
              >
                <Send className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
