import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Info, XCircle } from "lucide-react";
import type { Editor } from "@tiptap/react";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { useLintStore } from "./lintStore";
import { applyLintFix } from "./lintActions";
import type { Diagnostic, Severity } from "./types";

interface Props {
  editor: Editor | null;
  containerRef: React.RefObject<HTMLElement | null>;
  sceneId: string | null;
}

interface Target {
  rule: string;
  severity: Severity;
  message: string;
  x: number;
  y: number;
}

const SEVERITY_ICONS: Record<Severity, React.ReactNode> = {
  error: <XCircle size={13} className="shrink-0 text-destructive" />,
  warning: <AlertTriangle size={13} className="shrink-0 text-yellow-500" />,
  info: <Info size={13} className="shrink-0 text-blue-400" />,
};

/**
 * Lint 波線 (.lint-deco) のホバーポップオーバー。ルール名 + メッセージを
 * 表示し、対応する診断が一意に特定できて Fix を持つ場合は適用ボタンを出す。
 * メッセージは decoration の data-lint-message から読む（位置照合不要）。
 */
export function LintHoverPopover({ editor, containerRef, sceneId }: Props) {
  const { t } = useTranslation();
  const showLint = useCursorSettingsStore((s) => s.showLint);
  const diagnostics = useLintStore((s) => s.diagnostics);
  const [target, setTarget] = useState<Target | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHideTimer = useCallback(() => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const scheduleHide = useCallback(() => {
    clearHideTimer();
    hideTimer.current = setTimeout(() => setTarget(null), 200);
  }, [clearHideTimer]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !showLint) return;

    function onMouseOver(e: MouseEvent) {
      const el = (e.target as Element).closest(
        ".lint-deco",
      ) as HTMLElement | null;
      if (!el) {
        scheduleHide();
        return;
      }
      clearHideTimer();
      const rect = el.getBoundingClientRect();
      setTarget({
        rule: el.getAttribute("data-lint-rule") ?? "",
        severity: (el.getAttribute("data-lint-severity") ??
          "warning") as Severity,
        message: el.getAttribute("data-lint-message") ?? "",
        x: rect.left,
        y: rect.bottom + 6,
      });
    }

    container.addEventListener("mouseover", onMouseOver);
    return () => container.removeEventListener("mouseover", onMouseOver);
  }, [containerRef, showLint, scheduleHide, clearHideTimer]);

  useEffect(() => {
    if (!showLint) setTarget(null);
  }, [showLint]);

  if (!target) return null;

  // Fix 適用は診断オブジェクトが必要 — rule_id + message の一意一致でだけ出す
  // （同文言の診断が複数ある場合はどの範囲か曖昧になるため出さない）。
  const matches: Diagnostic[] = diagnostics.filter(
    (d) => d.rule_id === target.rule && d.message === target.message,
  );
  const fixable = matches.length === 1 && matches[0].fix ? matches[0] : null;

  const width = 300;
  const x = Math.min(target.x, window.innerWidth - width - 8);
  const y = Math.min(target.y, window.innerHeight - 160);

  return createPortal(
    <div
      role="dialog"
      aria-label={t("settings.linter.proofreading")}
      className="fixed z-50 rounded-md border border-border bg-popover p-3 shadow-md"
      style={{ left: x, top: y, width }}
      onMouseEnter={clearHideTimer}
      onMouseLeave={scheduleHide}
      data-testid="lint-hover-popover"
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        {SEVERITY_ICONS[target.severity]}
        <span className="font-mono text-[10px] text-muted-foreground">
          {target.rule}
        </span>
      </div>
      <p className="text-sm leading-snug text-popover-foreground">
        {target.message}
      </p>
      {fixable && editor && (
        <button
          type="button"
          className="mt-2 rounded border border-border px-2 py-1 text-xs hover:bg-accent"
          onClick={() => {
            applyLintFix(editor, sceneId, fixable);
            setTarget(null);
          }}
        >
          {fixable.fix?.label}
        </button>
      )}
    </div>,
    document.body,
  );
}
