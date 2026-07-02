import { useEffect, useCallback } from "react";
import type { Editor } from "@tiptap/core";
import { toast } from "sonner";
import i18next from "@/lib/i18n";
import { useProseStagingStore } from "@/features/agent-writes/proseStagingStore";
import {
  agentAcceptProseStage,
  agentDiscardProseStage,
  loadLatestProposedProse,
} from "@/features/agent-writes/prose";
import {
  isAutoAcceptEnabled,
  isHeadlessAppliable,
  isProposalStale,
} from "@/features/agent-writes/autoAcceptGate";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { saveScene } from "@/features/editor/editorSaveRegistry";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { useInlineAiStore } from "./inlineAiStore";

interface InlineAiDiffApi {
  showProvidedText: (
    text: string,
    opts: {
      mode: "insert" | "replace";
      stagingId?: string;
      originalRange?: { from: number; to: number };
      insertPos?: number;
      model?: string;
    },
  ) => void;
  accept: () => void;
  rejectOrAbort: () => void;
  getActiveStagingId: () => string | null;
}

/**
 * Rust 側 accept/discard の「行が既に proposed でない」bail
 * (agent_writes.rs: "staging entry is not in proposed status") の判定。
 * Tauri invoke のエラーは環境により string / Error のどちらでも届く。
 */
function isRowNotProposedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("not in proposed status");
}

/**
 * Bridges agent/MCP prose_staging proposals into the inline-AI diff accept/reject UI.
 *
 * 受理判断そのものには prose_staging.base_version の stale 検査を課さない:
 * この経路は人間が「現在の本文」に重ねた diff を目視して受理する
 * human-in-the-loop であり、propose 後に本文が進んでいても最新本文ベースで
 * 判断できる。version 検査が適用可否を決めるのは無人適用 (headless) 側。
 * ただし surface 時の suppression (surfaceLatestProposal) は staleness を
 * 参照する — stale 行は headless 自動適用が適用せず `proposed` のまま残す
 * ため、「auto-apply が拾うから隠す」と永久に孤児化する。
 */
