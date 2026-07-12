import i18next from "@/lib/i18n";
import { toast } from "sonner";
import { useTreeStore } from "@/features/tree/treeStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { openEditorDocument } from "@/application/editor/openEditorDocument";
import { defaultEditorNavigationPorts } from "@/features/editor/editorNavigationPorts";
import { useEditorStore } from "@/features/editor/editorStore";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { useLintProjectStore } from "@/features/lint/lintProjectStore";
import { applyLintFix, jumpToDiagnostic } from "@/features/lint/lintActions";
import { closeAnnotation } from "@/features/post-effect/closeAnnotation";
import { applyTypoFixAndResolve } from "@/features/post-effect/typoFix";
import { updateAnnotationStatus } from "@/features/post-effect/api";
import { postEffectErrorToast } from "@/features/post-effect/errorToast";
import {
  runConsistencyCheck,
  runIntentDriftCheck,
  runMetaStructureCheck,
  runReviewCheck,
  runTimelineCheck,
  runTypoCheck,
  type KouetsuRunOutcome,
  type KouetsuRunScope,
} from "../runners";
import type { KouetsuScope } from "../kouetsuStore";
import type { IssueCat, UnifiedIssue } from "./issueModel";

/**
 * issueActions.ts — 統合トリアージ行への操作（本文ジャンプ / Fix / 解決 /
 * 無視 / 再表示）と観点タイルからの単発実行。UI コンポーネントから薄く呼ぶ。
 */

/**
 * シーンを選んだときのエディタ移動。KouetsuScopeBar 由来のロジック
 * （ChatPanel.selectSceneFromChat の軽量複製 — 重い依存の連鎖を避ける）。
 */
export function openSceneInEditor(sceneId: string): void {
  openEditorDocument(
    {
      target: { kind: "scene", documentId: sceneId },
      mode: "pinned",
      revealEditor: useLayoutStore.getState().isPanelActive("editor"),
      focusEditor: false,
      syncSceneContext: true,
    },
    defaultEditorNavigationPorts,
  );
}

/** 越境ジャンプ後に annotation mark が現れるまで待つ上限（≒1s）。 */
const MAX_FOCUS_FRAMES = 60;

/**
 * annotation mark（data-pe-ann-id）が DOM に現れてから focus を立てる。
 * シーン切替直後は EditorPane の annotation 適用が非同期なので rAF リトライ
 * （jumpToComment と同方式）。上限超過時も best-effort で focus は立てる
 * （シーンは開けている）。
 */
function focusAnnotationWhenReady(annId: string): void {
  const store = useAnnotationStore.getState();
  // 同一 id の再クリックでも EditorPane の effect が発火するよう一旦クリア。
  store.setFocusedAnnotationId(null);
  let frames = 0;
  const attempt = () => {
    const el = document.querySelector(
      `[data-pe-ann-id="${CSS.escape(annId)}"]`,
    );
    if (el || frames >= MAX_FOCUS_FRAMES) {
      useAnnotationStore.getState().setFocusedAnnotationId(annId);
      return;
    }
    frames += 1;
    requestAnimationFrame(attempt);
  };
  queueMicrotask(attempt);
}

/** 本文ジャンプ。lint は範囲選択、annotation は mark フォーカス、lens はシーンを開くのみ。 */
export function jumpToIssue(issue: UnifiedIssue): void {
  const activeSceneId = useTreeStore.getState().activeSceneId;
  if (issue.source.kind === "lint") {
    const { sceneId, diag } = issue.source;
    const editor = useEditorStore.getState().editor;
    if (
      sceneId === activeSceneId &&
      editor &&
      editor.state.doc.content.size > 0
    ) {
      jumpToDiagnostic(editor, diag);
      return;
    }
    // 非アクティブシーン: LinterPanel の project モードと同じ deferred jump
    //（EditorPane がシーン読込後に consumeJump で選択する）。
    useLintProjectStore.getState().requestJump({ sceneId, range: diag.range });
    openSceneInEditor(sceneId);
    return;
  }
  if (issue.source.kind === "lens") {
    if (issue.sceneId) openSceneInEditor(issue.sceneId);
    return;
  }
  const ann = issue.source.ann;
  if (!ann.sceneId) return;
  if (ann.sceneId !== activeSceneId) openSceneInEditor(ann.sceneId);
  focusAnnotationWhenReady(ann.id);
}

/** 解決/無視が可能か（annotation 行のみ。lint / lens に該当操作はない）。 */
export function canClose(issue: UnifiedIssue): boolean {
  return issue.source.kind === "annotation";
}

/**
 * Fix を今すぐ適用できるか。lint / typo とも対象シーンがアクティブで
 * エディタが載っていることが条件（裏でシーンを差し替えて置換はしない —
 * LinterPanel の設計判断を踏襲）。
 */
