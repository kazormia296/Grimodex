import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
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
  Columns2,
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
import {
  MentionPopup,
  MENTION_LISTBOX_ID,
  mentionOptionId,
} from "./MentionPopup";
import {
  ChatCommandPopup,
  CHAT_COMMAND_LISTBOX_ID,
  chatCommandOptionId,
} from "./ChatCommandPopup";
import { ReasoningEffortChip } from "./ReasoningEffortChip";
import type { ReasoningEffortValue } from "./ReasoningEffortChip";
import { useAnchoredPopover } from "@/components/ui/useAnchoredPopover";
import { ChatModelMenu } from "./ChatModelMenu";
import { motion, AnimatePresence } from "motion/react";
import {
  VARIANTS,
  DURATIONS,
  EASINGS,
  useReducedMotion,
} from "@/lib/animation";
import { useChatModelCatalog } from "../useChatModelCatalog";
import { getProviderLabel } from "../providerLabels";
import { getOpenaiCompatibleEndpoints } from "../types";
import { applyModelWhitelist } from "../chatModelCatalog";
import type { CatalogModel } from "../chatModelCatalog";
import type { MentionItem } from "@/features/codex/CodexMentionExtension";
import { useTreeStore } from "@/features/tree/treeStore";
import { shouldSuggestAgentMode } from "../agentSuggestion";
import { PromptTemplatePicker } from "@/features/prompt-library/PromptTemplatePicker";
import { usePromptLibraryStore } from "@/features/prompt-library/promptLibraryStore";
import type { PromptTemplate } from "@/features/prompt-library/api";
import { AbChatDialog } from "@/features/ab-test/AbChatDialog";
import {
  getCurrentProjectId,
  getCurrentProjectLanguage,
} from "@/features/project/projectStore";
import { buildChatCommandInstruction } from "../extensions/chatCommandInstruction";

