import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { getCurrentProjectLanguage } from "@/features/project/projectStore";
import type { ReorderGranularity, ReorderUnit } from "./types";
import { resolveParagraphAtSelection } from "./paragraphFlat";
import { resolveUnitsForParagraph } from "./unitResolver";
import { buildParagraphReorderTransaction } from "./reorderTransaction";
import { clearBunsetsuCache, fetchBunsetsuUnits } from "./bunsetsuSegmenter";
import { resolveParagraphSelectionContext } from "./selectionUnit";
import { revalidateParagraphContext } from "./paragraphSnapshot";

export interface ParagraphReorderContext {
  resolved: NonNullable<ReturnType<typeof resolveParagraphAtSelection>>;
  units: ReorderUnit[];
  caretFlatOffset: number;
}

export function useParagraphReorderOverlay(
  editor: Editor | null,
  readOnly: boolean,
) {
  const [open, setOpen] = useState(false);
  const [granularity, setGranularityState] =
    useState<ReorderGranularity>("sentence");
  const [order, setOrder] = useState<number[]>([]);
  const [units, setUnits] = useState<ReorderUnit[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const ctxRef = useRef<ParagraphReorderContext | null>(null);
  // reloadUnits の呼び出しごとに採番する ID。await 完了時に最新でなければ
  // 結果を破棄し、古い async 結果が新しい同期結果を上書きするのを防ぐ。
  const requestIdRef = useRef(0);

  const reloadUnits = useCallback(
    async (granularityOverride?: ReorderGranularity) => {
      if (!editor) return;
      const requestId = ++requestIdRef.current;
      const isStaleRequest = () => requestId !== requestIdRef.current;
      const g = granularityOverride ?? granularity;
      const language = getCurrentProjectLanguage();
      const paragraphCtx = resolveParagraphSelectionContext(editor.state);
      if (!paragraphCtx) {
        setErrorMessage("singleUnit");
        setUnits([]);
        setOrder([]);
        ctxRef.current = null;
        return;
      }

      setLoading(true);
      setErrorMessage(null);
      try {
        let nextUnits: ReorderUnit[] | null = null;
        if (g === "bunsetsu") {
          clearBunsetsuCache();
          const fetched = await fetchBunsetsuUnits(
            paragraphCtx.resolved.flat.text,
          );
          // より新しい reloadUnits が走っていたら、この結果は捨てる。
          if (isStaleRequest()) return;
          // await 中に段落が編集された場合、fetched は旧テキスト向けの unit
          // なので現在の doc に適用してはいけない（stale fetch 結果の取り込み防止）。
          if (
            !revalidateParagraphContext(editor.state, paragraphCtx.resolved)
          ) {
            setErrorMessage("staleDocument");
            setUnits([]);
            setOrder([]);
            ctxRef.current = null;
            return;
          }
          nextUnits = resolveUnitsForParagraph(
            editor.state,
            "bunsetsu",
            language,
            fetched,
          );
        } else if (g === "phrase") {
          nextUnits = resolveUnitsForParagraph(
            editor.state,
            "phrase",
            language,
          );
        } else if (g === "word") {
          nextUnits = resolveUnitsForParagraph(editor.state, "word", language);
        } else if (g === "character") {
          nextUnits = resolveUnitsForParagraph(
            editor.state,
            "character",
            language,
          );
        } else {
          nextUnits = resolveUnitsForParagraph(
            editor.state,
            "sentence",
            language,
          );
        }

        if (!nextUnits || nextUnits.length <= 1) {
          setErrorMessage("singleUnit");
          setUnits(nextUnits ?? []);
          setOrder([]);
          ctxRef.current = null;
          return;
        }

        ctxRef.current = {
          resolved: paragraphCtx.resolved,
          units: nextUnits,
          caretFlatOffset: paragraphCtx.caretFlatOffset,
        };
        setUnits(nextUnits);
        setOrder(nextUnits.map((_, i) => i));
      } catch {
        if (isStaleRequest()) return;
        if (!revalidateParagraphContext(editor.state, paragraphCtx.resolved)) {
          setErrorMessage("staleDocument");
          setUnits([]);
          setOrder([]);
          ctxRef.current = null;
          return;
        }
        if (g === "bunsetsu") {
          const fallback = resolveUnitsForParagraph(
            editor.state,
            "sentence",
            language,
          );
          if (fallback && fallback.length > 1) {
            ctxRef.current = {
              resolved: paragraphCtx.resolved,
              units: fallback,
              caretFlatOffset: paragraphCtx.caretFlatOffset,
            };
            setUnits(fallback);
            setOrder(fallback.map((_, i) => i));
            setErrorMessage("bunsetsuFallback");
          } else {
            setErrorMessage("segmentFailed");
          }
        } else {
          setErrorMessage("segmentFailed");
        }
      } finally {
        // 最新リクエストのみ loading を解除する（古いリクエストが
        // 進行中の新リクエストの loading 状態を消さないように）。
        if (!isStaleRequest()) setLoading(false);
      }
    },
    [editor, granularity],
  );

  const openOverlay = useCallback(() => {
    if (!editor || readOnly) return;
    setOpen(true);
    setGranularityState("sentence");
    editor.commands.setReorderGranularity("sentence");
    void reloadUnits("sentence");
  }, [editor, readOnly, reloadUnits]);

  const closeOverlay = useCallback(() => {
    setOpen(false);
    setErrorMessage(null);
    ctxRef.current = null;
  }, []);

  const toggleOverlay = useCallback(() => {
    if (open) closeOverlay();
    else openOverlay();
  }, [open, closeOverlay, openOverlay]);

  const setGranularity = useCallback(
    (g: ReorderGranularity) => {
      setGranularityState(g);
      editor?.commands.setReorderGranularity(g);
      if (open) void reloadUnits(g);
    },
    [editor, open, reloadUnits],
  );

  const confirm = useCallback(() => {
    if (!editor || !ctxRef.current || order.length <= 1) return;
    const { resolved, units: u, caretFlatOffset } = ctxRef.current;
    const fresh = revalidateParagraphContext(editor.state, resolved);
    if (!fresh) {
      setErrorMessage("staleDocument");
      return;
    }
    const identity = u.map((_, i) => i);
    const changed = order.some((v, i) => v !== identity[i]);
    if (changed) {
      const result = buildParagraphReorderTransaction(
        editor.state,
        fresh,
        u,
        order,
        caretFlatOffset,
        undefined,
        undefined,
        getCurrentProjectLanguage(),
        granularity,
      );
      if (!result) {
        setErrorMessage("staleDocument");
        return;
      }
      editor.view.dispatch(result.tr);
    }
    closeOverlay();
  }, [editor, order, closeOverlay]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeOverlay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closeOverlay]);

  return {
    open,
    openOverlay,
    closeOverlay,
    toggleOverlay,
    granularity,
    setGranularity,
    order,
    setOrder,
    units,
    loading,
    errorMessage,
    confirm,
    canConfirm: order.length > 1 && !loading,
  };
}
