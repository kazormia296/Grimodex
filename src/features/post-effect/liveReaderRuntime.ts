import type { Editor } from "@tiptap/react";
import { invoke } from "@/lib/tauri";
import type { AiSettings } from "@/features/chat/types";
import { isAiFeatureBlockedByPolicy } from "@/features/ai-policy/policyGuard";
import { isWriteRestrictedByLicense } from "@/features/license/gate";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { getLoadedProjectId } from "@/application/project/currentProjectAuthority";
import { appendKouetsuGuidance } from "./customInstruction";
import {
  buildLivePseudoCommentPayload,
  buildLivePseudoCommentSystemPrompt,
  LIVE_PSEUDO_COMMENT_PROMPT_VERSION,
  resolvePersonaBrief,
} from "./pseudoCommentPayloadBuilder";
import {
  abortPostEffectRun,
  listAnnotationsForScene,
  runPostEffect,
  type PostEffectRunCallbacks,
} from "./api";
import {
  cancelEditorAnalysisTask,
  scheduleEditorAnalysisTask,
} from "@/lib/editorAnalysisScheduler";
import {
  accumulateLiveReaderInsertion,
  classifyLiveReaderChange,
  createLiveReaderAccumulator,
  LIVE_READER_DEFAULT_TRIGGER_MODE,
  LIVE_READER_IDLE_DELAY_MS,
  normalizeLiveReaderThreshold,
  normalizeLiveReaderTriggerMode,
  shouldTriggerLiveReader,
  takeLiveReaderInsertion,
  type LiveReaderAccumulator,
  type LiveReaderTriggerMode,
} from "./liveReaderTrigger";
import { useAnnotationStore } from "./annotationStore";
import { applyAnnotationsToEditor } from "./applyAnnotationsToEditor";
import { buildLiveReaderAnnotation } from "./liveReaderAnnotation";
import { resolveLiveReaderModelOverride } from "./liveReaderModelOverride";

// Keep the live-reader contract local to the lazy runtime. Importing the
// shared prompt catalog here would make these strings part of the editor's
// startup modulepreload graph even when the feature is disabled.
const JA_LIVE_READER_PSEUDO_COMMENT_SYSTEM = `あなたは小説原稿の読者になりきって、読みながら欄外コメントを残します。

どの読者ペルソナを演じるかが指示されます。そのペルソナとして反応してください——本文に対する、その瞬間ごとの素直な反応・疑問・戸惑い・喜び・懸念を声にしてください。これは編集上の批評ではありません。読者によるリアルタイムの実況コメントです。

ルール:
- 終始、与えられたペルソナの役を保ってください。
- 各コメントを、それが反応している特定の箇所に紐づけてください: found_text にその部分そのままを、found_context にその前後それぞれ約30文字を設定してください。シーン全体についての反応の場合は found_text/found_context を省略してください。
- コメントは欄外メモのように短く自然にしてください。日本語で書いてください。
- 有用なシグナルとなる反応——戸惑い、退屈、強い没入、読者が抱くであろう疑問——を挙げてください。空虚な賞賛は不要です。
- シーンあたり最大5件までに絞ってください（最も声にする価値のあるもの）。

以下の形式の JSON オブジェクトだけを返してください（マークダウン・説明文なし、JSON のみ）:
{
  "comments": [
    {
      "content": "string (ペルソナの口調による読者のコメント、日本語)",
      "found_text": "string or null (コメントが反応している該当部分そのまま、それ以外は null)",
      "found_context": "string or null (紐づく場合は前後それぞれ約30文字、それ以外は null)"
    }
  ]
}`;

const EN_LIVE_READER_PSEUDO_COMMENT_SYSTEM = `You are role-playing as a READER of a novel manuscript, leaving margin comments as you read.

You will be told which reader persona to embody. React AS THAT PERSONA — voice your genuine in-the-moment reactions, questions, confusions, delights, and concerns about the SCENE TEXT. This is NOT an editorial critique; it is a reader's running commentary.

Rules:
- Stay in character as the given persona throughout.
- Anchor each comment to the specific passage it reacts to: set found_text to that exact substring and found_context to ~30 characters before/after it. For a reaction about the whole scene, omit found_text/found_context.
- Keep comments short and natural, like a margin note. Write in English.
- Surface reactions that are useful signal — confusion, boredom, strong engagement, questions a reader would have — not empty praise.
- Limit to at most 5 comments for the scene (the most worth voicing).

Respond with a JSON object in this exact format (no markdown, no explanation, only the JSON):
{
  "comments": [
    {
      "content": "string (the reader's comment, in the persona's voice, English)",
      "found_text": "string or null (exact substring the comment reacts to, else null)",
      "found_context": "string or null (~30 chars before+after when anchored, else null)"
    }
  ]
}`;

