import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  Sparkles,
  Wrench,
  X,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { useAiSettingsStore } from "@/features/chat/store";
import { useAiCapability } from "@/features/ai-policy/useAiCapability";
import { useEditorStore } from "@/features/editor/editorStore";
import { useLintStore } from "@/features/lint/lintStore";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import {
  buildTypoPayload,
  TYPO_PROMPT_VERSION,
} from "@/features/post-effect/typoPayloadBuilder";
import {
  listAnnotationsForScene,
  runPostEffect,
} from "@/features/post-effect/api";
import { getPromptCatalog } from "@/prompts/index";
import { applyAnnotationsToEditor } from "@/features/post-effect/applyAnnotationsToEditor";
import { closeAnnotation } from "@/features/post-effect/closeAnnotation";
import { applyTypoFixAndResolve } from "@/features/post-effect/typoFix";
import { parseAnnotationMeta } from "@/features/post-effect/annotationMeta";
import {
  ConfidenceBadge,
  ExpandedDetails,
  TypoChip,
  TypoContrastRow,
} from "@/features/post-effect/AnnotationDetails";
import { buildOffsetMap, strOffsetToPmPos } from "@/features/editor/offsetMap";
import type { Diagnostic } from "@/features/lint/types";
import type {
  PostEffectAnnotation,
  PostEffectSeverity,
} from "@/features/post-effect/types";

const TYPO_RULE_ID = "ja/typo-confusable";

// Stable empty fallback — Zustand のセレクタが render ごとに新規 `[]` を返すと
// useSyncExternalStore が「snapshot が変わった」と判定して無限ループする。
const EMPTY_ANNOTATIONS: PostEffectAnnotation[] = [];

const SEVERITY_ICONS: Record<PostEffectSeverity, React.ReactNode> = {
  error: <XCircle size={13} className="text-destructive shrink-0" />,
  warning: <AlertTriangle size={13} className="text-yellow-500 shrink-0" />,
  suggestion: <Info size={13} className="text-blue-400 shrink-0" />,
  info: <Info size={13} className="text-muted-foreground shrink-0" />,
};

interface Props {
  sceneId: string;
}

