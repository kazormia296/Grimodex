import { useCallback, useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Info,
  Search,
  Wrench,
  X,
} from "lucide-react";

import { useEditorStore } from "@/features/editor/editorStore";
import { buildOffsetMap, strOffsetToPmPos } from "@/features/editor/offsetMap";
import type { Diagnostic, RuleWarning, Severity } from "./types";
import { useLintStore } from "./lintStore";
import { runLintNow } from "./useLinter";

type GroupMode = "severity" | "none";

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
 * Build a "{前} {Diagnostic span} {後}" excerpt from the scene text.
 * Short spans get ±10 chars context; spans longer than 60 chars are
 * rendered as "前半30 … 後半30" without surrounding context.
 */
function extractExcerpt(
  sceneText: string,
  d: Diagnostic,
): { before: string; hit: string; after: string } {
  const start = Math.max(0, Math.min(d.range.start, sceneText.length));
  const end = Math.max(start, Math.min(d.range.end, sceneText.length));
  const hit = sceneText.slice(start, end);
  if (hit.length > 60) {
    const first = hit.slice(0, 30);
    const last = hit.slice(-30);
    return {
      before: "",
      hit: `${first}…${last}`,
      after: "",
    };
  }
  const CTX = 10;
  const beforeStart = Math.max(0, start - CTX);
  const afterEnd = Math.min(sceneText.length, end + CTX);
  const before = sceneText.slice(beforeStart, start);
  const after = sceneText.slice(end, afterEnd);
  return { before, hit, after };
}

interface SeverityFilter {
  error: boolean;
  warning: boolean;
  info: boolean;
}

