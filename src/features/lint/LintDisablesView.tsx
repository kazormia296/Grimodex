import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import i18next from "@/lib/i18n";
import { Trash2, Navigation } from "lucide-react";
import type { Editor } from "@tiptap/core";

import { useEditorStore } from "@/features/editor/editorStore";
import { buildOffsetMap, strOffsetToPmPos } from "@/features/editor/offsetMap";
import { openEditorDocument } from "@/application/editor/openEditorDocument";
import { defaultEditorNavigationPorts } from "@/application/editor/defaultEditorNavigation";
import { listNodes, loadSceneContent } from "@/features/tree/api";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { getCurrentProjectId } from "@/features/project/projectStore";

import { useLintStore } from "./lintStore";
import { useLintProjectStore } from "./lintProjectStore";
import { buildBlocksFromJson } from "./projectScan";
import type { LintDisableRange } from "./lintDisableWalker";

interface SceneDisables {
  sceneId: string;
  sceneTitle: string;
  sceneText: string;
  disables: LintDisableRange[];
}

/**
 * Remove a disable directive from the live editor. Covers both:
 *   - inline `lintDisable` Marks inside the range
 *   - any block's `lintDisabled` attribute that the range coincides with
 *
 * We don't distinguish between the two at the view layer because the
 * emitted directive carries only (range, rules); clearing both is
 * idempotent and matches "the author wants this disable gone".
 */
function removeDisable(editor: Editor, d: LintDisableRange): void {
  const map = buildOffsetMap(editor.state.doc);
  const from = strOffsetToPmPos(map, d.range.start);
  const to = strOffsetToPmPos(map, d.range.end);
  if (from == null || to == null) return;

  const { state } = editor;
  const tr = state.tr;
  const markType = state.schema.marks.lintDisable;
  if (markType) tr.removeMark(from, to, markType);

  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isBlock) return undefined;
    if (node.attrs.lintDisabled == null) return undefined;
    const kind = node.type.name;
    if (
      kind !== "paragraph" &&
      kind !== "heading" &&
      kind !== "blockquote" &&
      kind !== "listItem" &&
      kind !== "tableCell"
    ) {
      return undefined;
    }
    const newAttrs = { ...node.attrs, lintDisabled: null };
    tr.setNodeMarkup(pos, undefined, newAttrs, node.marks);
    return undefined;
  });

  editor.view.dispatch(tr);
}

/**
 * Build a short excerpt of the disabled text for display. Mirrors the
 * truncation approach used elsewhere in the panel — keep it short so
 * the list stays readable.
 */
function excerpt(sceneText: string, d: LintDisableRange): string {
  const start = Math.max(0, Math.min(d.range.start, sceneText.length));
  const end = Math.max(start, Math.min(d.range.end, sceneText.length));
  const raw = sceneText.slice(start, end);
  if (raw.length <= 40) return raw;
  return `${raw.slice(0, 18)}…${raw.slice(-18)}`;
}

function formatRules(rules: string[]): string {
  if (rules.length === 1 && rules[0] === "*")
    return i18next.t("lint.disables.allRules", "すべてのルール");
  return rules.join(", ");
}

