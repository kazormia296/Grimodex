import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTreeStore } from "@/features/tree/treeStore";
import { useLintStore } from "@/features/lint/lintStore";
import { useLintProjectStore } from "@/features/lint/lintProjectStore";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { usePostEffectRunStore } from "@/features/post-effect/runStore";
import { useEditorStore } from "@/features/editor/editorStore";
import { applyAnnotationsToEditor } from "@/features/post-effect/applyAnnotationsToEditor";
import {
  listAnnotationsForProject,
  listAnnotationsForScene,
  listSceneLensForProject,
} from "@/features/post-effect/api";
import { getSceneIdsForScope } from "@/features/post-effect/consistencyPayloadBuilder";
import { isManualDismiss } from "../dismissedAnnotations";
import { useResolvedKouetsuScope } from "../useResolvedKouetsuScope";
import type {
  PostEffectAnnotation,
  SceneLensRecord,
} from "@/features/post-effect/types";
import {
  ANNOTATION_CATEGORY_TO_CAT,
  fromAnnotation,
  fromLintDiagnostic,
  fromSceneLens,
  sortIssues,
  type UnifiedIssue,
} from "./issueModel";
import type { PostEffectCategory } from "@/features/post-effect/types";

/**
 * useUnifiedIssues.ts — 統合トリアージリストのデータ配管。
 *
 * スコープ別のフェッチ戦略（設計書「データ配管」）:
 * - scene+open: annotation は listAnnotationsForScene → annotationStore ミラー
 *   購読（fetch → setAnnotations → applyAnnotationsToEditor の 3 点セットを維持。
 *   本文ハイライト反映を落とさない）。lint は live diagnostics、meta lens は
 *   project 一括から activeScene で絞る。
 * - folder/project+open: listAnnotationsForProject({status:"open"}) を 1 回
 *   （旧・観点別 7 ビューの分散フェッチを統合）。lint は lintProjectStore の
 *   完了済みスキャン結果、lens は project 一括。いずれもスコープの sceneIds で
 *   絞る（sceneId が null の指摘＝timeline 等のプロジェクト級はスコープに残す）。
 * - dismissed: プロジェクト全体の手動除外 annotation（旧 DismissedAnnotationsView
 *   と同じくスコープ非依存）。lint / lens に除外概念はない。
 *
 * open と dismissed は同時に返す（ステータス pill が両方の実数を表示するため。
 * バッジ正直の不変条件: 件数は常に表示リストの実長）。
 *
 * 再取得: refresh() 呼び出しのほか、post-effect run の done/cached 終端を
 * runStore 購読で検知して自動 refresh する（intent の per-scene 直列で連続
 * 終端しても 1 回に畳むよう 400ms デバウンス）。
 */

/** 受信箱対象 category（pseudo_comment 等は含めない）。 */
const TARGET_CATEGORIES = new Set<string>(
  Object.keys(ANNOTATION_CATEGORY_TO_CAT),
);

const REFRESH_DEBOUNCE_MS = 400;

export interface UnifiedIssues {
  /** 開いている指摘（スコープ適用・重要度ソート済み）。 */
  open: UnifiedIssue[];
  /** 手動除外した指摘（プロジェクト全体・重要度ソート済み）。 */
  dismissed: UnifiedIssue[];
  loading: boolean;
  refresh: () => void;
}

/**
 * post-effect run の終端（done / cached / error）を購読して onSettled を呼ぶ。
 * outcome undefined → 確定 への遷移だけを拾い、連続終端（intent の per-scene
 * 直列等）はデバウンスで 1 回に畳む。useUnifiedIssues の自動 refresh と
 * 最終実行時刻（useEffectLastRuns）の更新トリガで共用する。
 */
