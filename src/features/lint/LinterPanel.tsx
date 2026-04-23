import { useCallback } from "react";
import { AlertCircle, AlertTriangle, Info, Wrench } from "lucide-react";

import { useEditorStore } from "@/features/editor/editorStore";
import { buildOffsetMap, strOffsetToPmPos } from "@/features/editor/offsetMap";
import type { Diagnostic, Severity } from "./types";
import { useLintStore } from "./lintStore";
import { runLintNow } from "./useLinter";

function SeverityIcon({ severity }: { severity: Severity }) {
  switch (severity) {
    case "error":
      return (
        <AlertCircle className="h-4 w-4 text-red-500" aria-label="error" />
      );
    case "warning":
      return (
        <AlertTriangle
          className="h-4 w-4 text-amber-500"
          aria-label="warning"
        />
      );
    case "info":
      return <Info className="h-4 w-4 text-blue-500" aria-label="info" />;
  }
}

/**
 * Phase 1a Linter panel.
 *
 * Flat list of diagnostics for the current scene. Clicking an entry jumps
 * the editor caret to the diagnostic's range; clicking the Fix button
 * applies the rule's suggested replacement (when present).
 */
export function LinterPanel() {
  const editor = useEditorStore((s) => s.editor);
  const diagnostics = useLintStore((s) => s.diagnostics);
  const isLinting = useLintStore((s) => s.isLinting);
  const lastErrorMessage = useLintStore((s) => s.lastErrorMessage);

  const jumpTo = useCallback(
    (d: Diagnostic) => {
      if (!editor) return;
      const map = buildOffsetMap(editor.state.doc);
      const from = strOffsetToPmPos(map, d.range.start);
      const to = strOffsetToPmPos(map, d.range.end);
      if (from == null || to == null) return;
      editor
        .chain()
        .focus()
        .setTextSelection({ from, to })
        .scrollIntoView()
        .run();
    },
    [editor],
  );

  const currentSceneId = useLintStore((s) => s.currentSceneId);
  const applyFix = useCallback(
    (d: Diagnostic) => {
      if (!editor || !d.fix) return;
      const map = buildOffsetMap(editor.state.doc);
      const from = strOffsetToPmPos(map, d.fix.range.start);
      const to = strOffsetToPmPos(map, d.fix.range.end);
      if (from == null || to == null) return;
      editor
        .chain()
        .focus()
        .insertContentAt({ from, to }, d.fix.replacement)
        .run();
      // Bypass the 500ms debounce so stale diagnostics disappear
      // immediately (design: "Fix 適用時は debounce バイパス").
      if (currentSceneId) {
        void runLintNow(editor, currentSceneId);
      }
    },
    [editor, currentSceneId],
  );

  if (lastErrorMessage) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
        <AlertCircle className="h-5 w-5 text-red-500" />
        <p>Linter が一時的に利用できません</p>
        <p className="text-xs">{lastErrorMessage}</p>
      </div>
    );
  }

  if (diagnostics.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
        {isLinting ? <p>Lint 実行中...</p> : <p>問題は見つかりませんでした</p>}
      </div>
    );
  }

  return (
    <div
      className="flex h-full flex-col overflow-y-auto"
      data-testid="lint-panel"
    >
      <ul className="flex flex-col divide-y divide-border">
        {diagnostics.map((d, idx) => (
          <li
            key={`${d.rule_id}-${d.range.start}-${d.range.end}-${idx}`}
            className="flex items-start gap-2 px-3 py-2 hover:bg-accent/40"
          >
            <button
              type="button"
              className="flex flex-1 items-start gap-2 text-left"
              onClick={() => jumpTo(d)}
            >
              <span className="mt-0.5 shrink-0">
                <SeverityIcon severity={d.severity} />
              </span>
              <div className="flex flex-col gap-0.5">
                <span className="text-sm">{d.message}</span>
                <span className="text-xs text-muted-foreground">
                  {d.rule_id}
                </span>
              </div>
            </button>
            {d.fix && (
              <button
                type="button"
                title={d.fix.label}
                onClick={() => applyFix(d)}
                className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Wrench className="h-3.5 w-3.5" />
                Fix
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