export function canFixNow(
  issue: UnifiedIssue,
  activeSceneId: string | null,
): boolean {
  if (!issue.fixable) return false;
  return issue.sceneId != null && issue.sceneId === activeSceneId;
}

/** 解決（annotation のみ）。成功時 true = リストから消える。 */
export async function resolveIssue(issue: UnifiedIssue): Promise<boolean> {
  if (issue.source.kind !== "annotation") return false;
  const editor = useEditorStore.getState().editor;
  await closeAnnotation(issue.source.ann, "resolved", editor);
  return true;
}

/** 無視＝手動除外（annotation のみ）。 */
export async function dismissIssue(issue: UnifiedIssue): Promise<boolean> {
  if (issue.source.kind !== "annotation") return false;
  const editor = useEditorStore.getState().editor;
  await closeAnnotation(issue.source.ann, "dismissed", editor);
  return true;
}

/** 除外リストからの再表示（DismissedAnnotationsView.reopen と同等）。 */
export async function restoreIssue(issue: UnifiedIssue): Promise<boolean> {
  if (issue.source.kind !== "annotation") return false;
  const ann = issue.source.ann;
  const projectId = useTreeStore.getState().projectId ?? "";
  try {
    await updateAnnotationStatus(ann.id, "open", projectId);
  } catch {
    return false;
  }
  useAnnotationStore.getState().updateAnnotationStatus(ann.id, "open");
  return true;
}

/**
 * Fix 適用。typo は提案置換 + 解決（applyTypoFixAndResolve）、lint は
 * insertContentAt（applyLintFix、auto-resolve / 再 lint 込み）。
 * true = 行がリストから消える見込み。
 */
export async function fixIssue(issue: UnifiedIssue): Promise<boolean> {
  const editor = useEditorStore.getState().editor;
  if (!editor) return false;
  if (issue.source.kind === "annotation") {
    const result = await applyTypoFixAndResolve(editor, issue.source.ann);
    if (!result.applied) {
      toast.error(i18next.t("kouetsu.typo.replacementFailed"), {
        description: i18next.t("kouetsu.typo.replacementFailedDesc"),
      });
    }
    return result.applied;
  }
  if (issue.source.kind === "lint") {
    applyLintFix(editor, issue.source.sceneId, issue.source.diag);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 観点タイルからの単発実行
// ---------------------------------------------------------------------------

/** KouetsuScope → runner 用スコープ（fullCheck.toRunScope と同じ規則）。 */
function toRunScope(scope: KouetsuScope): KouetsuRunScope | null {
  if (scope.type === "folder")
    return { type: "folder", anchorId: scope.anchorId };
  if (scope.type === "project") return { type: "project" };
  const sceneId = useTreeStore.getState().activeSceneId;
  return sceneId ? { type: "scene", sceneId } : null;
}

function reportOutcome(outcome: KouetsuRunOutcome): void {
  // blocked（ガード拒否）はガードが toast 済み。成功/キャッシュ/件数は
  // runStore の進捗トーストが表示する。ここではハード失敗のみ報告する。
  if (!outcome.ok) {
    postEffectErrorToast(
      i18next.t("kouetsu.triage.runCategoryFailed"),
      outcome.error,
    );
  }
}

/**
 * 観点単発の実行（ダッシュボードタイルの実行ボタン）。結果の一覧反映は
 * useUnifiedIssues の run 終端購読が自動で refresh する。impact は手動運用
 *（Codex 変更時）、linter の scene は live lint 済みのためどちらも対象外。
 */
export async function runCategoryCheck(
  cat: IssueCat,
  scope: KouetsuScope,
): Promise<void> {
  if (cat === "linter") {
    if (scope.type === "scene") return;
    const projectId = useTreeStore.getState().projectId;
    if (projectId) await useLintProjectStore.getState().start(projectId);
    return;
  }
  const runScope = toRunScope(scope);
  if (!runScope) return;
  try {
    switch (cat) {
      case "typo":
        reportOutcome(await runTypoCheck(runScope));
        return;
      case "consistency": {
        const { codex, intra } = await runConsistencyCheck(runScope);
        // 片側成功なら成功側の指摘は保存されている。失敗側のみ報告する。
        if (!codex.ok) reportOutcome(codex);
        else if (!intra.ok) reportOutcome(intra);
        return;
      }
      case "review":
        reportOutcome(await runReviewCheck(runScope));
        return;
      case "intent":
        reportOutcome(await runIntentDriftCheck(runScope, {}));
        return;
      case "meta":
        reportOutcome(await runMetaStructureCheck(runScope));
        return;
      case "timeline":
        reportOutcome(await runTimelineCheck());
        return;
      case "impact":
        return;
    }
  } catch (e) {
    postEffectErrorToast(
      i18next.t("kouetsu.triage.runCategoryFailed"),
      e instanceof Error ? e.message : String(e),
    );
  }
}