export function DisablesView() {
  const { t } = useTranslation();
  const editor = useEditorStore((s) => s.editor);
  const currentSceneId = useLintStore((s) => s.currentSceneId);
  const requestJump = useLintProjectStore((s) => s.requestJump);

  const [otherScenes, setOtherScenes] = useState<SceneDisables[]>([]);
  const [loading, setLoading] = useState(true);

  // Bump on every editor transaction so the live current-scene view
  // refreshes whenever the user adds / removes a disable Mark or a
  // block attribute. Can't rely on `rawDiagnostics` — lint runs are
  // debounced 500ms, and a user who adds a disable in an already-
  // clean scene wouldn't see the list update until the next lint.
  const [docVersion, setDocVersion] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const onTx = () => setDocVersion((v) => v + 1);
    editor.on("update", onTx);
    return () => {
      editor.off("update", onTx);
    };
  }, [editor]);

  // Current-scene disables come from the live editor — immediate & fresh.
  const currentScene: SceneDisables | null = useMemo(() => {
    if (!editor || !currentSceneId) return null;
    const map = buildOffsetMap(editor.state.doc);
    const sceneText = map.blocks.map((b) => b.text).join("\n");
    return {
      sceneId: currentSceneId,
      sceneTitle: t("lint.disables.currentScene", "現在のシーン"),
      sceneText,
      disables: map.disables,
    };
    // `docVersion` is the doc-change signal — eslint-no-unused isn't
    // worth silencing via a `void` call because we genuinely need
    // the memo to re-run on every transaction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, currentSceneId, docVersion, t]);

  // Other scenes: walk the stored JSON. The design doc explicitly
  // requires this — disables in scenes the user hasn't opened still
  // surface in this tab.
  const refreshOtherScenes = useCallback(async () => {
    setLoading(true);
    try {
      const nodes = await listNodes(getCurrentProjectId());
      const scenes = nodes
        .filter((n) => n.nodeType === "scene" && n.id !== currentSceneId)
        .sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));
      const result: SceneDisables[] = [];
      for (const node of scenes) {
        try {
          const content = await loadSceneContent(node.id);
          const { sceneText, disables } = buildBlocksFromJson(content);
          if (disables.length > 0) {
            result.push({
              sceneId: node.id,
              sceneTitle: node.title,
              sceneText,
              disables,
            });
          }
        } catch {
          // Skip scenes we couldn't load — don't block the whole list
          // on a single failure.
        }
      }
      setOtherScenes(result);
    } finally {
      setLoading(false);
    }
  }, [currentSceneId]);

  useEffect(() => {
    void refreshOtherScenes();
  }, [refreshOtherScenes]);

  const onJump = useCallback(
    (scene: SceneDisables, d: LintDisableRange) => {
      if (editor && currentSceneId === scene.sceneId) {
        const map = buildOffsetMap(editor.state.doc);
        const from = strOffsetToPmPos(map, d.range.start);
        const to = strOffsetToPmPos(map, d.range.end);
        if (from != null && to != null) {
          editor
            .chain()
            .focus()
            .setTextSelection({ from, to })
            .scrollIntoView()
            .run();
          return;
        }
      }
      requestJump({
        sceneId: scene.sceneId,
        range: { start: d.range.start, end: d.range.end },
      });
      openEditorDocument(
        {
          target: { kind: "scene", documentId: scene.sceneId },
          mode: "pinned",
          revealEditor: true,
          focusEditor: false,
          syncSceneContext: true,
        },
        defaultEditorNavigationPorts,
      );
    },
    [editor, currentSceneId, requestJump],
  );

  const onRemove = useCallback(
    (d: LintDisableRange) => {
      if (!editor) return;
      removeDisable(editor, d);
    },
    [editor],
  );

  const currentEmpty = !currentScene || currentScene.disables.length === 0;
  const otherEmpty = otherScenes.length === 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        {currentScene && (
          <Section
            title={`${t("lint.disables.currentScene", "現在シーン")} (${currentScene.disables.length})`}
            empty={
              currentEmpty
                ? t("lint.disables.none", "無効化はありません")
                : null
            }
          >
            {!currentEmpty &&
              currentScene.disables.map((d, idx) => (
                <DisableRow
                  key={`${currentScene.sceneId}-${idx}`}
                  scene={currentScene}
                  d={d}
                  onJump={() => onJump(currentScene, d)}
                  onRemove={() => onRemove(d)}
                  canRemove
                />
              ))}
          </Section>
        )}

        <Section
          title={`${t("lint.disables.otherScenes", "その他のシーン")} (${otherScenes.reduce(
            (n, s) => n + s.disables.length,
            0,
          )})`}
          empty={
            loading
              ? t("common.loading", "読み込み中…")
              : otherEmpty
                ? t("lint.disables.none", "無効化はありません")
                : null
          }
        >
          {!otherEmpty &&
            otherScenes.map((scene) => (
              <div key={scene.sceneId} className="flex flex-col">
                <div className="px-3 py-1 text-xs font-medium text-muted-foreground border-t border-border bg-muted/20">
                  {scene.sceneTitle}
                </div>
                {scene.disables.map((d, idx) => (
                  <DisableRow
                    key={`${scene.sceneId}-${idx}`}
                    scene={scene}
                    d={d}
                    onJump={() => onJump(scene, d)}
                    onRemove={() => onRemove(d)}
                    canRemove={false}
                  />
                ))}
              </div>
            ))}
        </Section>
      </div>
    </div>
  );
}

function Section({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string | null;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 border-b border-border bg-background px-3 py-1.5 text-xs font-semibold">
        {title}
      </div>
      {empty ? (
        <div className="px-3 py-4 text-center text-xs text-muted-foreground">
          {empty}
        </div>
      ) : (
        children
      )}
    </div>
  );
}

function DisableRow({
  scene,
  d,
  onJump,
  onRemove,
  canRemove,
}: {
  scene: SceneDisables;
  d: LintDisableRange;
  onJump: () => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-2 px-3 py-2 hover:bg-accent/30 border-t border-border/50">
      <div className="flex flex-1 min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-1.5 text-xs">
          <code className="rounded bg-muted px-1 py-0.5 text-[10px]">
            {formatRules(d.rules)}
          </code>
          <span className="text-muted-foreground">
            {d.range.start}–{d.range.end}
          </span>
        </div>
        <div className="truncate font-mono text-xs text-muted-foreground">
          {excerpt(scene.sceneText, d) ||
            t("lint.disables.emptyBlock", "(空のブロック)")}
        </div>
      </div>
      <button
        type="button"
        onClick={onJump}
        title={t("lint.disables.jumpToLocation", "該当箇所へジャンプ")}
        className="flex-shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Navigation className="h-3.5 w-3.5" />
      </button>
      {canRemove && (
        <button
          type="button"
          onClick={onRemove}
          title={t("lint.disables.removeDisable", "無効化を解除")}
          className="flex-shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
