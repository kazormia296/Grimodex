import { useCallback, useEffect, useState } from "react";
import { Info, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { useAiSettingsStore } from "@/features/chat/store";
import { useAiCapability } from "@/features/ai-policy/useAiCapability";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { useEditorStore } from "@/features/editor/editorStore";
import { useKouetsuStore } from "@/features/kouetsu/kouetsuStore";
import {
  buildPseudoCommentPayload,
  buildPseudoCommentSystemPrompt,
  personaRequiresTargetProfile,
  PSEUDO_COMMENT_PROMPT_VERSION,
  PSEUDO_PERSONA_DEFS,
  PSEUDO_PERSONAS,
  resolvePersonaBrief,
} from "@/features/post-effect/pseudoCommentPayloadBuilder";
import { fetchProjectContext } from "@/features/project/contextAtoms";
import {
  listAnnotationsForScene,
  runPostEffect,
} from "@/features/post-effect/api";
import { getPromptCatalog } from "@/prompts/index";
import { applyAnnotationsToEditor } from "@/features/post-effect/applyAnnotationsToEditor";
import {
  groupPseudoThreads,
  PseudoCommentThread,
} from "@/features/post-effect/PseudoCommentThread";
import type { PostEffectDoneEvent } from "@/features/post-effect/types";

interface Props {
  sceneId: string;
}

export function CurrentScenePseudoCommentView({ sceneId }: Props) {
  const [running, setRunning] = useState(false);
  const [persona, setPersona] = useState<string>(PSEUDO_PERSONAS[0]);
  // genre は全ペルソナの brief に、targetReaders は「ターゲット読者層」ペルソナの
  // 実体として注入する。targetReaders 空のとき同ペルソナは選択不可にする。
  const [genre, setGenre] = useState<string | null>(null);
  const [targetReaders, setTargetReaders] = useState<string | null>(null);
  const analysisCapability = useAiCapability("analysis");
  const { setAnnotations } = useAnnotationStore();
  const annotationsByScene = useAnnotationStore((s) => s.annotationsByScene);
  const sceneAnnotations = annotationsByScene.get(sceneId) ?? [];
  const threads = groupPseudoThreads(sceneAnnotations);
  const panelActive = useKouetsuStore((s) => s.panelActive);

  useEffect(() => {
    if (!useAiSettingsStore.getState().settings) {
      void useAiSettingsStore.getState().loadSettings();
    }
  }, []);

  const reload = useCallback(async () => {
    const projectId = useTreeStore.getState().projectId;
    const resp = await listAnnotationsForScene({ projectId, sceneId });
    setAnnotations(sceneId, resp.annotations);
    const editor = useEditorStore.getState().editor;
    if (editor) applyAnnotationsToEditor(editor, resp.annotations);
  }, [sceneId, setAnnotations]);

  // 初回 / シーン切替時に読み込む。KouetsuPanel が keepalive で hidden の間は
  // bail する: reload の listAnnotations + setAnnotations + applyAnnotationsToEditor
  // は EditorPane のシーンロード (annotations を editor/store に適用) と冗長で、
  // hidden 中は EditorPane が editor を最新に保つ。再アクティブ化時に panelActive
  // が deps 経由で false→true になり現在シーンで 1 回 catch up する。
  useEffect(() => {
    if (!panelActive) return;
    void reload();
  }, [reload, panelActive]);

  // genre / 想定読者プロフィールを取得 (ペルソナ brief 注入 + ターゲット読者層の
  // 選択可否判定)。パネル再アクティブ化時に取り直し、設定変更を拾う。
  useEffect(() => {
    if (!panelActive) return;
    let cancelled = false;
    void fetchProjectContext().then((ctx) => {
      if (cancelled) return;
      setGenre(ctx?.genre ?? null);
      setTargetReaders(ctx?.targetReaders ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [panelActive]);

  const hasTargetProfile = Boolean(targetReaders?.trim());

  // 選択中ペルソナがプロフィール必須かつ未設定になったら一般読者へ戻す
  // (設定をクリアした等のエッジケース)。判定はレジストリを単一の真実源にする。
  useEffect(() => {
    if (!hasTargetProfile && personaRequiresTargetProfile(persona)) {
      setPersona(PSEUDO_PERSONAS[0]);
    }
  }, [hasTargetProfile, persona]);

  const run = useCallback(async () => {
    if (running) return;
    if (blockIfPolicyOff("analysis")) return;
    const projectId = useTreeStore.getState().projectId;
    const model =
      useAiSettingsStore.getState().settings?.model ?? "gpt-4o-mini";
    setRunning(true);
    try {
      // brief を 1 度だけ解決し、hash (payload) と system_prompt で同じものを使う。
      const brief = resolvePersonaBrief(persona, { genre, targetReaders });
      const payload = await buildPseudoCommentPayload(
        sceneId,
        model,
        persona,
        brief,
      );
      const outcome = await new Promise<{
        ok: boolean;
        e?: PostEffectDoneEvent;
        error?: string;
      }>((resolve) => {
        runPostEffect(
          {
            project_id: projectId,
            effect_type: "pseudo_comment",
            scope_type: "scene",
            scope_target_id: sceneId,
            model,
            prompt_version: PSEUDO_COMMENT_PROMPT_VERSION,
            input_hash: payload.inputHash,
            codex_payload_json: "[]",
            scene_text: payload.sceneText,
            system_prompt: buildPseudoCommentSystemPrompt(
              getPromptCatalog("ja").postEffect.pseudoCommentSystem,
              brief,
            ),
            persona,
          },
          {
            onDone: (e) => resolve({ ok: true, e }),
            onError: (e) => resolve({ ok: false, error: e.error }),
          },
        ).catch((err) => resolve({ ok: false, error: String(err) }));
      });

      await reload();
      setRunning(false);

      if (!outcome.ok) {
        toast.error("疑似コメントの生成に失敗しました", {
          description: outcome.error,
        });
        return;
      }
      if (outcome.e?.from_cache) {
        toast.info("前回と同じ内容のためキャッシュから読み込みました", {
          description: "AI には送信していません",
        });
      } else if ((outcome.e?.annotation_count ?? 0) === 0) {
        toast.success("コメントはありませんでした");
      }
    } catch (e) {
      console.error("pseudo_comment launch error", e);
      setRunning(false);
      toast.error("疑似コメントを起動できませんでした", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }, [running, sceneId, persona, genre, targetReaders, reload]);

  const disabled = running || analysisCapability.state !== "enabled";

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <select
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
          className="rounded border border-border bg-background px-1.5 py-0.5 text-xs outline-none"
        >
          {PSEUDO_PERSONA_DEFS.map((d) => {
            const locked =
              Boolean(d.requiresTargetProfile) && !hasTargetProfile;
            return (
              <option
                key={d.label}
                value={d.label}
                disabled={locked}
                title={
                  locked
                    ? "プロジェクト設定で想定読者を入力すると選べます"
                    : undefined
                }
              >
                {locked ? `${d.label}（要・想定読者設定）` : d.label}
              </option>
            );
          })}
        </select>
        <button
          type="button"
          disabled={disabled}
          title={
            analysisCapability.state === "disabled"
              ? "AIが利用できません"
              : "選択したペルソナでコメントを生成"
          }
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
          <span>AIコメント</span>
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {threads.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Info size={18} />
            <span>コメントはまだありません</span>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {threads.map((t) => (
              <PseudoCommentThread
                key={t.root.id}
                thread={t}
                onChanged={() => void reload()}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