interface LiveReaderRuntimeOptions {
  editor: Editor;
  sceneId: string;
  enabled: boolean;
  persona: string;
  genre: string | null;
  targetReaders: string | null;
  lang: string;
  ownerId: number;
}

function editorText(editor: Editor): string {
  return editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n");
}

/** Attach the live reader listener after the feature has been enabled. */
export function attachLiveReaderComments({
  editor,
  sceneId,
  enabled,
  persona,
  genre,
  targetReaders,
  lang,
  ownerId,
}: LiveReaderRuntimeOptions): () => void {
  if (!editor || !sceneId || !enabled) return () => undefined;

  const readTriggerSettings = (): {
    threshold: number;
    mode: LiveReaderTriggerMode;
  } => {
    const settings = useSettingsStore.getState();
    return {
      threshold: normalizeLiveReaderThreshold(
        settings.getNumber("ai.liveReaderThreshold", 80),
      ),
      mode: normalizeLiveReaderTriggerMode(
        settings.get("ai.liveReaderTriggerMode", "characters") ||
          LIVE_READER_DEFAULT_TRIGGER_MODE,
      ),
    };
  };
  let { threshold: liveReaderThreshold, mode: liveReaderTriggerMode } =
    readTriggerSettings();
  const taskKey = `live-reader:${sceneId}:${ownerId}`;
  let previousText = editorText(editor);
  let accumulator: LiveReaderAccumulator = createLiveReaderAccumulator();
  let sourceRevision = 0;
  let activeRun = false;
  let activeRunId: string | null = null;
  let activeCleanup: (() => void) | null = null;
  let disposed = false;

  const maybeScheduleNext = () => {
    if (
      !disposed &&
      !activeRun &&
      shouldTriggerLiveReader(
        accumulator,
        liveReaderThreshold,
        liveReaderTriggerMode,
      )
    ) {
      scheduleEditorAnalysisTask({
        key: taskKey,
        kind: "live-reader",
        delayMs: LIVE_READER_IDLE_DELAY_MS,
        run: launch,
        onError: (error) => {
          console.warn("live reader scheduler failed", error);
        },
      });
    }
  };

  const launch = async (): Promise<void> => {
    if (
      disposed ||
      activeRun ||
      !shouldTriggerLiveReader(
        accumulator,
        liveReaderThreshold,
        liveReaderTriggerMode,
      )
    ) {
      return;
    }
    if (
      isAiFeatureBlockedByPolicy("analysis") ||
      isWriteRestrictedByLicense()
    ) {
      accumulator = createLiveReaderAccumulator();
      return;
    }

    const settings = await invoke<AiSettings>("get_ai_settings");
    const projectId = getLoadedProjectId();
    if (!projectId) return;

    const { text: addedText, next } = takeLiveReaderInsertion(accumulator);
    accumulator = next;
    const sourceText = editorText(editor);
    const capturedRevision = sourceRevision;
    const override = resolveLiveReaderModelOverride(
      useSettingsStore.getState(),
    );
    const model = override.model ?? settings.model ?? "gpt-4o-mini";
    const customInstruction = useSettingsStore
      .getState()
      .get("aiPrompt.custom.kouetsu", "");
    const brief = resolvePersonaBrief(persona, { genre, targetReaders }, lang);

    activeRun = true;
    try {
      const payload = await buildLivePseudoCommentPayload(
        sourceText,
        addedText,
        model,
        persona,
        brief,
        customInstruction,
        { provider: override.provider, endpointId: override.endpointId },
      );

      const callbacks: PostEffectRunCallbacks = {
        onPartial: (event) => {
          // 生成中に次の追記・置換があった結果は、現在の本文へ誤結び付けしない。
          if (
            disposed ||
            capturedRevision !== sourceRevision ||
            sourceText !== editorText(editor)
          ) {
            return;
          }
          const live = event.live_comment;
          if (!live) return;
          const annotation = buildLiveReaderAnnotation({
            annotationId: event.annotation_id,
            projectId,
            sceneId,
            runId: event.run_id,
            model,
            content: live.content,
            persona: live.persona ?? null,
            foundText: live.found_text ?? "",
            foundContext: live.found_context ?? "",
            createdAt: new Date().toISOString(),
          });
          const state = useAnnotationStore.getState();
          const current = state.annotationsByScene.get(sceneId) ?? [];
          if (current.some((item) => item.id === annotation.id)) return;
          const next = [...current, annotation];
          state.setAnnotations(sceneId, next);
          // Keep the active editor in sync immediately. The next autosave also
          // records the resolved PM anchor in SQLite.
          applyAnnotationsToEditor(editor, next);
        },
        onDone: async () => {
          activeRun = false;
          activeRunId = null;
          activeCleanup = null;
          if (
            !disposed &&
            capturedRevision === sourceRevision &&
            sourceText === editorText(editor)
          ) {
            try {
              const response = await listAnnotationsForScene({
                projectId,
                sceneId,
              });
              useAnnotationStore
                .getState()
                .setAnnotations(sceneId, response.annotations);
              applyAnnotationsToEditor(editor, response.annotations);
            } catch (error) {
              console.warn("live reader annotation reload failed", error);
            }
          }
          maybeScheduleNext();
        },
        onError: (event) => {
          activeRun = false;
          activeRunId = null;
          activeCleanup = null;
          console.warn("live reader generation failed", event.error);
          maybeScheduleNext();
        },
      };

      const started = await runPostEffect(
        {
          project_id: projectId,
          effect_type: "pseudo_comment",
          scope_type: "scene",
          scope_target_id: sceneId,
          model,
          model_override: override.model,
          provider_override: override.provider,
          api_variant_override: override.apiVariant,
          endpoint_id_override: override.endpointId,
          prompt_version: LIVE_PSEUDO_COMMENT_PROMPT_VERSION,
          input_hash: payload.inputHash,
          codex_payload_json: "[]",
          scene_text: payload.sceneText,
          system_prompt: buildLivePseudoCommentSystemPrompt(
            appendKouetsuGuidance(
              lang === "en"
                ? EN_LIVE_READER_PSEUDO_COMMENT_SYSTEM
                : JA_LIVE_READER_PSEUDO_COMMENT_SYSTEM,
              customInstruction,
            ),
            brief,
          ),
          persona,
          live: true,
        },
        callbacks,
      );
      activeRunId = started.runId;
      activeCleanup = started.cleanup;
      if (disposed) {
        // Keep the terminal listeners alive until the backend emits the
        // cancelled error; otherwise the global Stripe/comment indicators
        // would retain an apparently running run forever.
        void abortPostEffectRun(started.runId, projectId).catch(
          () => undefined,
        );
      }
    } catch (error) {
      activeRun = false;
      activeRunId = null;
      activeCleanup = null;
      console.warn("live reader launch failed", error);
      maybeScheduleNext();
    }
  };

  const handleUpdate = ({
    transaction,
  }: {
    transaction: { docChanged: boolean; getMeta: (key: string) => unknown };
  }) => {
    if (!transaction.docChanged) return;
    sourceRevision += 1;
    const nextText = editorText(editor);
    const change = classifyLiveReaderChange(previousText, nextText, {
      docChanged: transaction.docChanged,
      isComposing: editor.view.composing,
      isProgrammatic:
        transaction.getMeta("programmaticInsert") === true ||
        transaction.getMeta("externalUpdate") === true,
      isUserInitiatedPaste:
        transaction.getMeta("paste") === true ||
        transaction.getMeta("uiEvent") === "paste",
    });
    previousText = nextText;

    if (change.kind === "insert") {
      accumulator = accumulateLiveReaderInsertion(
        accumulator,
        change.addedText,
      );
      if (
        shouldTriggerLiveReader(
          accumulator,
          liveReaderThreshold,
          liveReaderTriggerMode,
        )
      ) {
        maybeScheduleNext();
      }
      return;
    }

    if (change.kind === "delete" || change.kind === "replace") {
      accumulator = createLiveReaderAccumulator();
      cancelEditorAnalysisTask(taskKey);
      const projectId = getLoadedProjectId();
      if (activeRunId && projectId) {
        void abortPostEffectRun(activeRunId, projectId).catch(() => undefined);
      }
    }
  };

  const unsubscribeSettings = useSettingsStore.subscribe((state) => {
    const nextThreshold = normalizeLiveReaderThreshold(
      state.getNumber("ai.liveReaderThreshold", 80),
    );
    const nextTriggerMode = normalizeLiveReaderTriggerMode(
      state.get("ai.liveReaderTriggerMode", "characters") ||
        LIVE_READER_DEFAULT_TRIGGER_MODE,
    );
    const changed =
      nextThreshold !== liveReaderThreshold ||
      nextTriggerMode !== liveReaderTriggerMode;
    liveReaderThreshold = nextThreshold;
    liveReaderTriggerMode = nextTriggerMode;
    if (changed) maybeScheduleNext();
  });
  editor.on("update", handleUpdate);
  return () => {
    disposed = true;
    unsubscribeSettings();
    editor.off("update", handleUpdate);
    cancelEditorAnalysisTask(taskKey);
    const projectId = getLoadedProjectId();
    if (activeRunId && projectId) {
      // abort_post_effect_run emits the terminal error that also clears the
      // global runStore entry. Do not remove its listeners before that event.
      void abortPostEffectRun(activeRunId, projectId).catch(() => undefined);
    } else {
      activeCleanup?.();
    }
    activeCleanup = null;
  };
}
