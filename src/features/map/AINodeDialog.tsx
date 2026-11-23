import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { debugLog, errorDetail } from "@/lib/debugLog";
import type { AiBranchSeedChipMeta } from "./aiBranchContext";

interface AIBranchDialogProps {
  boardId: string;
  spawnPosition: { x: number; y: number };
  seedNodeTitles: string[];
  /**
   * `seedNodeTitles` と同じ添字の、Codex 由来の情報（Codex 以外は undefined）。無ければ注記は出ない。
   * 注記は表示の補助で、AI に送るかどうかは送信の直前の判定だけが決める（DR-MP4-43）。
   */
  seedChipMeta?: readonly (AiBranchSeedChipMeta | undefined)[];
  /**
   * 「AI に送られない」Codex の id を DB で判定する。ダイアログを開いたとき（種の一覧が確定したとき）に
   * 1 回だけ呼ぶ。reject したら注記なし（ダイアログは普通に使える）。
   */
  resolveNotSentCodexIds?: (entryIds: string[]) => Promise<ReadonlySet<string>>;
  onConfirm: (
    prompt: string,
    count: 3 | 5 | 8,
    vsThreshold: number | null,
  ) => void;
  onCancel: () => void;
}

const COUNT_OPTIONS = [3, 5, 8] as const;

/**
 * 意外性 (Verbalized Sampling) ノブ。値=裾サンプリングのしきい値。
 * 標準=null は VS オフ (従来挙動、既定)。意外/大胆で分布の裾へ寄せる。
 */
const NOVELTY_OPTIONS: { key: string; value: number | null }[] = [
  { key: "noveltyStandard", value: null },
  { key: "noveltyNovel", value: 0.1 },
  { key: "noveltyBold", value: 0.05 },
];

