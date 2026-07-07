import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { getCurrentProjectLanguage } from "@/features/project/projectStore";
import type { ReorderGranularity, ReorderUnit } from "./types";
import { resolveParagraphAtSelection } from "./paragraphFlat";
import { resolveUnitsForParagraph } from "./unitResolver";
import { buildParagraphReorderTransaction } from "./reorderTransaction";
import { clearBunsetsuCache, fetchBunsetsuUnits } from "./bunsetsuSegmenter";
import { resolveSelectionUnits } from "./selectionUnit";

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

  const reloadUnits = useCallback(
    async (granularityOverride?: ReorderGranularity) => {
      if (!editor) return;
      const g = granularityOverride ?? granularity;
      const language = getCurrentProjectLanguage();
      const ctx = resolveSelectionUnits(editor.state, "sentence", language);
      if (!ctx) {
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
          const fetched = await fetchBunsetsuUnits(ctx.resolved.flat.text);
          nextUnits = resolveUnitsForParagraph(
            editor.state,
            "bunsetsu",
            language,
            fetched,
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
          resolved: ctx.resolved,
          units: nextUnits,
          caretFlatOffset: ctx.caretFlatOffset,
        };
        setUnits(nextUnits);
        setOrder(nextUnits.map((_, i) => i));
      } catch {
        if (g === "bunsetsu") {
          const fallback = resolveUnitsForParagraph(
            editor.state,
            "sentence",
            language,
          );
          if (fallback && fallback.length > 1) {
            ctxRef.current = {
              resolved: ctx.resolved,
              units: fallback,
              caretFlatOffset: ctx.caretFlatOffset,
            };
            setUnits(fallback);
            setOrder(fallback.map((_, i) => i));
            setErrorMessage("bunsetsuFallback");
          } else {
            setErrorMessage("segmentFailed");
          }
        } else {
          setErrorMessage("reorder.segmentFailed");
        }
      } finally {
        setLoading(false);
      }
    },
    [editor, granularity],
  );

  const openOverlay = useCallback(() => {
    if (!editor || readOnly) return;
    setOpen(true);
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
    const identity = u.map((_, i) => i);
    const changed = order.some((v, i) => v !== identity[i]);
    if (changed) {
      const result = buildParagraphReorderTransaction(
        editor.state,
        resolved,
        u,
        order,
        caretFlatOffset,
      );
      if (result) editor.view.dispatch(result.tr);
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