export function useOnRunSettled(onSettled: () => void): void {
  const cbRef = useRef(onSettled);
  cbRef.current = onSettled;
  useEffect(() => {
    const seen = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = usePostEffectRunStore.subscribe((state) => {
      let finished = false;
      for (const run of Object.values(state.runs)) {
        if (run.outcome !== undefined && !seen.has(run.runId)) {
          seen.add(run.runId);
          finished = true;
        }
      }
      if (!finished) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => cbRef.current(), REFRESH_DEBOUNCE_MS);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, []);
}

export function useUnifiedIssues(): UnifiedIssues {
  const scope = useResolvedKouetsuScope();
  const projectId = useTreeStore((s) => s.projectId);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);
  const nodes = useTreeStore((s) => s.nodes);
  const annotationsByScene = useAnnotationStore((s) => s.annotationsByScene);
  const liveDiagnostics = useLintStore((s) => s.diagnostics);
  const projectScanPhase = useLintProjectStore((s) => s.phase);
  const projectScanScenes = useLintProjectStore((s) => s.scenes);

  const [projectAnnotations, setProjectAnnotations] = useState<
    PostEffectAnnotation[]
  >([]);
  const [dismissedAnnotations, setDismissedAnnotations] = useState<
    PostEffectAnnotation[]
  >([]);
  const [lensRecords, setLensRecords] = useState<SceneLensRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // run 終端で自動 refresh（購読の実体は useOnRunSettled）。
  useOnRunSettled(refresh);

  // scene スコープ: アクティブシーンの annotation を fetch → store ミラー →
  // エディタ mark 反映（CurrentScene 系ビューと同じ 3 点セット）。
  useEffect(() => {
    if (scope.type !== "scene" || !projectId || !activeSceneId) return;
    let cancelled = false;
    void listAnnotationsForScene({ projectId, sceneId: activeSceneId })
      .then((resp) => {
        if (cancelled) return;
        useAnnotationStore
          .getState()
          .setAnnotations(activeSceneId, resp.annotations);
        const editor = useEditorStore.getState().editor;
        if (editor) applyAnnotationsToEditor(editor, resp.annotations);
      })
      .catch(() => {
        // 取得失敗はミラー未更新のまま（既存表示を維持）。
      });
    return () => {
      cancelled = true;
    };
  }, [scope.type, projectId, activeSceneId, nonce]);

  // folder/project スコープ: open annotation を一括 fetch。
  useEffect(() => {
    if (scope.type === "scene" || !projectId) {
      setProjectAnnotations([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void listAnnotationsForProject({ projectId, status: "open" })
      .then((resp) => {
        if (cancelled) return;
        setProjectAnnotations(resp.annotations);
      })
      .catch(() => {
        if (!cancelled) setProjectAnnotations([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope.type, projectId, nonce]);

  // 除外リスト（プロジェクト全体・手動除外のみ）。
  useEffect(() => {
    if (!projectId) {
      setDismissedAnnotations([]);
      return;
    }
    let cancelled = false;
    void listAnnotationsForProject({ projectId, status: "dismissed" })
      .then((resp) => {
        if (cancelled) return;
        setDismissedAnnotations(
          resp.annotations.filter(
            (a) =>
              TARGET_CATEGORIES.has(a.category as PostEffectCategory) &&
              isManualDismiss(a),
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setDismissedAnnotations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, nonce]);

  // meta 構造の lens（scene / project 共通で project 一括 → スコープ絞り）。
  useEffect(() => {
    if (!projectId) {
      setLensRecords([]);
      return;
    }
    let cancelled = false;
    void listSceneLensForProject(projectId)
      .then((records) => {
        if (!cancelled) setLensRecords(records);
      })
      .catch(() => {
        if (!cancelled) setLensRecords([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, nonce]);

  // スコープ内 sceneId 集合（folder/project のみ。scene は activeSceneId 直判定）。
  const scopeSceneIds = useMemo(() => {
    if (scope.type === "scene") return null;
    return new Set(
      getSceneIdsForScope(
        nodes,
        scope.type,
        scope.type === "folder" ? scope.anchorId : null,
      ),
    );
  }, [scope, nodes]);

  const open = useMemo(() => {
    const issues: UnifiedIssue[] = [];
    if (scope.type === "scene") {
      if (activeSceneId) {
        const anns = annotationsByScene.get(activeSceneId) ?? [];
        for (const ann of anns) {
          if (ann.status !== "open") continue;
          const issue = fromAnnotation(ann);
          if (issue) issues.push(issue);
        }
        liveDiagnostics.forEach((diag, i) => {
          issues.push(fromLintDiagnostic(activeSceneId, i, diag));
        });
        for (const record of lensRecords) {
          if (record.targetId !== activeSceneId) continue;
          const issue = fromSceneLens(record);
          if (issue) issues.push(issue);
        }
      }
    } else {
      const inScope = (sceneId: string | null) =>
        // sceneId 不定（timeline 等のプロジェクト級指摘）はスコープに残す
        // （旧 UI でも folder スコープ時に project 全域の時系列を表示していた）。
        sceneId === null ||
        scopeSceneIds === null ||
        scopeSceneIds.has(sceneId);
      for (const ann of projectAnnotations) {
        if (ann.status !== "open" || !inScope(ann.sceneId)) continue;
        const issue = fromAnnotation(ann);
        if (issue) issues.push(issue);
      }
      if (projectScanPhase === "done") {
        for (const scene of projectScanScenes) {
          if (!inScope(scene.sceneId)) continue;
          scene.diagnostics.forEach((diag, i) => {
            issues.push(fromLintDiagnostic(scene.sceneId, i, diag));
          });
        }
      }
      for (const record of lensRecords) {
        if (!inScope(record.targetId)) continue;
        const issue = fromSceneLens(record);
        if (issue) issues.push(issue);
      }
    }
    return sortIssues(issues);
  }, [
    scope.type,
    activeSceneId,
    annotationsByScene,
    liveDiagnostics,
    lensRecords,
    projectAnnotations,
    projectScanPhase,
    projectScanScenes,
    scopeSceneIds,
  ]);

  const dismissed = useMemo(() => {
    const issues: UnifiedIssue[] = [];
    for (const ann of dismissedAnnotations) {
      const issue = fromAnnotation(ann);
      if (issue) issues.push(issue);
    }
    return sortIssues(issues);
  }, [dismissedAnnotations]);

  return { open, dismissed, loading, refresh };
}