export function AINodeDialog({
  seedNodeTitles,
  seedChipMeta,
  resolveNotSentCodexIds,
  onConfirm,
  onCancel,
}: AIBranchDialogProps) {
  const { t } = useTranslation();
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState<3 | 5 | 8>(5);
  // 既定は標準 (null) = VS オフ。既存挙動を変えずに opt-in させる。
  const [vsThreshold, setVsThreshold] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // 注記の判定（DB の読み）の対象は、同期の層で外れていない Codex の id。種の一覧が変わると key が変わる。
  const dbCheckKey = JSON.stringify([
    ...new Set(
      (seedChipMeta ?? []).flatMap((m) =>
        m?.codexEntryId && !m.notSentLocally ? [m.codexEntryId] : [],
      ),
    ),
  ]);
  const resolveRef = useRef(resolveNotSentCodexIds);
  useEffect(() => {
    resolveRef.current = resolveNotSentCodexIds;
  }, [resolveNotSentCodexIds]);
  // 結果は、判定した種の一覧の key と組で持つ。別の一覧の結果は使わない。
  const [dbNotSent, setDbNotSent] = useState<{
    key: string;
    ids: ReadonlySet<string>;
  } | null>(null);
  useEffect(() => {
    const ids = JSON.parse(dbCheckKey) as string[];
    if (ids.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const resolve = resolveRef.current;
        if (!resolve) return;
        const result = await resolve(ids);
        // 閉じた後・種の一覧が変わった後に返った古い結果は捨てる。
        if (!cancelled) setDbNotSent({ key: dbCheckKey, ids: result });
      } catch (error) {
        // 判定に失敗したら注記なし（画面には出さない）。送信の判定は別に効く。診断のため debugLog に残す。
        debugLog.warn(
          "codex-hidden",
          "AI Branch の注記の判定に失敗したので注記を出さない",
          errorDetail(error),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dbCheckKey]);
  const notSentIds = dbNotSent?.key === dbCheckKey ? dbNotSent.ids : null;

  // Escape でどこにフォーカスがあっても閉じられるようにする (WCAG 2.1.1)。
  // capture で先取りし、Map 側など後続の Escape 処理へ流さない。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, [onCancel]);

  const canSubmit = prompt.trim().length > 0;

  return createPortal(
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("map.aiBranch.label")}
        className="bg-popover border border-border rounded-lg shadow-xl"
        style={{ minWidth: 360, maxWidth: 520, padding: 24 }}
      >
        <div
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: "var(--foreground)",
            marginBottom: 16,
          }}
        >
          {t("map.aiBranch.label")}
        </div>

        {seedNodeTitles.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div
              style={{
                fontSize: 11,
                color: "var(--muted-foreground)",
                marginBottom: 4,
              }}
            >
              {t("map.aiNodeDialog.context")}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {seedNodeTitles.map((title, i) => {
                const meta = seedChipMeta?.[i];
                const notSent =
                  !!meta?.codexEntryId &&
                  (!!meta.notSentLocally ||
                    !!notSentIds?.has(meta.codexEntryId));
                return (
                  <span
                    key={i}
                    style={{
                      fontSize: 11,
                      padding: "2px 8px",
                      borderRadius: 12,
                      background: "var(--accent)",
                      color: "var(--accent-foreground)",
                    }}
                  >
                    {title}
                    {notSent && (
                      <span
                        data-testid="ai-branch-chip-not-sent"
                        style={{ marginLeft: 6, opacity: 0.7 }}
                      >
                        {/* 読み上げで題と注記が続かないよう、視覚には出ない区切りを置く。 */}
                        <span className="sr-only">{", "}</span>
                        {t("map.aiNodeDialog.notSentToAi")}
                      </span>
                    )}
                  </span>
                );
              })}
            </div>
          </div>
        )}

        <div style={{ marginBottom: 14 }}>
          <div
            style={{
              fontSize: 11,
              color: "var(--muted-foreground)",
              marginBottom: 4,
            }}
          >
            {t("map.aiNodeDialog.prompt")}
          </div>
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t("map.aiNodeDialog.promptPlaceholder")}
            onKeyDown={(e) => {
              // IME 変換キャンセルの Escape でダイアログを閉じない
              if (e.key === "Escape" && !e.nativeEvent.isComposing) onCancel();
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSubmit) {
                onConfirm(prompt.trim(), count, vsThreshold);
              }
            }}
            style={{
              width: "100%",
              minHeight: 80,
              resize: "vertical",
              padding: "8px 10px",
              fontSize: 13,
              borderRadius: 5,
              border: "1px solid var(--border)",
              background: "var(--background)",
              color: "var(--foreground)",
              boxSizing: "border-box",
              outline: "none",
              fontFamily: "inherit",
            }}
          />
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 12,
          }}
        >
          <span style={{ fontSize: 11, color: "var(--muted-foreground)" }}>
            {t("map.aiNodeDialog.generateCount")}
          </span>
          {COUNT_OPTIONS.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setCount(n)}
              style={{
                padding: "3px 12px",
                fontSize: 12,
                borderRadius: 4,
                border: "1px solid",
                borderColor: count === n ? "#534AB7" : "var(--border)",
                background: count === n ? "#534AB7" : "var(--secondary)",
                color: count === n ? "#fff" : "var(--secondary-foreground)",
                cursor: "pointer",
                fontWeight: count === n ? 600 : 400,
              }}
            >
              {n}
            </button>
          ))}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 20,
          }}
        >
          <span style={{ fontSize: 11, color: "var(--muted-foreground)" }}>
            {t("map.aiNodeDialog.novelty")}
          </span>
          {NOVELTY_OPTIONS.map((opt) => {
            const active = vsThreshold === opt.value;
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => setVsThreshold(opt.value)}
                style={{
                  padding: "3px 12px",
                  fontSize: 12,
                  borderRadius: 4,
                  border: "1px solid",
                  borderColor: active ? "#534AB7" : "var(--border)",
                  background: active ? "#534AB7" : "var(--secondary)",
                  color: active ? "#fff" : "var(--secondary-foreground)",
                  cursor: "pointer",
                  fontWeight: active ? 600 : 400,
                }}
              >
                {t(`map.aiNodeDialog.${opt.key}`)}
              </button>
            );
          })}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: "5px 16px",
              fontSize: 13,
              borderRadius: 5,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--foreground)",
              cursor: "pointer",
            }}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() =>
              canSubmit && onConfirm(prompt.trim(), count, vsThreshold)
            }
            style={{
              padding: "5px 16px",
              fontSize: 13,
              borderRadius: 5,
              border: "none",
              background: canSubmit ? "#534AB7" : "var(--muted)",
              color: canSubmit ? "#fff" : "var(--muted-foreground)",
              cursor: canSubmit ? "pointer" : "not-allowed",
              fontWeight: 600,
            }}
          >
            {t("map.aiNodeDialog.generate")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