function WarningsBadge({ warnings }: { warnings: RuleWarning[] }) {
  const [open, setOpen] = useState(false);
  if (warnings.length === 0) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Linter の警告を表示"
        className="flex h-6 items-center gap-1 rounded border border-amber-500/50 px-1.5 text-xs text-amber-600 hover:bg-amber-500/10"
      >
        <AlertTriangle className="h-3.5 w-3.5" />
        {warnings.length}
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setOpen(false)}
        >
          <div
            className="max-h-[60vh] w-[min(520px,90vw)] overflow-y-auto rounded border border-border bg-background p-4 text-sm shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-semibold">Linter warnings</h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded p-1 hover:bg-accent"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <ul className="space-y-1.5 font-mono text-xs">
              {warnings.map((w, i) => (
                <li key={i}>
                  <span className="text-muted-foreground">[{w.kind}]</span>{" "}
                  <span className="font-semibold">{w.rule_id}</span>:{" "}
                  {w.message}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}

function SeverityChip({
  label,
  active,
  count,
  colorClass,
  onToggle,
}: {
  label: string;
  active: boolean;
  count: number;
  colorClass: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`flex h-6 items-center gap-1 rounded border px-1.5 text-xs transition-colors ${
        active
          ? `${colorClass} border-current`
          : "border-border text-muted-foreground hover:bg-accent"
      }`}
    >
      {label} {count}
    </button>
  );
}

/**
 * Phase 1a + 1b Linter panel.
 *
 * - Severity フィルタ (Error / Warning / Info)
 * - Group by Severity / None
 * - 検索ボックス (rule_id + message 部分一致)
 * - 60 文字超の Diagnostic 抜粋は「前半30…後半30」形式
 * - RuleWarning はヘッダーのバッジ+モーダルで可視化
 */
export function LinterPanel() {
  const editor = useEditorStore((s) => s.editor);
  const diagnostics = useLintStore((s) => s.diagnostics);
  const warnings = useLintStore((s) => s.warnings);
  const isLinting = useLintStore((s) => s.isLinting);
  const lastErrorMessage = useLintStore((s) => s.lastErrorMessage);
  const currentSceneId = useLintStore((s) => s.currentSceneId);

  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>({
    error: true,
    warning: true,
    info: true,
  });
  const [groupMode, setGroupMode] = useState<GroupMode>("severity");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const counts = useMemo(() => {
    const c = { error: 0, warning: 0, info: 0 };
    for (const d of diagnostics) c[d.severity] += 1;
    return c;
  }, [diagnostics]);

  // Pre-compute scene text once per diagnostics update for excerpt
  // rendering. Editor content is live, so we read from editor.state.doc
  // via offsetMap.
  const sceneText = useMemo(() => {
    if (!editor) return "";
    const map = buildOffsetMap(editor.state.doc);
    // Concatenate block texts with the "\n" separator used by the map.
    return map.blocks.map((b) => b.text).join("\n");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, diagnostics]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return diagnostics.filter((d) => {
      if (!severityFilter[d.severity]) return false;
      if (q.length > 0) {
        const hay = `${d.rule_id} ${d.message}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [diagnostics, severityFilter, query]);

  const grouped = useMemo(() => {
    if (groupMode === "none") {
      return [{ key: "all", label: null as string | null, items: filtered }];
    }
    const order: Severity[] = ["error", "warning", "info"];
    const buckets: Record<Severity, Diagnostic[]> = {
      error: [],
      warning: [],
      info: [],
    };
    for (const d of filtered) buckets[d.severity].push(d);
    const labels: Record<Severity, string> = {
      error: "Error",
      warning: "Warning",
      info: "Info",
    };
    return order
      .filter((s) => buckets[s].length > 0)
      .map((s) => ({
        key: s,
        label: `${labels[s]} (${buckets[s].length})`,
        items: buckets[s],
      }));
  }, [filtered, groupMode]);

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
      if (currentSceneId) {
        void runLintNow(editor, currentSceneId);
      }
    },
    [editor, currentSceneId],
  );

  // ── Render ──

  if (lastErrorMessage) {
    return (
      <div className="flex h-full flex-col">
        <PanelHeader
          counts={counts}
          severityFilter={severityFilter}
          setSeverityFilter={setSeverityFilter}
          groupMode={groupMode}
          setGroupMode={setGroupMode}
          query={query}
          setQuery={setQuery}
          warnings={warnings}
        />
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
          <AlertCircle className="h-5 w-5 text-red-500" />
          <p>Linter が一時的に利用できません</p>
          <p className="text-xs">{lastErrorMessage}</p>
        </div>
      </div>
    );
  }

  if (diagnostics.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <PanelHeader
          counts={counts}
          severityFilter={severityFilter}
          setSeverityFilter={setSeverityFilter}
          groupMode={groupMode}
          setGroupMode={setGroupMode}
          query={query}
          setQuery={setQuery}
          warnings={warnings}
        />
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
          {isLinting ? (
            <p>Lint 実行中...</p>
          ) : (
            <p>問題は見つかりませんでした</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid="lint-panel">
      <PanelHeader
        counts={counts}
        severityFilter={severityFilter}
        setSeverityFilter={setSeverityFilter}
        groupMode={groupMode}
        setGroupMode={setGroupMode}
        query={query}
        setQuery={setQuery}
        warnings={warnings}
      />
      <div className="flex-1 overflow-y-auto">
        {grouped.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            該当する項目はありません
          </p>
        ) : (
          grouped.map((group) => {
            const isCollapsed = collapsed[group.key] ?? false;
            return (
              <div key={group.key}>
                {group.label && (
                  <button
                    type="button"
                    onClick={() =>
                      setCollapsed((prev) => ({
                        ...prev,
                        [group.key]: !isCollapsed,
                      }))
                    }
                    className="flex w-full items-center gap-1 border-b border-border bg-muted/50 px-2 py-1 text-left text-xs font-semibold hover:bg-accent/50"
                  >
                    {isCollapsed ? (
                      <ChevronRight className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5" />
                    )}
                    {group.label}
                  </button>
                )}
                {!isCollapsed && (
                  <ul className="flex flex-col divide-y divide-border">
                    {group.items.map((d, idx) => (
                      <DiagnosticRow
                        key={`${d.rule_id}-${d.range.start}-${d.range.end}-${idx}`}
                        d={d}
                        sceneText={sceneText}
                        onJump={jumpTo}
                        onFix={applyFix}
                      />
                    ))}
                  </ul>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function PanelHeader(props: {
  counts: { error: number; warning: number; info: number };
  severityFilter: SeverityFilter;
  setSeverityFilter: (s: SeverityFilter) => void;
  groupMode: GroupMode;
  setGroupMode: (g: GroupMode) => void;
  query: string;
  setQuery: (q: string) => void;
  warnings: RuleWarning[];
}) {
  const {
    counts,
    severityFilter,
    setSeverityFilter,
    groupMode,
    setGroupMode,
    query,
    setQuery,
    warnings,
  } = props;
  return (
    <div className="flex flex-col gap-1 border-b border-border bg-muted/30 px-2 py-1.5">
      <div className="flex items-center gap-2">
        <SeverityChip
          label="🔴"
          active={severityFilter.error}
          count={counts.error}
          colorClass="text-red-600"
          onToggle={() =>
            setSeverityFilter({
              ...severityFilter,
              error: !severityFilter.error,
            })
          }
        />
        <SeverityChip
          label="⚠"
          active={severityFilter.warning}
          count={counts.warning}
          colorClass="text-amber-600"
          onToggle={() =>
            setSeverityFilter({
              ...severityFilter,
              warning: !severityFilter.warning,
            })
          }
        />
        <SeverityChip
          label="ⓘ"
          active={severityFilter.info}
          count={counts.info}
          colorClass="text-blue-600"
          onToggle={() =>
            setSeverityFilter({
              ...severityFilter,
              info: !severityFilter.info,
            })
          }
        />
        <div className="flex-1" />
        <WarningsBadge warnings={warnings} />
      </div>
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1 rounded border border-border bg-background px-1.5">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="rule_id / message で絞り込み"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-6 w-full bg-transparent text-xs outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <select
          value={groupMode}
          onChange={(e) => setGroupMode(e.target.value as GroupMode)}
          className="h-6 rounded border border-border bg-background px-1 text-xs"
        >
          <option value="severity">Group: Severity</option>
          <option value="none">Group: なし</option>
        </select>
      </div>
    </div>
  );
}

function DiagnosticRow({
  d,
  sceneText,
  onJump,
  onFix,
}: {
  d: Diagnostic;
  sceneText: string;
  onJump: (d: Diagnostic) => void;
  onFix: (d: Diagnostic) => void;
}) {
  const { before, hit, after } = extractExcerpt(sceneText, d);
  return (
    <li className="flex items-start gap-2 px-3 py-2 hover:bg-accent/40">
      <button
        type="button"
        className="flex flex-1 items-start gap-2 text-left"
        onClick={() => onJump(d)}
      >
        <span className="mt-0.5 shrink-0">
          <SeverityIcon severity={d.severity} />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm">{d.message}</span>
          <span className="text-xs text-muted-foreground">{d.rule_id}</span>
          {(before || hit || after) && (
            <span className="truncate font-mono text-xs text-muted-foreground">
              {before}
              <mark className="bg-amber-500/20 px-0.5">{hit}</mark>
              {after}
            </span>
          )}
        </div>
      </button>
      {d.fix && (
        <button
          type="button"
          title={d.fix.label}
          onClick={() => onFix(d)}
          className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Wrench className="h-3.5 w-3.5" />
          Fix
        </button>
      )}
    </li>
  );
}
