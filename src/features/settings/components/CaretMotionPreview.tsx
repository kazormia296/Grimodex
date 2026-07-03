import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimatedPopover } from "@/components/ui/animated-popover";
import { Button } from "@/components/ui/button";
import { useSettingNumber } from "../useSettingControl";
import {
  CARET_SLIDE_DURATION_DEFAULT,
  CARET_SLIDE_SNAPPINESS_DEFAULT,
  applyCaretSlideVars,
} from "@/features/editor/caretSlideStyle";

const SAMPLE = "吾輩は猫である。名前はまだ無い。";
/** 自動再生の歩進間隔。スライド(<=200ms)が完了してから次へ進む値にする。 */
const AUTO_ADVANCE_MS = 400;

/**
 * スムースキャレット設定（duration / snappiness）のサンドボックス。
 * サンプル文の上を疑似キャレットが自動で 1 文字ずつ進み、文字クリックで
 * 任意位置へジャンプする。疑似キャレット (.caret-preview-caret) は
 * エディタ本体と同じ CSS 変数 (--caret-slide-*) を参照するため、
 * スライダーの変更がポップオーバーを開いたままリアルタイムに反映される。
 * 大ジャンプ時のスナップ（行送り 1.5 倍しきい値）も CursorOverlayPlugin と
 * 同じ規則を再現する。
 */
export function CaretMotionPreview({
  disabled = false,
}: {
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { value: duration } = useSettingNumber(
    "editor.caretSlideDuration",
    CARET_SLIDE_DURATION_DEFAULT,
  );
  const { value: snappiness } = useSettingNumber(
    "editor.caretSlideSnappiness",
    CARET_SLIDE_SNAPPINESS_DEFAULT,
  );

  // 通常は useCursorOverlay (エディタ側) が CSS 変数を書くが、エディタが
  // 1 枚もマウントされていない状態 (シーン未オープン等) でも設定変更が
  // プレビューへリアルタイム反映されるよう、ここでも冪等に書く。
  useEffect(() => {
    if (!open) return;
    applyCaretSlideVars(duration, snappiness);
  }, [open, duration, snappiness]);
  const [index, setIndex] = useState(0);
  // 手動操作 (クリック / 矢印キー) したら自動再生を止め、ユーザーに主導権を渡す。
  const [paused, setPaused] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);
  const charRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const caretRef = useRef<HTMLDivElement>(null);
  const prevPosRef = useRef<{ left: number; top: number } | null>(null);

  // 開くたびに初期状態へ戻し、矢印キーがすぐ効くようサンドボックスへフォーカス。
  useEffect(() => {
    if (!open) return;
    setIndex(0);
    setPaused(false);
    textRef.current?.focus({ preventScroll: true });
  }, [open]);

  // 自動再生: 開いている間、手動操作されるまで 1 文字ずつ進む（末尾で折り返し）。
  useEffect(() => {
    if (!open || paused) return;
    const id = setInterval(
      () => setIndex((i) => (i + 1) % SAMPLE.length),
      AUTO_ADVANCE_MS,
    );
    return () => clearInterval(id);
  }, [open, paused]);

  // index → 疑似キャレットの座標反映。エディタ同様、移動距離が行高の
  // 1.5 倍を超えるとき（折り返し・クリックジャンプ）は snap。
  useEffect(() => {
    if (!open) {
      prevPosRef.current = null;
      return;
    }
    const span = charRefs.current[index];
    const box = textRef.current;
    const caret = caretRef.current;
    if (!span || !box || !caret) return;
    const s = span.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const left = s.left - b.left;
    const top = s.top - b.top;
    const height = s.height || 20;
    const prev = prevPosRef.current;
    const snap =
      prev === null ||
      Math.hypot(left - prev.left, top - prev.top) > height * 1.5;
    caret.classList.toggle("no-transition", snap);
    caret.style.left = `${left}px`;
    caret.style.top = `${top}px`;
    caret.style.height = `${height}px`;
    prevPosRef.current = { left, top };
  }, [open, index]);

  return (
    <div className="relative">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {t("settings.editor.caretMotionPreviewOpen")}
      </Button>
      {/* containerRef を渡さない = 外側クリックで閉じない。プレビューを
          見ながら外のスライダーを弄れるよう、閉じるのは明示ボタンと Esc のみ。 */}
      <AnimatedPopover
        open={open}
        onClose={() => setOpen(false)}
        className="absolute right-0 top-full z-50 mt-2 w-80 rounded-lg border border-border bg-popover p-4 shadow-lg"
      >
        <div className="mb-2 flex items-start justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {t("settings.editor.caretMotionPreviewDesc")}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={() => setOpen(false)}
          >
            {t("common.close")}
          </Button>
        </div>
        {/* クリックは委譲、キーボードは ←/→/Home/End で移動 (a11y:
            文字ごとの tab stop を作らずコンテナ 1 つで操作できるようにする) */}
        <div
          ref={textRef}
          data-caret-index={index}
          role="group"
          aria-label={t("settings.editor.caretMotionPreviewDesc")}
          tabIndex={0}
          onClick={(e) => {
            const char = (e.target as HTMLElement).closest(
              "[data-preview-char]",
            );
            if (!char) return;
            setPaused(true);
            setIndex(Number((char as HTMLElement).dataset.previewChar));
          }}
          onKeyDown={(e) => {
            const last = SAMPLE.length - 1;
            if (e.key === "ArrowRight") {
              setIndex((i) => Math.min(last, i + 1));
            } else if (e.key === "ArrowLeft") {
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === "Home") {
              setIndex(0);
            } else if (e.key === "End") {
              setIndex(last);
            } else {
              return;
            }
            setPaused(true);
            e.preventDefault();
          }}
          className="relative cursor-pointer select-none rounded-md bg-content-background px-3 py-2 leading-8 text-content-foreground-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        >
          {SAMPLE.split("").map((ch, i) => (
            <span
              key={i}
              data-preview-char={i}
              ref={(el) => {
                charRefs.current[i] = el;
              }}
            >
              {ch}
            </span>
          ))}
          <div ref={caretRef} className="caret-preview-caret" />
        </div>
      </AnimatedPopover>
    </div>
  );
}