export function useAgentProseStaging(
  editor: Editor | null,
  sceneId: string | null,
  diffApi: InlineAiDiffApi,
) {
  const pending = useProseStagingStore((s) => s.pending);
  const clearPending = useProseStagingStore((s) => s.clear);
  const enqueue = useProseStagingStore((s) => s.enqueue);

  /**
   * シーンの最新 proposed 行を diff UI へ乗せる。mount 時と accept/reject
   * 完了後のチェーンが共用する (判定の食い違い防止)。
   *
   * Headless auto-apply owns appendable / anchored-insert proposals. If it is
   * enabled, do NOT surface them in the diff UI — the backlog drain / poller
   * will apply them, and showing a diff for an already-applied (now 'accepted')
   * row causes a double-apply and an "entry is not in proposed status" error
   * on accept. Non-anchored insert / replace are never auto-applied, so they
   * still surface for manual placement.
   *
   * 例外: stale (base_version 不一致) な行は auto-apply が適用せず
   * `proposed` のまま残す (autoApplyProse の stale 検知) ので、ここで隠すと
   * 誰にも拾われない孤児になる。stale 行は suppress せず diff UI に乗せる —
   * これが backlog / live 両経路の not-applied フォールバック
   * (proseStagingStore.enqueue) の、シーンを開いた時の受け皿になる。
   */
  const surfaceLatestProposal = useCallback(
    async (
      targetSceneId: string,
      isCancelled?: () => boolean,
    ): Promise<void> => {
      const proposal = await loadLatestProposedProse(targetSceneId);
      if (isCancelled?.() || !proposal) return;
      if (useInlineAiStore.getState().status !== "idle") return;
      if (
        isHeadlessAppliable(proposal) &&
        (await isAutoAcceptEnabled(getCurrentProjectId()))
      ) {
        let stale: boolean;
        try {
          stale = await isProposalStale(proposal);
        } catch (e) {
          // 判定不能は「非 stale = suppression 継続」に倒す。この proposal の
          // 所有者は headless drain/poller で、誤って enqueue すると適用済み
          // 内容の幽霊 diff (下の status 再読が防ぐレース) と同型事故になる。
          // 誤 suppress でも次回 mount / accept 後チェーンで再評価される。
          debugLog.warn(
            "proseStaging",
            "stale 判定に失敗 (suppress 継続)",
            errorDetail(e),
          );
          stale = false;
        }
        if (!stale) return;
      }
      if (isCancelled?.()) return;
      // 幽霊 diff レースの防止: 上の suppression 判定 (IPC await) の間に
      // drain/poller が適用済みにしている可能性がある。enqueue 直前に DB を
      // 再読し、同一 stagingId がまだ最新 proposed 行のときだけ乗せる
      // (loadLatestProposedProse は status='proposed' のみ返す)。stagingId が
      // 入れ替わっていた場合も乗せない — 新しい行の suppression / stale 判定
      // はまだしていないので、次の mount / チェーンが改めて判定して拾う。
      // レース窓はこの再読〜enqueue の同期区間まで縮み、残余は accept 側の
      // not-in-proposed backstop (acceptWithStaging) が拾う。
      const fresh = await loadLatestProposedProse(targetSceneId);
      if (isCancelled?.() || !fresh || fresh.stagingId !== proposal.stagingId) {
        return;
      }
      enqueue(fresh);
    },
    [enqueue],
  );

  useEffect(() => {
    if (!sceneId) return;
    let cancelled = false;
    void surfaceLatestProposal(sceneId, () => cancelled).catch((e) => {
      // reject を握って unhandled rejection を防ぐ。取りこぼしても次回
      // mount / accept 後チェーンで再ロードされる。
      debugLog.warn("proseStaging", "proposal 再ロードに失敗", errorDetail(e));
    });
    return () => {
      cancelled = true;
    };
  }, [sceneId, surfaceLatestProposal]);

  useEffect(() => {
    if (!editor || !sceneId || !pending || pending.sceneId !== sceneId) return;
    if (useInlineAiStore.getState().status !== "idle") return;

    const { stagingId, text, mode, replaceFrom, replaceTo } = pending;
    clearPending();

    if (mode === "replace" && replaceFrom != null && replaceTo != null) {
      diffApi.showProvidedText(text, {
        mode: "replace",
        stagingId,
        originalRange: { from: replaceFrom, to: replaceTo },
      });
      return;
    }

    const insertPos =
      mode === "insert"
        ? editor.state.selection.from
        : editor.state.doc.content.size;

    diffApi.showProvidedText(text, {
      mode: "insert",
      stagingId,
      insertPos,
    });
  }, [editor, sceneId, pending, clearPending, diffApi]);

  // 単一スロット pending は同一シーン複数 blocked のうち 1 件しか保持
  // できない。accept/reject 完了後に次の proposed 行をチェーンで surface し、
  // ユーザーが順に処理できるようにする (diffApi.accept / rejectOrAbort は
  // 同期で inline-AI store を idle に戻すため、直後に surface 判定できる)。
  const surfaceNextInChain = useCallback(() => {
    if (!sceneId) return;
    const targetSceneId = sceneId;
    void (async () => {
      // accept/reject で編集された doc を dirty-gated flush (saveScene) で
      // 先に永続化してから次行を出す。accept は autosave を arm するだけで
      // 未保存のため、そのまま次行プレビュー (実テキストの history-less
      // 挿入) を doc に乗せると、armed タイマーの発火でプレビュー込み doc
      // が persist される (無帰属 AI テキストの焼き込み)。保存を確定させて
      // 「未保存の accept 内容とプレビューが同居する窓」自体を消す。
      // プレビュー表示後の残余タイマーは、エディタ側の「inline-AI 非 idle
      // 遷移で armed autosave を cancel する」effect が対で受け持つ。
      await saveScene(targetSceneId);
      await surfaceLatestProposal(targetSceneId);
    })().catch((e) => {
      debugLog.warn("proseStaging", "チェーン再ロードに失敗", errorDetail(e));
    });
  }, [sceneId, surfaceLatestProposal]);

  const acceptWithStaging = useCallback(async () => {
    const stagingId = diffApi.getActiveStagingId();
    if (stagingId) {
      try {
        await agentAcceptProseStage(stagingId);
      } catch (err) {
        if (isRowNotProposedError(err)) {
          // Backstop: 行は既に accept/discard 済み (典型は surface 判定レース
          // をすり抜けた「drain/poller が先に適用した行」の幽霊 diff)。適用
          // せずプレビューを破棄して張り付きを解き、次の行をチェーンで乗せる。
          console.warn(
            "[proseStaging] staging row already finalized; discarding stale diff",
            err,
          );
          toast.info(i18next.t("inlineAi.proposalAlreadyFinalized"));
          diffApi.rejectOrAbort();
          surfaceNextInChain();
          return;
        }
        console.warn("[proseStaging] accept finalize failed", err);
        return;
      }
    }
    diffApi.accept();
    if (stagingId) surfaceNextInChain();
  }, [diffApi, surfaceNextInChain]);

  const rejectWithStaging = useCallback(async () => {
    const stagingId = diffApi.getActiveStagingId();
    if (stagingId) {
      try {
        await agentDiscardProseStage(stagingId);
      } catch (err) {
        console.warn("[proseStaging] discard finalize failed", err);
      }
    }
    diffApi.rejectOrAbort();
    if (stagingId) surfaceNextInChain();
  }, [diffApi, surfaceNextInChain]);

  return { acceptWithStaging, rejectWithStaging };
}