export function CurrentSceneTypoView({ sceneId }: Props) {
  const [running, setRunning] = useState(false);
  const analysisCapability = useAiCapability("analysis");
  const { setAnnotations } = useAnnotationStore();

  useEffect(() => {
    if (!useAiSettingsStore.getState().settings) {
      void useAiSettingsStore.getState().loadSettings();
    }
  }, []);

  const run = useCallback(async () => {
    if (running) return;
    const projectId = useTreeStore.getState().projectId;
    const model =
      useAiSettingsStore.getState().settings?.model ?? "gpt-4o-mini";
    setRunning(true);
    try {
      const payload = await buildTypoPayload(sceneId, model);
      const done = await new Promise<{
        ok: boolean;
        from_cache?: boolean;
        count?: number;
        error?: string;
      }>((resolve) => {
        runPostEffect(
          {
            project_id: projectId,
            effect_type: "typo_detection",
            scope_type: "scene",
            scope_target_id: sceneId,
            model,
            prompt_version: TYPO_PROMPT_VERSION,
            input_hash: payload.inputHash,
            codex_payload_json: "[]",
            scene_text: payload.sceneText,
            system_prompt: getPromptCatalog("ja").postEffect.typoSystem,
          },
          {
            onDone: (e) =>
              resolve({
                ok: true,
                from_cache: e.from_cache,
                count: e.annotation_count,
              }),
            onError: (e) => resolve({ ok: false, error: e.error }),
          },
        ).catch((err) => resolve({ ok: false, error: String(err) }));
      });

      const resp = await listAnnotationsForScene({ projectId, sceneId });
      setAnnotations(sceneId, resp.annotations);
      const editor = useEditorStore.getState().editor;
      if (editor) applyAnnotationsToEditor(editor, resp.annotations);
      setRunning(false);

      if (!done.ok) {
        toast.error("誤字脱字チェックに失敗しました", {
          description: done.error,
        });
        return;
      }
      if (done.from_cache) {
        toast.info("前回と同じ内容のためキャッシュから読み込みました", {
          description: "AI には送信していません",
        });
      } else if ((done.count ?? 0) === 0) {
        toast.success("誤字脱字は見つかりませんでした");
      }
    } catch (e) {
      console.error("typo run error", e);
      setRunning(false);
      toast.error("誤字脱字チェックを起動できませんでした", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }, [running, sceneId, setAnnotations]);

  const disabled = running || analysisCapability.state !== "enabled";
  const triggerTitle =
    analysisCapability.state === "disabled"
      ? analysisCapability.reason === "policy"
        ? "AIポリシーにより無効"
        : analysisCapability.reason === "no-model"
          ? "AIモデルが未選択です"
          : "AIが未設定です"
      : "現在シーンの誤字脱字チェックを実行";

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-xs text-muted-foreground">
          現在シーン誤字脱字
        </span>
        <button
          type="button"
          disabled={disabled}
          title={triggerTitle}
          onClick={() => void run()}
          className={cn(
            "flex items-center gap-1 rounded px-2 py-0.5 text-xs",
            "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {running ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Sparkles size={12} />
          )}
          <span>AIチェック</span>
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <LocalTypoList />
        <AiTypoList sceneId={sceneId} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local lint diagnostics (ja/typo-confusable)
// ---------------------------------------------------------------------------

function LocalTypoList() {
  const diagnostics = useLintStore((s) => s.diagnostics);
  const editor = useEditorStore((s) => s.editor);
  const localTypos = useMemo(
    () => diagnostics.filter((d) => d.rule_id === TYPO_RULE_ID),
    [diagnostics],
  );

  const jumpTo = (d: Diagnostic) => {
    if (!editor) return;
    const map = buildOffsetMap(editor.state.doc);
    const from = strOffsetToPmPos(map, d.range.start);
    const to = strOffsetToPmPos(map, d.range.end);
    if (from == null || to == null) return;
    editor
      .chain()
      .focus()
      .setTextSelection({ from, to })
      .scrollIntoView()
      .run();
  };

  const applyFix = (d: Diagnostic) => {
    if (!editor || !d.fix) return;
    const map = buildOffsetMap(editor.state.doc);
    const from = strOffsetToPmPos(map, d.fix.range.start);
    const to = strOffsetToPmPos(map, d.fix.range.end);
    if (from == null || to == null) return;
    editor
      .chain()
      .focus()
      .insertContentAt({ from, to }, d.fix.replacement)
      .run();
  };

  return (
    <section className="flex flex-col">
      <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-border bg-muted/30 px-3 py-1 text-[11px] font-medium text-muted-foreground">
        <span>ローカル検出</span>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none">
          {localTypos.length}
        </span>
      </div>
      {localTypos.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          確定的なタイポは見つかっていません
        </p>
      ) : (
        <ul className="flex flex-col gap-1 p-2">
          {localTypos.map((d, i) => (
            <li
              key={`${d.rule_id}:${d.range.start}:${i}`}
              className={cn(
                "group flex flex-col gap-1 rounded border border-border px-2 py-1.5 text-xs cursor-pointer select-none",
                "hover:border-muted-foreground/40 hover:bg-accent/30",
              )}
              onClick={() => jumpTo(d)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") jumpTo(d);
              }}
              role="button"
              tabIndex={0}
            >
              <div className="flex items-start gap-1.5">
                {SEVERITY_ICONS[d.severity]}
                <span className="leading-snug text-foreground/90">
                  {d.message}
                </span>
                {d.fix && (
                  <button
                    type="button"
                    aria-label="Quick Fix"
                    title={d.fix.label}
                    onClick={(e) => {
                      e.stopPropagation();
                      applyFix(d);
                    }}
                    className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-accent-foreground group-hover:opacity-100"
                  >
                    <CheckCircle2 size={13} />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// AI typo annotations
// ---------------------------------------------------------------------------

function AiTypoList({ sceneId }: { sceneId: string }) {
  const annotations = useAnnotationStore(
    (s) => s.annotationsByScene.get(sceneId) ?? EMPTY_ANNOTATIONS,
  );
  const typoAnns = useMemo(
    () => annotations.filter((a) => a.category === "typo_anchor"),
    [annotations],
  );
  const open = typoAnns.filter((a) => a.status === "open");
  const done = typoAnns.filter(
    (a) => a.status === "resolved" || a.status === "dismissed",
  );

  return (
    <section className="flex flex-col">
      <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-border bg-muted/30 px-3 py-1 text-[11px] font-medium text-muted-foreground">
        <span>AI 検出</span>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none">
          {open.length}
        </span>
      </div>
      {typoAnns.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          AI チェック未実行 / 検出なし
        </p>
      ) : (
        <div className="flex flex-col gap-1 p-2">
          {open.map((a) => (
            <TypoAnnotationRow key={a.id} ann={a} />
          ))}
          {done.length > 0 && (
            <>
              <p className="mt-1 px-1 text-[10px] text-muted-foreground">
                解決済み / 無視
              </p>
              {done.map((a) => (
                <TypoAnnotationRow key={a.id} ann={a} />
              ))}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function TypoAnnotationRow({ ann }: { ann: PostEffectAnnotation }) {
  const { focusedAnnotationId, setFocusedAnnotationId } = useAnnotationStore();
  const editor = useEditorStore((s) => s.editor);
  const focused = focusedAnnotationId === ann.id;
  const parsed = parseAnnotationMeta(ann);
  const currentModel = useAiSettingsStore((s) => s.settings?.model);
  const severity = (ann.severity ?? "info") as PostEffectSeverity;
  const isDone = ann.status === "dismissed" || ann.status === "resolved";
  const canFix =
    !!parsed.typo?.suggestion &&
    !!parsed.foundText &&
    !!editor &&
    ann.status === "open";

  async function dismiss() {
    await closeAnnotation(ann, "dismissed", editor);
  }
  async function resolve() {
    await closeAnnotation(ann, "resolved", editor);
  }
  async function fix() {
    const result = await applyTypoFixAndResolve(editor, ann);
    if (!result.applied) {
      toast.error("置換できませんでした", {
        description: "該当箇所が本文中で見つからないか変更されています",
      });
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => setFocusedAnnotationId(focused ? null : ann.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ")
          setFocusedAnnotationId(focused ? null : ann.id);
      }}
      className={cn(
        "group flex flex-col gap-1 rounded border px-2 py-1.5 text-xs cursor-pointer select-none transition-colors",
        focused
          ? "border-primary/60 bg-primary/5"
          : "border-border hover:border-muted-foreground/40 hover:bg-accent/30",
        isDone && "opacity-50",
      )}
    >
      <div className="flex items-start gap-1.5">
        {SEVERITY_ICONS[severity]}
        <div className="flex flex-1 flex-wrap items-center gap-1.5">
          {parsed.typo && <TypoChip category={parsed.typo.category} />}
          {parsed.confidence && <ConfidenceBadge level={parsed.confidence} />}
        </div>
        {!isDone && (
          <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            {canFix && (
              <button
                aria-label="Quick Fix (suggestion を適用)"
                title={`「${parsed.typo!.suggestion}」に置き換える`}
                onClick={(e) => {
                  e.stopPropagation();
                  void fix();
                }}
                className="rounded p-0.5 text-blue-600 hover:bg-blue-500/20"
              >
                <Wrench size={13} />
              </button>
            )}
            <button
              aria-label="解決済み"
              title="解決済み"
              onClick={(e) => {
                e.stopPropagation();
                resolve();
              }}
              className="rounded p-0.5 text-green-600 hover:bg-green-500/20"
            >
              <CheckCircle2 size={13} />
            </button>
            <button
              aria-label="無視"
              title="無視"
              onClick={(e) => {
                e.stopPropagation();
                dismiss();
              }}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted"
            >
              <X size={13} />
            </button>
          </div>
        )}
      </div>
      {parsed.typo && (
        <TypoContrastRow
          found={parsed.foundText}
          suggestion={parsed.typo.suggestion}
        />
      )}
      {ann.textSnapshot && (
        <blockquote className="border-l-2 border-muted-foreground/30 pl-2 text-muted-foreground line-clamp-2">
          {ann.textSnapshot}
        </blockquote>
      )}
      {focused && (
        <ExpandedDetails parsed={parsed} currentModel={currentModel} />
      )}
    </div>
  );
}
