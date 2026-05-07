import { useState, useEffect, useRef, useCallback } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import { cn } from "@/lib/utils";
import { getEditorExtensions } from "@/features/editor/extensions";
import { useTreeStore } from "@/features/tree/treeStore";
import { loadSceneContent, saveSceneContent } from "@/features/tree/api";
import { useAutoSave } from "@/hooks/useAutoSave";
import { useCodexHighlight } from "@/features/editor/useCodexHighlight";
import { useAttribution } from "@/features/attribution/useAttribution";
import { useCharacterFade } from "@/features/editor/useCharacterFade";
import {
  saveAuthorshipSpans,
  loadAuthorshipSpans,
  spansToMarkData,
} from "@/features/attribution/api";
import { useEditorSettings } from "@/features/settings/hooks/useEditorSettings";
import { useAttributionStore } from "@/features/attribution/attributionStore";
import { getDocText } from "@/features/editor/RubyNode";
import { shouldAutoDraftTransition } from "@/features/editor/autoStatusTransition";
import { debugLog, errorDetail } from "@/lib/debugLog";
import type { SceneStatus } from "@/features/tree/treeStore";
import { useLinearEditorStore } from "./linearEditorStore";
import { useChatStore } from "@/features/chat/chatStore";
import { extractBeatMentions } from "@/features/editor/beat/extractBeatMentions";
import { upsertSceneBeatMentions } from "@/features/editor/beat/mentionApi";
import { extractBeatPovOverrides } from "@/features/editor/beat/extractBeatPovOverrides";
import { upsertSceneBeatPovOverrides } from "@/features/editor/beat/beatPovCacheApi";
import { upsertSceneBodyMentions } from "@/features/editor/beat/bodyMentionApi";
import { useCodexStore } from "@/features/codex/codexStore";

interface LinearSceneBlockProps {
  sceneId: string;
  isMounted: boolean;
  isActive: boolean;
  placeholderHeight: number;
  onHeightChange: (sceneId: string, height: number) => void;
  onFocus: (sceneId: string, editor: Editor) => void;
}

export function LinearSceneBlock({
  sceneId,
  isMounted,
  isActive,
  placeholderHeight,
  onHeightChange,
  onFocus,
}: LinearSceneBlockProps) {
  // Stable outer div so IntersectionObserver never loses track when mount state flips
  return (
    <div data-scene-id={sceneId} className="shrink-0">
      {isMounted ? (
        <MountedSceneBlock
          sceneId={sceneId}
          isActive={isActive}
          onHeightChange={onHeightChange}
          onFocus={onFocus}
        />
      ) : (
        <div style={{ height: placeholderHeight }} />
      )}
    </div>
  );
}

interface MountedSceneBlockProps {
  sceneId: string;
  isActive: boolean;
  onHeightChange: (sceneId: string, height: number) => void;
  onFocus: (sceneId: string, editor: Editor) => void;
}