interface ChatInputProps {
  onSend: (
    markdown: string,
    options?: {
      overrideAgentMode?: boolean;
      /** @ で指定された scene ID 一覧（送信時に context へ一時 pin される） */
      mentionedSceneIds?: string[];
      /** @ で指定された人物(codex) ID 一覧（作中年表スナップショットの人物 seed） */
      mentionedCodexIds?: string[];
      /** スラッシュコマンド由来の一回限りの指示 (L6 へ注入)。例: /brainstorm の VS。 */
      commandInstruction?: string;
    },
  ) => void;
  disabled?: boolean;
  /** AIポリシーまたはプロバイダ未設定により送信不可の場合 true */
  policyDisabled?: boolean;
  editorRef?: MutableRefObject<Editor | null>;
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
  onDetectedEntries,
  onHasTextChange,
}: ChatInputProps) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const isStreaming = disabled ?? false;

  const stopGeneration = useChatStore((s) => s.stopGeneration);
  const buildPromptForCopy = useChatStore((s) => s.buildPromptForCopy);
  const appendAdoptedAbTurn = useChatStore((s) => s.appendAdoptedAbTurn);
  const registerInputDraftProvider = useChatStore(
    (s) => s.registerInputDraftProvider,
  );
  const agentMode = useChatStore((s) => s.agentMode);
  const messages = useChatStore((s) => s.messages);
  const editUserMessage = useChatStore((s) => s.editUserMessage);
  const setAgentMode = useChatStore((s) => s.setAgentMode);
  const pendingLookupText = useChatStore((s) => s.pendingLookupText);
  const setPendingLookupText = useChatStore((s) => s.setPendingLookupText);
  const chatScope = useChatStore((s) => s.chatScope);
  const threadFocus = useChatStore((s) => s.threadFocusOverride);

  const aiSettings = useAiSettingsStore((s) => s.settings);
  const saveSettings = useAiSettingsStore((s) => s.saveSettings);
  const chatModelOverride = useAiSettingsStore((s) => s.chatModelOverride);
  const chatProviderOverride = useAiSettingsStore(
    (s) => s.chatProviderOverride,
  );
  const chatModelVariantOverride = useAiSettingsStore(
    (s) => s.chatModelVariantOverride,
  );
  const chatEndpointIdOverride = useAiSettingsStore(
    (s) => s.chatEndpointIdOverride,
  );
  const setChatModelOverride = useAiSettingsStore(
    (s) => s.setChatModelOverride,
  );
  const allModels = useAiSettingsStore((s) => s.models);
  const loadModels = useAiSettingsStore((s) => s.loadModels);
  // 動的 capability レジストリ更新時に caps を再計算する
  useAiSettingsStore((s) => s.modelCapsRevision);
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

  // 非 CLI のチャットモデルは「一時オーバーライド(その場限り) → 既定チャットモデル」
  // の順で解決する。チャットパネルでの選択は一時オーバーライドにのみ反映し、保存される
  // 既定(settings.model)は書き換えない。別プロバイダ一時送信中は、そのモデルが正(active が
  // cli でも cli.model でなく override モデルを表示する)。
  const currentModel = chatProviderOverride
    ? (chatModelOverride ?? "")
    : aiSettings?.provider === "cli"
      ? (aiSettings.cli?.model ?? "")
      : (chatModelOverride ?? aiSettings?.model ?? "");
  // 別プロバイダ override 中は選択時に確定済みの variant を使う(active provider の models に
  // 依存して再解決すると誤った経路になる)。同一プロバイダは従来どおりモデル一覧から解決。
  const selectedApiVariant = chatProviderOverride
    ? (chatModelVariantOverride ?? undefined)
    : resolveAinoveristApiVariant(
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
  // 複数プロバイダ横断のモデルカタログ(ピッカーを開いたら設定済みプロバイダを取得)。
  const { sections: modelSections, loading: catalogLoading } =
    useChatModelCatalog(modelOpen);
  // モデル whitelist は全プロバイダ横断のグローバルな絞り込み(設定でチェックしたモデルだけ
  // 表示)。アクティブプロバイダだけに適用すると、別プロバイダのセクションに未チェックの
  // モデルが残ってしまうため、全セクションに適用する。
  const displaySections = useMemo(() => {
    let whitelist: string[];
    try {
      const parsed: unknown = JSON.parse(modelWhitelistRaw || "[]");
      whitelist = Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      whitelist = [];
    }
    return applyModelWhitelist(modelSections, whitelist);
  }, [modelSections, modelWhitelistRaw]);
  // A/B 比較 (③): 現在の下書きプロンプトを 2 構成へ並列送信する専用モーダル。
  // ライブストリーム描画には一切触れない。採用時は会話履歴へ積むため、表示用の
  // 下書き本文 (userDraft) とメンション情報も保持しておく。
  const [abChat, setAbChat] = useState<{
    basePrompt: string;
    userDraft: string;
    mentionedSceneIds: string[];
    projectId: string;
  } | null>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  // モデルメニューは入力欄上部に開く。.glass-chat の backdrop-filter が作る
  // stacking context に埋もれないよう document.body へ portal する。
  const modelPopover = useAnchoredPopover(
    modelTriggerRef,
    modelOpen,
    () => setModelOpen(false),
    "top-start",
  );

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
    : threadFocus
      ? t("chat.placeholderThread", { title: threadFocus.title })
      : chatScope === "codex"
        ? t("chat.placeholderCodex")
        : chatScope === "snippet"
          ? t("chat.placeholderSnippet")
          : chatScope === "project"
            ? t("chat.placeholderGlobal")
            : chatScope === "folder"
              ? t("chat.placeholderFolder", { kind: t("chat.scope.chapter") })
              : t("chat.placeholderScene");

  // /コマンド選択後の「次の送信」に対して一回限りの指示 (L6) を作る。
  // 読み取り時にクリアするので、送信ごとに高々1回適用される。
  const pendingCommandRef = useRef<string | null>(null);
  const consumePendingCommandInstruction = useCallback(():
    | string
    | undefined => {
    const cmdId = pendingCommandRef.current;
    pendingCommandRef.current = null;
    const lang = getCurrentProjectLanguage().startsWith("en") ? "en" : "ja";
    // CoT 前置きは小型/ローカル (cli) では認知負荷で品質が落ちうるため切る。
    return buildChatCommandInstruction(cmdId, lang, {
      cot: aiSettings?.provider !== "cli",
    });
  }, [aiSettings]);

  const handleSubmit = useCallback(
    (markdown: string) => {
      if (isStreaming) return;
      onSend(markdown, {
        commandInstruction: consumePendingCommandInstruction(),
      });
    },
    [isStreaming, onSend, consumePendingCommandInstruction],
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

  // a11y: 補完ポップアップ(listbox)と入力欄の combobox 的な aria 配線。
  // editorProps.attributes は生成時固定のため、開閉・選択の変化は
  // contenteditable の DOM 属性を直接同期する（aria 属性のみ、挙動不変）。
  useEffect(() => {
    const dom = editor?.view.dom;
    if (!dom) return;
    // popup オブジェクトは extension の onUpdate 毎に新規参照になるため、
    // 実際に値が変わったときだけ DOM を書き換える
    const sync = (name: string, value: string | null) => {
      if (value === null) {
        if (dom.hasAttribute(name)) dom.removeAttribute(name);
      } else if (dom.getAttribute(name) !== value) {
        dom.setAttribute(name, value);
      }
    };
    const mentionOpen = mentionPopup !== null && mentionPopup.items.length > 0;
    const commandOpen = commandPopup !== null && commandPopup.items.length > 0;
    if (mentionOpen || commandOpen) {
      // items 縮小に index の追従が一瞬遅れても存在しない option id を指さない
      const clamp = (index: number, length: number) =>
        Math.max(0, Math.min(index, length - 1));
      sync("aria-expanded", "true");
      sync(
        "aria-controls",
        mentionOpen ? MENTION_LISTBOX_ID : CHAT_COMMAND_LISTBOX_ID,
      );
      sync(
        "aria-activedescendant",
        mentionOpen && mentionPopup !== null
          ? mentionOptionId(clamp(mentionIndex, mentionPopup.items.length))
          : commandPopup !== null
            ? chatCommandOptionId(
                clamp(commandIndex, commandPopup.items.length),
              )
            : null,
      );
    } else {
      sync("aria-expanded", "false");
      sync("aria-controls", null);
      sync("aria-activedescendant", null);
    }
  }, [editor, mentionPopup, mentionIndex, commandPopup, commandIndex]);

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

  const modelLabel = (() => {
    if (!currentModel) {
      if (aiSettings?.provider === "cli") {
        return aiSettings.cli?.kind ?? "cli";
      }
      return t("chat.noModel");
    }
    const parts = currentModel.split("/");
    const name = parts[parts.length - 1];
    // 別プロバイダ一時送信中はどのプロバイダ宛てかひと目で分かるよう接頭する。
    if (chatProviderOverride) {
      // OpenAI 互換で別エンドポイントを選んでいる場合はエンドポイントのラベルを見せる
      // (どのサーバ宛てか区別できるように)。ラベル未設定なら baseUrl で代用。
      if (
        chatProviderOverride === "openai-compatible" &&
        chatEndpointIdOverride &&
        aiSettings
      ) {
        const ep = getOpenaiCompatibleEndpoints(aiSettings).find(
          (e) => e.id === chatEndpointIdOverride,
        );
        const epLabel = ep ? ep.label || ep.baseUrl : null;
        if (epLabel) return `${epLabel}: ${name}`;
      }
      return `${getProviderLabel(chatProviderOverride, t)}: ${name}`;
    }
    return name;
  })();

  const handleOpenModelMenu = () => {
    if (!modelOpen) loadModels();
    setModelOpen((v) => !v);
  };

  const handleSelectModel = async (model: CatalogModel) => {
    if (!aiSettings) return;
    const isActiveProvider = model.provider === aiSettings.provider;
    // active が CLI かつ CLI のモデルを選んだ場合のみ、CLI モデルを永続化する
    // (CLI は subprocess 経路で settings.cli.model を読むため一時 override では効かない)。
    if (isActiveProvider && aiSettings.provider === "cli") {
      const cli = aiSettings.cli ?? {
        kind: "claude" as const,
        binaryPath: "",
        model: "",
      };
      await saveSettings({
        ...aiSettings,
        cli: { ...cli, model: model.id },
      });
      setModelOpen(false);
      return;
    }
    // OpenAI 互換は provider が同じでも「どのエンドポイントのモデルか」で送信先が変わる。
    // active エンドポイント以外を選んだら、同一プロバイダでも endpoint override を糸通しする
    // (これを落とすと黙って active エンドポイントへフォールバックする = 別サーバ選択が無効化)。
    const isCompat = model.provider === "openai-compatible";
    const activeEndpointId =
      aiSettings.activeOpenaiCompatibleEndpointId ?? undefined;
    const selectedEndpointId = model.endpointId ?? undefined;
    const isCrossEndpoint =
      isCompat &&
      selectedEndpointId !== undefined &&
      selectedEndpointId !== activeEndpointId;

    if (isActiveProvider && !isCrossEndpoint) {
      // 同一プロバイダ・同一エンドポイント: その場限りの一時オーバーライド。保存される
      // 既定チャットモデル(settings.model)は書き換えない(切替がインライン AI / Beat /
      // 校閲など他経路へ漏れない)。既定モデルそのものを選んだ場合はオーバーライドを
      // 解除して既定追従に戻す。
      setChatModelOverride(model.id === aiSettings.model ? null : model.id);
    } else {
      // 別プロバイダ、または同一互換プロバイダの別エンドポイント: provider + 解決済み
      // variant + endpointId を一緒に持たせ、その 1 送信だけ別宛先へ。
      setChatModelOverride(model.id, {
        provider: model.provider,
        variant: model.variant,
        endpointId: model.endpointId,
      });
    }
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

  const handleChangeReasoningEffort = async (
    value: ReasoningEffortValue | null,
  ) => {
    if (!aiSettings) return;
    await saveSettings({ ...aiSettings, reasoningEffortOverride: value });
  };

  // @メンション選択: エントリを入力 doc に挿入するだけにする。
  // Codex は CodexHighlight / mentionedCodexIds 経由で現在ターン候補になり、
  // Spotlight への昇格は ContextBar の明示操作だけが担当する。
  const handleMentionSelect = useCallback(
    (item: MentionItem) => {
      mentionPopup?.command?.(item);
      setMentionPopup(null);
    },
    [mentionPopup],
  );

  // /コマンド選択
  const handleCommandSelect = useCallback(
    (cmd: import("../extensions/chatCommands").ChatCommand) => {
      commandPopup?.command?.(cmd);
      // コマンド本文 (/brainstorm) はエディタから削除されるため、次の送信に
      // 適用する指示として id を保持する (consume 時に解決)。
      pendingCommandRef.current = cmd.id;
      setCommandPopup(null);
    },
    [commandPopup],
  );

  // プロンプトテンプレート挿入: 本文を入力エディタのカーソル位置にテキストとして
  // 差し込む。markdown 記法はそのまま（tiptap-markdown が再描画する）。挿入後に
  // usageCount を 1 増やす。
  const incrementTemplateUsage = usePromptLibraryStore((s) => s.incrementUsage);
  const handleTemplateSelect = useCallback(
    (template: PromptTemplate) => {
      if (!editor) return;
      editor.chain().focus().insertContent(template.content).run();
      void incrementTemplateUsage(template.id);
    },
    [editor, incrementTemplateUsage],
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

  // 現在の doc から `@人物名`(codex) メンションされた codex ID 群を抽出する。
  // collectMentionedSceneIds と対で、年表スナップショットの人物 seed に使う。
  const collectMentionedCodexIds = useCallback((): string[] | undefined => {
    if (!editor) return undefined;
    const codexIdSet = new Set<string>();
    editor.state.doc.descendants((node) => {
      if (node.type.name !== "mention") return;
      const kind = node.attrs.kind as string | undefined;
      const id = node.attrs.id as string | undefined;
      if (kind === "codex" && id) codexIdSet.add(id);
    });
    return codexIdSet.size > 0 ? Array.from(codexIdSet) : undefined;
  }, [editor]);

  // プレビュー(ContextBar)が seed / 表示に使う入力中テキストを on-demand 提供する。
  useEffect(() => {
    registerInputDraftProvider(() => {
      if (!editor)
        return { markdown: "", mentionedSceneIds: [], mentionedCodexIds: [] };
      const markdownStorage = editor.storage as unknown as Record<
        string,
        { getMarkdown?: () => string } | undefined
      >;
      const text = editor.getText().trim();
      const markdown = markdownStorage.markdown?.getMarkdown?.() ?? text;
      return {
        markdown,
        mentionedSceneIds: collectMentionedSceneIds() ?? [],
        mentionedCodexIds: collectMentionedCodexIds() ?? [],
      };
    });
    return () => registerInputDraftProvider(null);
  }, [
    editor,
    registerInputDraftProvider,
    collectMentionedSceneIds,
    collectMentionedCodexIds,
  ]);

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
    const mentionedCodexIds = collectMentionedCodexIds();
    onSend(markdown, {
      ...options,
      mentionedSceneIds,
      mentionedCodexIds,
      commandInstruction: consumePendingCommandInstruction(),
    });
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
      const mentionedCodexIds = collectMentionedCodexIds();
      try {
        const prompt = await buildPromptForCopy(markdown, {
          mentionedSceneIds,
          mentionedCodexIds,
        });
        await navigator.clipboard.writeText(prompt);
        toast.success(t("chat.promptCopied"));
      } catch {
        toast.error(t("chat.copyFailed"));
      }
    },
    [
      editor,
      buildPromptForCopy,
      collectMentionedSceneIds,
      collectMentionedCodexIds,
      t,
    ],
  );

  // A/B 比較を起動: 現在の下書き + 文脈から buildPromptForCopy で基底プロンプトを
  // 組み立て、専用モーダルを開く。ライブ送信 (onSend) は呼ばない。
  const handleOpenAbCompare = useCallback(async () => {
    if (!editor || isStreaming) return;
    const markdownStorage = editor.storage as unknown as Record<
      string,
      { getMarkdown?: () => string } | undefined
    >;
    const text = editor.getText().trim();
    if (!text) {
      toast.error(t("abTest.emptyPrompt"));
      return;
    }
    const markdown: string = markdownStorage.markdown?.getMarkdown?.() ?? text;
    const mentionedSceneIds = collectMentionedSceneIds();
    const mentionedCodexIds = collectMentionedCodexIds();
    try {
      const prompt = await buildPromptForCopy(markdown, {
        mentionedSceneIds,
        mentionedCodexIds,
      });
      setAbChat({
        basePrompt: prompt,
        userDraft: markdown,
        mentionedSceneIds: mentionedSceneIds ?? [],
        projectId: getCurrentProjectId(),
      });
    } catch {
      toast.error(t("abTest.buildPromptFailed"));
    }
  }, [
    editor,
    isStreaming,
    buildPromptForCopy,
    collectMentionedSceneIds,
    collectMentionedCodexIds,
    t,
  ]);

  // A/B 採用: 採用列の応答を、そのチャットの会話履歴へ 1 往復として積む
  // (下書き = user / 採用応答 = assistant)。clipboard コピーの置き換え。
  // 適用できたら下書きをクリアしてダイアログを閉じる。
  const handleAdoptAb = useCallback(
    async ({ text, model }: { text: string; model: string | null }) => {
      const current = abChat;
      if (!current) return;
      const ok = await appendAdoptedAbTurn({
        userDraft: current.userDraft,
        basePrompt: current.basePrompt,
        mentionedSceneIds: current.mentionedSceneIds,
        assistantText: text,
        model,
      });
      if (!ok) return;
      editor?.commands.clearContent();
      onHasTextChange?.(false);
      setAbChat(null);
      toast.success(t("abTest.adoptedToConversation"));
    },
    [abChat, appendAdoptedAbTurn, editor, onHasTextChange, t],
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

        {/* 下段ツール列（カード内）。狭い幅では chip を縦に割らず次の行へ折り返す。 */}
        <div className="flex flex-wrap items-center gap-1 px-2 pb-1.5 pt-0.5">
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
              "flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-xs transition-colors",
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
              "flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-xs transition-colors",
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

          {/* Reasoning effort chip: reasoning モデルのみ。設定ページと同じ
              reasoningEffortOverride を読み書きする。
              cli は送信経路 (sendCliChatStream) が thinking/effort パラメータを
              渡さないため、表示してもデッドコントロールになる → 出さない */}
          {aiSettings?.provider !== "cli" && caps.supportsReasoning && (
            <ReasoningEffortChip
              value={aiSettings?.reasoningEffortOverride ?? null}
              options={caps.reasoningEffortValues ?? ["low", "medium", "high"]}
              thinkingEnabled={effectiveThinkingEnabled}
              onChange={handleChangeReasoningEffort}
            />
          )}

          {/* プロンプトテンプレート挿入ピッカー */}
          <PromptTemplatePicker
            onSelect={handleTemplateSelect}
            disabled={isStreaming}
          />

          {/* モデル選択 chip */}
          <div className="relative shrink-0">
            <button
              ref={modelTriggerRef}
              type="button"
              onClick={handleOpenModelMenu}
              className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground active:scale-[0.97] transition-transform duration-75"
              title={t("chat.changeModel")}
            >
              <span className="max-w-[120px] truncate">{modelLabel}</span>
              <ChevronDown className="h-3 w-3 shrink-0" />
            </button>

            {createPortal(
              // spotlight (CodexCommandPalette) と同じ dropdown(fade + 下スライド)で
              // 開閉する。退場アニメのため AnimatePresence は常時マウントしておく。
              <AnimatePresence>
                {modelOpen && modelPopover.style && (
                  <motion.div
                    key="chat-model-menu"
                    ref={modelPopover.popoverRef}
                    style={modelPopover.style}
                    className="z-[100] overflow-hidden rounded-md border border-border bg-popover shadow-md"
                    variants={VARIANTS.dropdown}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    transition={{
                      duration: reduced ? 0 : DURATIONS.fast,
                      ease: EASINGS.easeOut,
                    }}
                  >
                    <ChatModelMenu
                      sections={displaySections}
                      loading={catalogLoading}
                      maxHeight={modelPopover.maxHeight ?? undefined}
                      current={{
                        provider: chatProviderOverride ?? aiSettings?.provider,
                        modelId: currentModel,
                        // override 無しのときは active エンドポイントが現在値
                        // (互換以外は両方 undefined で従来どおり)。
                        endpointId:
                          chatEndpointIdOverride ??
                          aiSettings?.activeOpenaiCompatibleEndpointId,
                      }}
                      onSelect={(model) => void handleSelectModel(model)}
                    />
                  </motion.div>
                )}
              </AnimatePresence>,
              document.body,
            )}
          </div>

          {/* A/B 比較 chip (③): 現在の下書きを 2 構成で並列生成して見比べる */}
          <button
            type="button"
            onClick={() => void handleOpenAbCompare()}
            disabled={!editor || !hasText || isStreaming}
            title={t("abTest.chatMenuLabel")}
            className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:text-muted-foreground/40"
          >
            <Columns2 className="h-3 w-3 shrink-0" />
            <span>A/B</span>
          </button>

          {/* 右端: Send / Stop 円形ボタン */}
          <div className="ml-auto shrink-0">
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

      {abChat && (
        <AbChatDialog
          open
          onOpenChange={(next) => {
            if (!next) setAbChat(null);
          }}
          projectId={abChat.projectId}
          basePrompt={abChat.basePrompt}
          onAdopt={handleAdoptAb}
        />
      )}
    </div>
  );
}
