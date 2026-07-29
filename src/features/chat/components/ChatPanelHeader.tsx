import { useState, useRef, useEffect, useMemo } from "react";
import { recordCounter } from "@/lib/perfLog";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  Plus,
  Globe,
  Globe2,
  FolderTree,
  FileText,
  BookOpen,
  BookMarked,
  NotepadText,
  Leaf,
  Map as MapIcon,
  MessageSquare,
  Spline,
  X,
} from "lucide-react";
import { useChatStore } from "../chatStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { ScopeTreePickerList } from "@/features/tree/ScopeTreePicker";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import type { ChatScope } from "../chatScope";
import { CodexScopePickerSection } from "./CodexScopePickerSection";
import { SnippetScopePickerSection } from "./SnippetScopePickerSection";
import { useAnchoredPopover } from "@/components/ui/useAnchoredPopover";

type PickerTab = "scene" | "codex" | "snippet";

const PICKER_TABS: { value: PickerTab; labelKey: string }[] = [
  { value: "scene", labelKey: "chat.scope.tabScene" },
  { value: "codex", labelKey: "chat.scope.tabCodex" },
  { value: "snippet", labelKey: "chat.scope.tabSnippet" },
];

function scopeToPickerTab(scope: ChatScope): PickerTab {
  if (scope === "codex" || scope === "snippet") return scope;
  return "scene";
}

interface ChatPanelHeaderProps {
  sessionsPanelOpen: boolean;
  setSessionsPanelOpen: (open: boolean) => void;
  chatScope: ChatScope;
  scopeAnchorId: string | null;
  /** scope=scene のときの anchor scene id（tree active を追従） */
  chatSceneId: string;
  /** エディタが実際に開いているシーン（インジケータ表示用） */
  editorActiveSceneId: string;
  /**
   * スコープ切替。folder のとき anchorId 必須、project では null/undefined。
   * scene 選択時は同時にエディタもそのシーンへナビゲートする
   * （onSelectScene 経由）。
   */
  onScopeChange: (scope: ChatScope, anchorId?: string | null) => void;
  /** シーンをクリックしたとき: エディタ移動 + scope=scene を発火 */
  onSelectScene: (sceneId: string) => void;
  onNewSession: () => void;
  /** A running turn owns its current session until Stop/finalization. */
  sessionMutationsDisabled?: boolean;
  /** 本文を context に含めるか (eco モード相当)。project でも Tier 1 閾値内なら有効 */
  includeBodies: boolean;
  onToggleIncludeBodies: () => void;
  /**
   * Map overlay: アクティブな Map board 全体を L4 に注入するか。
   * chatScope と直交する独立トグル。
   */
  includeMapBoard: boolean;
  /** Map ON のとき chip に表示する board title。null なら "Map" のみ。 */
  mapBoardTitle: string | null;
  /**
   * Map panel が表示されていないとき true。トグルを無効化する
   * （`useMapBoardAutoActivate` が panel 非表示時に overlay を強制 OFF にするため、
   *  同じ `isPanelActive("map")` 述語で gate して状態を一致させる）。
   */
  mapDisabled: boolean;
  onToggleIncludeMapBoard: () => void;
  /** Web 検索 (RAG) トグルの状態。 */
  ragEnabled: boolean;
  /** private Agent と public Web 検索を同時に有効化しないための表示ゲート。 */
  agentMode?: boolean;
  /** RAG 非対応プロバイダ等で操作不可のとき true (トグルを無効化)。 */
  ragDisabled: boolean;
  /** 無効時のツールチップ理由文 (例: ollama は非対応)。 */
  ragDisabledReason?: string;
  onToggleRag: () => void;
}