function MountedSceneBlock({
  sceneId,
  isActive,
  onHeightChange,
  onFocus,
}: MountedSceneBlockProps) {
  const editorSettings = useEditorSettings();
  const filterSource = useAttributionStore((s) => s.filterSource);
  const activeNode = useTreeStore((s) => s.nodes.find((n) => n.id === sceneId));
  const title = activeNode?.title ?? "";

  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);
  const isApplyingExternalUpdate = useRef(false);
  const wasEmptyRef = useRef(false);
  const [charCount, setCharCount] = useState(0);

  const coreSave = useCallback(async () => {
    const ed = editorRef.current;
    if (!ed) return;
    await saveSceneContent(sceneId, JSON.stringify(ed.getJSON()));
    await saveAuthorshipSpans(sceneId, ed.state.doc);
    upsertSceneBeatMentions(sceneId, extractBeatMentions(ed.state.doc)).catch(
      (e) => {
        debugLog.error(
          "LinearSceneBlock",
          "upsertSceneBeatMentions failed",
          errorDetail(e),
        );
      },
    );
    upsertSceneBeatPovOverrides(
      sceneId,
      extractBeatPovOverrides(ed.state.doc),
    ).catch((e) => {
      debugLog.error(
        "LinearSceneBlock",
        "upsertSceneBeatPovOverrides failed",
        errorDetail(e),
      );
    });
    setTimeout(() => {
      const allEntries = useCodexStore.getState().entries;
      if (allEntries.length > 0) {
        const docJsonStr = JSON.stringify(ed.getJSON());
        upsertSceneBodyMentions(sceneId, docJsonStr, allEntries).catch((e) => {
          debugLog.error(
            "LinearSceneBlock",
            "upsertSceneBodyMentions failed",
            errorDetail(e),
          );
        });
      }
    }, 0);
    useTreeStore
      .getState()
      .refreshAiRatio(sceneId)
      .catch(() => {});
    const chatState = useChatStore.getState();
    if (chatState.activeSceneId === sceneId) {
      void chatState.refreshContextLayers();
    }
  }, [sceneId]);

  const saveFn = useCallback(async () => {
    try {
      await coreSave();
    } catch (e) {
      debugLog.error("LinearSceneBlock", "save failed", errorDetail(e));
    }
  }, [coreSave]);

  const { schedule, cancel } = useAutoSave(
    saveFn,
    editorSettings.autoSaveDelay,
  );

  const editor = useEditor({
    extensions: getEditorExtensions(),
    content: "",
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
      },
    },
    onDestroy() {
      // このシーンがフォーカスを持っていた場合、破棄時に参照をリセットする
      const state = useLinearEditorStore.getState();
      if (state.focusedSceneId === sceneId) {
        state.setFocusedEditor(null, null);
      }
    },
    onUpdate({ editor: e }) {
      if (isApplyingExternalUpdate.current) return;
      schedule();
      const text = getDocText(e.state.doc);
      const count = text.length;
      setCharCount(count);
      useTreeStore.getState().setCharCount(sceneId, count);

      // Auto-transition outline → draft
      const nodeStatus = useTreeStore
        .getState()
        .nodes.find((n) => n.id === sceneId)?.status as
        | SceneStatus
        | null
        | undefined;
      if (
        shouldAutoDraftTransition(
          count,
          wasEmptyRef.current,
          nodeStatus ?? null,
        )
      ) {
        wasEmptyRef.current = false;
        useTreeStore
          .getState()
          .setStatus(sceneId, "draft")
          .catch(() => {});
      }
    },
    onFocus() {
      const ed = editorRef.current;
      if (ed) onFocus(sceneId, ed);
    },
  });

  editorRef.current = editor;

  // CodexQuick: only update matchedIds for the active scene
  useCodexHighlight(editor, isActive ? undefined : { skipMatchedIds: true });
  useAttribution(editor);
  useCharacterFade(editor);

  // Load content
  useEffect(() => {
    if (!editor) return;
    let cancelled = false;

    async function load() {
      cancel();
      isApplyingExternalUpdate.current = true;
      try {
        const content = await loadSceneContent(sceneId);
        if (cancelled) return;
        const parsed = content && content !== "{}" ? JSON.parse(content) : "";
        editor!.commands.setContent(parsed, { emitUpdate: false });
      } finally {
        isApplyingExternalUpdate.current = false;
      }

      const text = getDocText(editor!.state.doc);
      const count = text.length;
      setCharCount(count);
      wasEmptyRef.current = count === 0;
      useTreeStore.getState().setCharCount(sceneId, count);

      // Load authorship spans
      const spans = await loadAuthorshipSpans(sceneId);
      if (!cancelled && spans.length > 0) {
        const markData = spansToMarkData(spans);
        const authorshipType = editor!.schema.marks["authorship"];
        if (authorshipType) {
          isApplyingExternalUpdate.current = true;
          try {
            editor!
              .chain()
              .command(({ tr }) => {
                tr.setMeta("programmaticInsert", true);
                for (const { from, to, attrs } of markData) {
                  const docSize = tr.doc.content.size;
                  const clampedFrom = Math.min(from, docSize);
                  const clampedTo = Math.min(to, docSize);
                  if (clampedFrom < clampedTo) {
                    tr.addMark(
                      clampedFrom,
                      clampedTo,
                      authorshipType.create(attrs),
                    );
                  }
                }
                return true;
              })
              .run();
          } finally {
            isApplyingExternalUpdate.current = false;
          }
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [sceneId, editor, cancel]);

  // Report height changes
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        onHeightChange(sceneId, entry.contentRect.height);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [sceneId, onHeightChange]);

  return (
    <div ref={containerRef}>
      <div
        className={cn(editorSettings.showLineNumbers && "editor-line-numbers")}
        style={
          {
            fontFamily: editorSettings.fontFamily,
            fontSize: `${editorSettings.fontSize}px`,
            lineHeight: editorSettings.lineHeight,
            maxWidth: `${editorSettings.maxContentWidth}px`,
            margin: "0 auto",
            wordBreak:
              editorSettings.wordBreak as React.CSSProperties["wordBreak"],
            lineBreak:
              editorSettings.lineBreak as React.CSSProperties["lineBreak"],
            "--editor-paragraph-indent": `${editorSettings.paragraphIndent}em`,
          } as React.CSSProperties
        }
      >
        {title && (
          <div
            className="mb-4 border-b border-border/40 pb-3"
            style={{
              fontSize: `${Math.round(editorSettings.fontSize * 1.4)}px`,
            }}
          >
            <div className="select-none font-semibold text-content-foreground/60">
              {title}
            </div>
          </div>
        )}
        <div
          data-linear-beat-display={editorSettings.linearBeatDisplay}
          className={filterSource ? `attribution-filter-${filterSource}` : ""}
        >
          <EditorContent editor={editor} />
        </div>
        <div className="mt-2 text-right text-xs text-muted-foreground/50">
          {charCount.toLocaleString()} chars
        </div>
      </div>
    </div>
  );
}