export function ChatPanelHeader({
  sessionsPanelOpen,
  setSessionsPanelOpen,
  chatScope,
  scopeAnchorId,
  chatSceneId,
  editorActiveSceneId,
  onScopeChange,
  onSelectScene,
  onNewSession,
  sessionMutationsDisabled = false,
  includeBodies,
  onToggleIncludeBodies,
  includeMapBoard,
  mapBoardTitle,
  mapDisabled,
  onToggleIncludeMapBoard,
  ragEnabled,
  agentMode = false,
  ragDisabled,
  ragDisabledReason,
  onToggleRag,
}: ChatPanelHeaderProps) {
  const { t } = useTranslation();
  useEffect(() => {
    recordCounter("chat.header.commit");
  });
  const privacyRagDisabled = agentMode;
  const effectiveRagDisabled = ragDisabled || privacyRagDisabled;
  const nodes = useTreeStore((s) => s.nodes);
  const codexEntries = useCodexStore((s) => s.entries);
  const snippetEntries = useSnippetStore((s) => s.entries);
  const ensureSnippetsLoaded = useSnippetStore((s) => s.ensureEntriesLoaded);
  // Phase 3b: スレッド focus override（補助チップで表示・解除。scope dropdown とは別）。
  const threadFocus = useChatStore((s) => s.threadFocusOverride);
  const clearThreadFocus = useChatStore((s) => s.clearThreadFocusOverride);

  // snippet スコープのラベル解決にタイトルが要る。Snippet パネル未訪問だと
  // store が空のままなので、scope が snippet の間はロードを保証する。
  useEffect(() => {
    if (chatScope === "snippet") void ensureSnippetsLoaded();
  }, [chatScope, ensureSnippetsLoaded]);

  const currentLabel = useMemo(() => {
    if (chatScope === "codex") {
      const entry = codexEntries.find((e) => e.id === scopeAnchorId);
      if (!entry) return t("chat.scope.project");
      return `${t("chat.scope.codex")}: ${entry.name}`;
    }
    if (chatScope === "snippet") {
      const snippet = snippetEntries.find((s) => s.id === scopeAnchorId);
      // 未ロード/削除済みでも snippet スコープ表示は維持する
      // (codex と違い entries は lazy load のため project へ化けさせない)。
      if (!snippet) return t("chat.scope.snippet");
      return `${t("chat.scope.snippet")}: ${snippet.title}`;
    }
    if (chatScope === "project") return t("chat.scope.project");
    if (chatScope === "folder") {
      const folder = nodes.find((n) => n.id === scopeAnchorId);
      if (!folder) return t("chat.scope.project");
      const isAct = folder.parentId === null;
      const kindLabel = isAct ? t("chat.scope.act") : t("chat.scope.chapter");
      return `${kindLabel}: ${folder.title}`;
    }
    // scene
    const scene = nodes.find((n) => n.id === chatSceneId);
    if (!scene) return t("chat.scope.scene");
    return `${t("chat.scope.scene")}: ${scene.title}`;
  }, [
    chatScope,
    scopeAnchorId,
    chatSceneId,
    nodes,
    codexEntries,
    snippetEntries,
    t,
  ]);

  const [open, setOpen] = useState(false);
  const [pickerTab, setPickerTab] = useState<PickerTab>("scene");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [scopeHint, setScopeHint] = useState(false);
  const activePresetId = useLayoutStore((s) => s.activePresetId);

  // ドロップダウン / 時限ヒントはチャットパネル内の stacking context に埋もれない
  // よう document.body へ portal する。位置計算と外側クリック
  // /Escape での閉じ処理は useAnchoredPopover に委譲（同一トリガに 2 つぶら下げ）。
  const dropdownPopover = useAnchoredPopover(
    triggerRef,
    open,
    () => setOpen(false),
    "bottom-start",
  );
  const hintPopover = useAnchoredPopover(
    triggerRef,
    scopeHint && !open,
    () => setScopeHint(false),
    "bottom-start",
  );

  // Chat プリセットへの切替時に Project スコープを時限ポップオーバーで提案。
  // かつては LayoutShell がプリセット切替で subtree を remount していたため
  // mount effect (deps []) で足りたが、remount 廃止後はパネルが生き残るので
  // activePresetId の遷移そのものを契機にする。chatScope は発火時点の値だけ
  // 見たい（scope 変更でヒントを再表示しない）ので ref で読む。
  const chatScopeRef = useRef(chatScope);
  chatScopeRef.current = chatScope;
  const hintPrevPresetRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = hintPrevPresetRef.current;
    hintPrevPresetRef.current = activePresetId;
    if (activePresetId !== "builtin:chat-main") return;
    if (prev === "builtin:chat-main") return;
    if (chatScopeRef.current === "project") return;
    setScopeHint(true);
    const timer = setTimeout(() => setScopeHint(false), 6000);
    return () => {
      clearTimeout(timer);
      setScopeHint(false);
      // StrictMode の dev 二重発火で 2 回目の実行が「遷移なし」と誤認しない
      // よう、cleanup では遷移前の値へ戻す。
      hintPrevPresetRef.current = prev;
    };
  }, [activePresetId]);

  const handleToggleOpen = () => {
    // 開くたびに現在のスコープに対応するタブへ同期する
    // (codex/snippet スコープ中は該当タブ、tree 系スコープは Scene タブ)。
    if (!open) setPickerTab(scopeToPickerTab(chatScope));
    setOpen(!open);
  };
  const handlePickScene = (sceneId: string) => {
    onSelectScene(sceneId);
    onScopeChange("scene");
    setOpen(false);
  };
  const handlePickFolder = (folderId: string) => {
    onScopeChange("folder", folderId);
    setOpen(false);
  };
  const handlePickProject = () => {
    onScopeChange("project");
    setOpen(false);
  };
  const handlePickCodex = (id: string) => {
    onScopeChange("codex", id);
    setOpen(false);
  };
  const handlePickSnippet = (id: string) => {
    onScopeChange("snippet", id);
    setOpen(false);
  };

  // codex / snippet スコープは本文集約が無いため eco トグルは無効。
  const bodiesUnavailable = chatScope === "codex" || chatScope === "snippet";
  const bodiesUnavailableLabel =
    chatScope === "snippet"
      ? t("chat.scope.bodiesUnavailableSnippet")
      : t("chat.scope.bodiesUnavailableCodex");

  return (
    <div
      data-panel-header
      className="flex items-center justify-between border-b border-border px-3 py-1.5"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <MessageSquare className="size-3.5 shrink-0 opacity-70" aria-hidden />
        <span className="shrink-0 text-xs font-medium text-foreground">
          {t("layout.panel.chat")}
        </span>

        <div className="relative min-w-0">
          <button
            ref={triggerRef}
            type="button"
            onClick={handleToggleOpen}
            className="flex max-w-[200px] items-center gap-0.5 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            title={t("chat.scope.picker")}
            aria-label={t("chat.scope.picker")}
          >
            {chatScope === "project" ? (
              <Globe className="mr-1 h-3 w-3 shrink-0 text-primary" />
            ) : chatScope === "folder" ? (
              <FolderTree className="mr-1 h-3 w-3 shrink-0 text-primary" />
            ) : chatScope === "codex" ? (
              <BookMarked className="mr-1 h-3 w-3 shrink-0 text-primary" />
            ) : chatScope === "snippet" ? (
              <NotepadText className="mr-1 h-3 w-3 shrink-0 text-primary" />
            ) : (
              <FileText className="mr-1 h-3 w-3 shrink-0 text-primary" />
            )}
            <span className="truncate">{currentLabel}</span>
            <ChevronDown className="h-3 w-3 shrink-0" />
          </button>

          {scopeHint &&
            !open &&
            hintPopover.style &&
            createPortal(
              <div
                ref={hintPopover.popoverRef}
                style={hintPopover.style}
                className="z-[100] w-52 rounded-md border border-primary/40 bg-popover p-2.5 shadow-md"
              >
                <p className="mb-2 text-[11px] text-muted-foreground">
                  {t("chat.scopeHint.message")}
                </p>
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setScopeHint(false)}
                    className="rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
                  >
                    {t("common.close")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onScopeChange("project");
                      setScopeHint(false);
                    }}
                    className="rounded bg-primary px-2 py-0.5 text-[11px] text-primary-foreground hover:bg-primary/90"
                  >
                    {t("chat.scopeHint.action")}
                  </button>
                </div>
              </div>,
              document.body,
            )}

          {open &&
            dropdownPopover.style &&
            createPortal(
              <div
                ref={dropdownPopover.popoverRef}
                style={dropdownPopover.style}
                className="z-[100] w-72 overflow-hidden rounded-md border border-border bg-popover shadow-lg"
              >
                {/* Spotlight (PinEntryDialog) 形式のタブバー。aria は ImportDialog の
                  tablist パターンに合わせる。 */}
                <div
                  role="tablist"
                  aria-label={t("chat.scope.picker")}
                  className="flex border-b border-border"
                >
                  {PICKER_TABS.map((tab) => (
                    <button
                      key={tab.value}
                      type="button"
                      role="tab"
                      aria-selected={pickerTab === tab.value}
                      onClick={() => setPickerTab(tab.value)}
                      className={[
                        "flex-1 px-3 py-1.5 text-xs font-medium transition-colors",
                        pickerTab === tab.value
                          ? "bg-primary text-primary-foreground"
                          : "bg-background text-muted-foreground hover:bg-accent",
                      ].join(" ")}
                    >
                      {t(tab.labelKey)}
                    </button>
                  ))}
                </div>

                {pickerTab === "scene" && (
                  <ScopeTreePickerList
                    selection={
                      chatScope === "project"
                        ? { type: "project" }
                        : chatScope === "folder" && scopeAnchorId
                          ? { type: "folder", anchorId: scopeAnchorId }
                          : chatScope === "scene"
                            ? { type: "scene", sceneId: chatSceneId }
                            : null
                    }
                    editorActiveSceneId={editorActiveSceneId}
                    onPickScene={handlePickScene}
                    onPickFolder={handlePickFolder}
                    onPickProject={handlePickProject}
                  />
                )}

                {pickerTab === "codex" && (
                  <CodexScopePickerSection
                    selectedId={chatScope === "codex" ? scopeAnchorId : null}
                    onPick={handlePickCodex}
                  />
                )}

                {pickerTab === "snippet" && (
                  <SnippetScopePickerSection
                    selectedId={chatScope === "snippet" ? scopeAnchorId : null}
                    onPick={handlePickSnippet}
                  />
                )}
              </div>,
              document.body,
            )}
        </div>

        {/* Phase 3b: スレッド focus 補助チップ（scope dropdown とは別の overlay）。 */}
        {threadFocus && (
          <span
            data-testid="thread-focus-chip"
            className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
            title={t("chat.threadFocus.label", "プロットスレッド: {{title}}", {
              title: threadFocus.title,
            })}
          >
            <Spline className="h-3 w-3 shrink-0" aria-hidden />
            <span className="max-w-[140px] truncate">{threadFocus.title}</span>
            <button
              type="button"
              onClick={() => clearThreadFocus()}
              aria-label={t("chat.threadFocus.clear", "スレッド focus を解除")}
              className="inline-flex h-4 w-4 items-center justify-center rounded text-primary/80 hover:bg-primary/20 hover:text-primary"
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          </span>
        )}

        {/* eco モード相当: 本文を context に含めるかのトグル */}
        <button
          type="button"
          onClick={() => {
            if (bodiesUnavailable) return;
            onToggleIncludeBodies();
          }}
          disabled={bodiesUnavailable}
          title={
            bodiesUnavailable
              ? bodiesUnavailableLabel
              : includeBodies
                ? t("chat.scope.bodiesOn")
                : t("chat.scope.bodiesOff")
          }
          aria-pressed={includeBodies}
          aria-label={
            bodiesUnavailable
              ? bodiesUnavailableLabel
              : includeBodies
                ? t("chat.scope.bodiesOn")
                : t("chat.scope.bodiesOff")
          }
          className={[
            "rounded p-0.5 transition-colors",
            bodiesUnavailable
              ? "cursor-not-allowed text-muted-foreground/40"
              : includeBodies
                ? "text-primary hover:bg-accent"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
          ].join(" ")}
        >
          {includeBodies ? (
            <BookOpen className="h-3.5 w-3.5" />
          ) : (
            <Leaf className="h-3.5 w-3.5" />
          )}
        </button>

        {/* Map overlay toggle: scope と直交。ON で active board 全体を L4 注入。
            Map panel が非表示のときは無効化（mapDisabled を最初に評価する。
            panel を閉じた直後の 1 render は includeMapBoard がまだ true のままで、
            auto-activate effect が OFF にするまでラグがあるため）。 */}
        <button
          type="button"
          onClick={onToggleIncludeMapBoard}
          disabled={mapDisabled}
          aria-pressed={includeMapBoard}
          aria-label={
            mapDisabled
              ? t("chat.mapOverlay.unavailable")
              : includeMapBoard
                ? t("chat.mapOverlay.on")
                : t("chat.mapOverlay.off")
          }
          title={
            mapDisabled
              ? t("chat.mapOverlay.unavailable")
              : includeMapBoard
                ? t("chat.mapOverlay.on")
                : t("chat.mapOverlay.off")
          }
          className={[
            "flex max-w-[160px] items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors",
            mapDisabled
              ? "cursor-not-allowed text-muted-foreground/40"
              : includeMapBoard
                ? "bg-primary/10 text-primary hover:bg-primary/15"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
          ].join(" ")}
        >
          <MapIcon className="h-3 w-3 shrink-0" />
          {includeMapBoard && mapBoardTitle ? (
            <span className="truncate">{mapBoardTitle}</span>
          ) : (
            <span>{t("chat.mapOverlay.label")}</span>
          )}
        </button>

        {/* Web 検索 (RAG) toggle: ON でプロバイダのサーバサイド検索を注入。
            非対応プロバイダ (ollama 等) では disabled。 */}
        <button
          type="button"
          onClick={onToggleRag}
          disabled={effectiveRagDisabled}
          aria-pressed={ragEnabled}
          aria-label={
            ragEnabled ? t("chat.webSearch.on") : t("chat.webSearch.off")
          }
          // 第三者送信の開示は title (ホバー専用) に頼らず aria-describedby で
          // スクリーンリーダー/タッチにも到達させる（security review F-1）。
          aria-describedby={
            effectiveRagDisabled && ragDisabledReason
              ? "rag-disabled-note"
              : "rag-egress-note"
          }
          title={
            effectiveRagDisabled
              ? privacyRagDisabled
                ? t("chat.webSearch.agentPrivacyNote")
                : (ragDisabledReason ?? t("chat.webSearch.unavailable"))
              : `${
                  ragEnabled ? t("chat.webSearch.on") : t("chat.webSearch.off")
                }\n${t("chat.webSearch.egressNote")}\n${t(
                  "chat.webSearch.injectionNote",
                )}`
          }
          className={[
            "flex items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors",
            effectiveRagDisabled
              ? "cursor-not-allowed text-muted-foreground/40"
              : ragEnabled
                ? "bg-primary/10 text-primary hover:bg-primary/15"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
          ].join(" ")}
        >
          <Globe2 className="h-3 w-3 shrink-0" />
          <span>{t("chat.webSearch.label")}</span>
        </button>
        {effectiveRagDisabled && ragDisabledReason ? (
          <span id="rag-disabled-note" className="sr-only">
            {ragDisabledReason}
          </span>
        ) : (
          /* aria-describedby の参照先。第三者送信(egress)＋取得内容による
             プロンプトインジェクションの両方を SR/タッチへ開示（security review F-1）。 */
          <span id="rag-egress-note" className="sr-only">
            {`${t("chat.webSearch.egressNote")} ${t(
              "chat.webSearch.injectionNote",
            )}${agentMode ? ` ${t("chat.webSearch.agentPrivacyNote")}` : ""}`}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => setSessionsPanelOpen(!sessionsPanelOpen)}
          className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {t("chat.sessions")}
        </button>
        <button
          type="button"
          onClick={onNewSession}
          disabled={sessionMutationsDisabled}
          title={t("chat.newSession")}
          aria-label={t("chat.newSession")}
          className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
