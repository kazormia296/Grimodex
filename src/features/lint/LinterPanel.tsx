import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Download,
  EyeOff,
  Info,
  PowerOff,
  Search,
  Wrench,
  X,
} from "lucide-react";

import { useEditorStore } from "@/features/editor/editorStore";
import { buildOffsetMap, strOffsetToPmPos } from "@/features/editor/offsetMap";
import { useTabStore } from "@/features/editor/tabStore";
import type { Diagnostic, RuleWarning, Severity } from "./types";
import { useLintStore } from "./lintStore";
import { useLintIgnoreStore } from "./lintIgnoreStore";
import { useLintConfigStore } from "./lintConfigStore";
import { useLintProjectStore } from "./lintProjectStore";
import type { ScannedScene } from "./projectScan";
import { extensionFor, renderReport, type ReportFormat } from "./lintReport";
import { runLintNow } from "./useLinter";

const DEFAULT_PROJECT_ID = "default-project";

type PanelMode = "current" | "project";

type GroupMode = "severity" | "rule" | "none";

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
    return { before: "", hit: `${first}…${last}`, after: "" };
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

/**
 * Render-invariant key for a Diagnostic.
 *
 * Multiple rules can land on the exact same span, so `rule_id` is part
 * of the key. Identical (rule_id, range) tuples from a single rule are
 * rare but legal — callers disambiguate with a running index supplied
 * by `buildDiagnosticKeys`.
 */
function buildDiagnosticKeys(list: Diagnostic[]): Map<Diagnostic, string> {
  const counts = new Map<string, number>();
  const out = new Map<Diagnostic, string>();
  for (const d of list) {
    const base = `${d.rule_id}:${d.range.start}:${d.range.end}`;
    const n = counts.get(base) ?? 0;
    out.set(d, `${base}:${n}`);
    counts.set(base, n + 1);
  }
  return out;
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
 * Phase 2 Linter panel, Current mode (= 現在シーン).
 *
 * - Severity filter, search, group by severity/rule/none
 * - 右クリックメニュー: 永続無視 / ルール OFF / ルール詳細
 * - キーボード操作: ↑↓ で選択、Enter でジャンプ、Cmd/Ctrl+. で Fix
 * - エディタカーソル位置の Diagnostic を強調
 * - ヘッダに「全 Fix 適用」ボタン
 */
function CurrentLinterView() {
  const editor = useEditorStore((s) => s.editor);
  const diagnostics = useLintStore((s) => s.diagnostics);
  const warnings = useLintStore((s) => s.warnings);
  const isLinting = useLintStore((s) => s.isLinting);
  const lastErrorMessage = useLintStore((s) => s.lastErrorMessage);
  const currentSceneId = useLintStore((s) => s.currentSceneId);
  const cursorOffset = useLintStore((s) => s.cursorOffset);
  const setRule = useLintConfigStore((s) => s.setRule);
  const addIgnore = useLintIgnoreStore((s) => s.addIgnore);
  const reapplyIgnores = useLintStore((s) => s.reapplyIgnores);

  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>({
    error: true,
    warning: true,
    info: true,
  });
  const [groupMode, setGroupMode] = useState<GroupMode>("severity");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    d: Diagnostic;
  } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const counts = useMemo(() => {
    const c = { error: 0, warning: 0, info: 0 };
    for (const d of diagnostics) c[d.severity] += 1;
    return c;
  }, [diagnostics]);

  const sceneText = useMemo(() => {
    if (!editor) return "";
    const map = buildOffsetMap(editor.state.doc);
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
    if (groupMode === "rule") {
      const buckets = new Map<string, Diagnostic[]>();
      for (const d of filtered) {
        const arr = buckets.get(d.rule_id) ?? [];
        arr.push(d);
        buckets.set(d.rule_id, arr);
      }
      return [...buckets.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([ruleId, items]) => ({
          key: `rule:${ruleId}`,
          label: `${ruleId} (${items.length})`,
          items,
        }));
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

  /**
   * Single source of truth: Diagnostic → stable key. Derived from
   * `filtered` so every consumer (flatRows, cursorActiveKeys, the row
   * renderer) agrees regardless of group ordering.
   */
  const keyByDiagnostic = useMemo(
    () => buildDiagnosticKeys(filtered),
    [filtered],
  );

  /** Flat, visible list in render order — basis for keyboard nav. */
  const flatRows = useMemo(() => {
    const out: Array<{ key: string; d: Diagnostic }> = [];
    for (const group of grouped) {
      if (collapsed[group.key]) continue;
      for (const d of group.items) {
        const k = keyByDiagnostic.get(d);
        if (k) out.push({ key: k, d });
      }
    }
    return out;
  }, [grouped, collapsed, keyByDiagnostic]);

  /** Diagnostics whose range contains the editor cursor. */
  const cursorActiveKeys = useMemo(() => {
    if (cursorOffset == null) return new Set<string>();
    const keys = new Set<string>();
    for (const d of filtered) {
      if (cursorOffset >= d.range.start && cursorOffset <= d.range.end) {
        const k = keyByDiagnostic.get(d);
        if (k) keys.add(k);
      }
    }
    return keys;
  }, [filtered, cursorOffset, keyByDiagnostic]);

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

  /**
   * Apply every fix in the currently-filtered list in one pass.
   * Sort descending by range.start so earlier offsets don't shift
   * under later ones. Uses a single chained transaction per the
   * TipTap API.
   */
  const applyAllFixes = useCallback(() => {
    if (!editor) return;
    const withFix = filtered.filter((d) => d.fix);
    if (withFix.length === 0) return;
    const map = buildOffsetMap(editor.state.doc);
    const sorted = [...withFix].sort(
      (a, b) => b.fix!.range.start - a.fix!.range.start,
    );
    let chain = editor.chain().focus();
    for (const d of sorted) {
      const from = strOffsetToPmPos(map, d.fix!.range.start);
      const to = strOffsetToPmPos(map, d.fix!.range.end);
      if (from == null || to == null) continue;
      chain = chain.insertContentAt({ from, to }, d.fix!.replacement);
    }
    chain.run();
    if (currentSceneId) void runLintNow(editor, currentSceneId);
  }, [editor, filtered, currentSceneId]);

  const fixableCount = useMemo(
    () => filtered.filter((d) => d.fix).length,
    [filtered],
  );

  const onIgnore = useCallback(
    async (d: Diagnostic) => {
      if (!currentSceneId) return;
      try {
        await addIgnore(currentSceneId, d, sceneText);
        reapplyIgnores(currentSceneId);
      } catch (err) {
        console.error("addIgnore failed", err);
      }
    },
    [addIgnore, currentSceneId, reapplyIgnores, sceneText],
  );

  const onDisableRule = useCallback(
    (d: Diagnostic) => {
      setRule(d.rule_id, { enabled: false });
    },
    [setRule],
  );

  // Keyboard: ↑↓ Enter Cmd/Ctrl+.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null;
      // Stay out of the way when typing in the search box / editor.
      if (
        active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.isContentEditable)
      ) {
        return;
      }
      if (!listRef.current) return;
      const root = listRef.current;
      if (!root.contains(active) && active !== document.body) return;
      if (flatRows.length === 0) return;

      const curIdx = flatRows.findIndex((r) => r.key === selectedKey);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = curIdx < 0 ? 0 : Math.min(curIdx + 1, flatRows.length - 1);
        setSelectedKey(flatRows[next].key);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const next = curIdx < 0 ? 0 : Math.max(curIdx - 1, 0);
        setSelectedKey(flatRows[next].key);
      } else if (e.key === "Enter") {
        const row = flatRows[curIdx];
        if (row) {
          e.preventDefault();
          jumpTo(row.d);
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key === ".") {
        const row = flatRows[curIdx];
        if (row && row.d.fix) {
          e.preventDefault();
          applyFix(row.d);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flatRows, selectedKey, jumpTo, applyFix]);

  // Close context menu on outside click / Escape.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onEsc);
    };
  }, [menu]);

  const header = (
    <PanelHeader
      counts={counts}
      severityFilter={severityFilter}
      setSeverityFilter={setSeverityFilter}
      groupMode={groupMode}
      setGroupMode={setGroupMode}
      query={query}
      setQuery={setQuery}
      warnings={warnings}
      fixableCount={fixableCount}
      onApplyAll={applyAllFixes}
    />
  );

  if (lastErrorMessage) {
    return (
      <div className="flex h-full flex-col">
        {header}
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
        {header}
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
    <div className="flex h-full flex-col">
      {header}
      <div className="flex-1 overflow-y-auto" ref={listRef} tabIndex={0}>
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
                    {group.items.map((d) => {
                      const key = keyByDiagnostic.get(d) ?? "";
                      return (
                        <DiagnosticRow
                          key={key}
                          rowKey={key}
                          d={d}
                          sceneText={sceneText}
                          selected={selectedKey === key}
                          cursorActive={cursorActiveKeys.has(key)}
                          onSelect={setSelectedKey}
                          onJump={jumpTo}
                          onFix={applyFix}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setMenu({ x: e.clientX, y: e.clientY, d });
                            setSelectedKey(key);
                          }}
                        />
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })
        )}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          d={menu.d}
          onIgnore={() => {
            void onIgnore(menu.d);
            setMenu(null);
          }}
          onDisableRule={() => {
            onDisableRule(menu.d);
            setMenu(null);
          }}
          onClose={() => setMenu(null)}
        />
      )}
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
  fixableCount: number;
  onApplyAll: () => void;
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
    fixableCount,
    onApplyAll,
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
        {fixableCount > 0 && (
          <button
            type="button"
            onClick={onApplyAll}
            title="フィルタ結果の Fix を一括適用"
            className="flex h-6 items-center gap-1 rounded border border-border bg-background px-1.5 text-xs hover:bg-accent"
          >
            <Wrench className="h-3.5 w-3.5" /> 全 Fix ({fixableCount})
          </button>
        )}
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
          <option value="rule">Group: Rule</option>
          <option value="none">Group: なし</option>
        </select>
      </div>
    </div>
  );
}

function DiagnosticRow({
  rowKey,
  d,
  sceneText,
  selected,
  cursorActive,
  onSelect,
  onJump,
  onFix,
  onContextMenu,
}: {
  rowKey: string;
  d: Diagnostic;
  sceneText: string;
  selected: boolean;
  cursorActive: boolean;
  onSelect: (key: string) => void;
  onJump: (d: Diagnostic) => void;
  onFix: (d: Diagnostic) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const { before, hit, after } = extractExcerpt(sceneText, d);
  const liClasses = [
    "flex items-start gap-2 px-3 py-2 hover:bg-accent/40",
    selected ? "bg-accent/70" : "",
    cursorActive ? "border-l-2 border-l-sky-500" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <li
      className={liClasses}
      onContextMenu={onContextMenu}
      onMouseDown={() => onSelect(rowKey)}
    >
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

function ContextMenu({
  x,
  y,
  d,
  onIgnore,
  onDisableRule,
  onClose,
}: {
  x: number;
  y: number;
  d: Diagnostic;
  onIgnore: () => void;
  onDisableRule: () => void;
  onClose: () => void;
}) {
  // Clamp to viewport — a naive offset is fine at this scale.
  const style: React.CSSProperties = {
    position: "fixed",
    left: Math.min(x, window.innerWidth - 240),
    top: Math.min(y, window.innerHeight - 140),
    zIndex: 60,
  };
  return (
    <div
      style={style}
      onClick={(e) => e.stopPropagation()}
      className="min-w-[220px] rounded border border-border bg-background py-1 text-sm shadow-lg"
    >
      <button
        type="button"
        onClick={onIgnore}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent"
      >
        <EyeOff className="h-4 w-4" /> この箇所を永続無視
      </button>
      <button
        type="button"
        onClick={onDisableRule}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent"
      >
        <PowerOff className="h-4 w-4" /> ルール「{d.rule_id}」を無効化
      </button>
      <div className="my-1 border-t border-border" />
      <button
        type="button"
        onClick={onClose}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-muted-foreground hover:bg-accent"
      >
        キャンセル
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Top-level orchestrator: mode toggle + dispatch.
// ─────────────────────────────────────────────────────────────────────

/**
 * Phase 2 Linter panel entry point. Owns the Current / Project mode
 * toggle; each sub-view owns its own filters / selection / progress.
 */
export function LinterPanel() {
  const [mode, setMode] = useState<PanelMode>("current");
  return (
    <div className="flex h-full flex-col" data-testid="lint-panel">
      <ModeBar mode={mode} setMode={setMode} />
      <div className="min-h-0 flex-1">
        {mode === "current" ? <CurrentLinterView /> : <ProjectLinterView />}
      </div>
    </div>
  );
}

function ModeBar({
  mode,
  setMode,
}: {
  mode: PanelMode;
  setMode: (m: PanelMode) => void;
}) {
  return (
    <div className="flex items-center gap-1 border-b border-border bg-muted/20 px-2 py-1 text-xs">
      <button
        type="button"
        onClick={() => setMode("current")}
        className={`rounded px-2 py-0.5 ${
          mode === "current"
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:bg-accent"
        }`}
      >
        現在シーン
      </button>
      <button
        type="button"
        onClick={() => setMode("project")}
        className={`rounded px-2 py-0.5 ${
          mode === "project"
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:bg-accent"
        }`}
      >
        プロジェクト
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Project mode
// ─────────────────────────────────────────────────────────────────────

/**
 * All-scenes view. Controls the scan (start/cancel) and renders
 * results grouped by scene. Clicking a diagnostic opens the owning
 * scene and jumps to the range via the pending-jump mechanism.
 */
function ProjectLinterView() {
  const phase = useLintProjectStore((s) => s.phase);
  const completed = useLintProjectStore((s) => s.completed);
  const total = useLintProjectStore((s) => s.total);
  const currentTitle = useLintProjectStore((s) => s.currentSceneTitle);
  const scenes = useLintProjectStore((s) => s.scenes);
  const fatalError = useLintProjectStore((s) => s.fatalError);
  const start = useLintProjectStore((s) => s.start);
  const cancel = useLintProjectStore((s) => s.cancel);
  const requestJump = useLintProjectStore((s) => s.requestJump);
  const openPinned = useTabStore((s) => s.openPinned);

  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>({
    error: true,
    warning: true,
    info: true,
  });
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [exportOpen, setExportOpen] = useState(false);

  const counts = useMemo(() => {
    const c = { error: 0, warning: 0, info: 0 };
    for (const scene of scenes) {
      for (const d of scene.diagnostics) c[d.severity] += 1;
    }
    return c;
  }, [scenes]);

  const filteredScenes = useMemo(() => {
    const q = query.trim().toLowerCase();
    return scenes
      .map((scene) => ({
        ...scene,
        diagnostics: scene.diagnostics.filter((d) => {
          if (!severityFilter[d.severity]) return false;
          if (q.length > 0) {
            const hay = `${d.rule_id} ${d.message}`.toLowerCase();
            if (!hay.includes(q)) return false;
          }
          return true;
        }),
      }))
      .filter((scene) => scene.diagnostics.length > 0);
  }, [scenes, severityFilter, query]);

  const onStart = useCallback(() => {
    void start(DEFAULT_PROJECT_ID);
  }, [start]);

  const onJump = useCallback(
    (scene: ScannedScene, d: Diagnostic) => {
      // Stash the target range so useLinter applies it after the
      // editor finishes loading the scene's content.
      requestJump({ sceneId: scene.sceneId, range: d.range });
      openPinned(scene.sceneId);
    },
    [requestJump, openPinned],
  );

  const isRunning = phase === "running";
  const progressPct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="flex h-full flex-col">
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
          {!isRunning && scenes.length > 0 && (
            <button
              type="button"
              onClick={() => setExportOpen(true)}
              title="レポートを書き出し"
              className="flex h-6 items-center gap-1 rounded border border-border bg-background px-1.5 text-xs hover:bg-accent"
            >
              <Download className="h-3.5 w-3.5" />
              Export
            </button>
          )}
          {isRunning ? (
            <button
              type="button"
              onClick={cancel}
              className="flex h-6 items-center gap-1 rounded border border-border bg-background px-1.5 text-xs hover:bg-accent"
            >
              キャンセル
            </button>
          ) : (
            <button
              type="button"
              onClick={onStart}
              className="flex h-6 items-center gap-1 rounded border border-primary bg-primary px-2 text-xs text-primary-foreground hover:opacity-90"
            >
              全章 Lint
            </button>
          )}
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
        </div>
        {isRunning && (
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="truncate">
                {currentTitle ?? "シーン一覧を取得中..."}
              </span>
              <span>
                {completed}/{total}
              </span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded bg-muted">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        )}
        {phase === "cancelled" && (
          <p className="text-xs text-amber-600">
            キャンセルされました（部分結果を表示中）
          </p>
        )}
        {phase === "error" && fatalError && (
          <p className="text-xs text-red-600">{fatalError}</p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {phase === "idle" && scenes.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
            <p>「全章 Lint」を押すとプロジェクト全シーンを走査します</p>
          </div>
        ) : filteredScenes.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
            {phase === "running" ? (
              <p>Lint 実行中...</p>
            ) : (
              <p>該当する項目はありません</p>
            )}
          </div>
        ) : (
          filteredScenes.map((scene) => {
            const key = `scene:${scene.sceneId}`;
            const isCollapsed = collapsed[key] ?? false;
            return (
              <div key={key}>
                <button
                  type="button"
                  onClick={() =>
                    setCollapsed((prev) => ({ ...prev, [key]: !isCollapsed }))
                  }
                  className="flex w-full items-center gap-1 border-b border-border bg-muted/50 px-2 py-1 text-left text-xs font-semibold hover:bg-accent/50"
                >
                  {isCollapsed ? (
                    <ChevronRight className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" />
                  )}
                  <span className="truncate">{scene.sceneTitle}</span>
                  <span className="ml-auto text-muted-foreground">
                    ({scene.diagnostics.length})
                  </span>
                </button>
                {!isCollapsed && (
                  <ul className="flex flex-col divide-y divide-border">
                    {scene.diagnostics.map((d, idx) => (
                      <ProjectDiagnosticRow
                        key={`${d.rule_id}-${d.range.start}-${d.range.end}-${idx}`}
                        d={d}
                        sceneText={scene.sceneText}
                        onJump={() => onJump(scene, d)}
                      />
                    ))}
                  </ul>
                )}
              </div>
            );
          })
        )}
      </div>
      {exportOpen && (
        <ExportReportDialog
          scenes={scenes}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
  );
}

function ProjectDiagnosticRow({
  d,
  sceneText,
  onJump,
}: {
  d: Diagnostic;
  sceneText: string;
  onJump: () => void;
}) {
  const { before, hit, after } = extractExcerpt(sceneText, d);
  return (
    <li className="flex items-start gap-2 px-3 py-2 hover:bg-accent/40">
      <button
        type="button"
        className="flex flex-1 items-start gap-2 text-left"
        onClick={onJump}
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
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Export dialog
// ─────────────────────────────────────────────────────────────────────

function ExportReportDialog({
  scenes,
  onClose,
}: {
  scenes: ScannedScene[];
  onClose: () => void;
}) {
  const [format, setFormat] = useState<ReportFormat>("markdown");
  const [includeExcerpt, setIncludeExcerpt] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const content = renderReport(format, scenes, { includeExcerpt });
      const ext = extensionFor(format);
      // Lazy-load Tauri dialog / fs — consistent with other export
      // flows in the app and keeps the main bundle light for browser-
      // mock test runs.
      const { save: saveDialog } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const path = await saveDialog({
        defaultPath: `lint-report.${ext}`,
        filters: [{ name: format.toUpperCase(), extensions: [ext] }],
      });
      if (!path) {
        setSaving(false);
        return;
      }
      await writeTextFile(path, content);
      setSaving(false);
      onClose();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }, [format, includeExcerpt, scenes, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-[min(420px,90vw)] rounded border border-border bg-background p-4 text-sm shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold">Lint レポートを書き出し</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 hover:bg-accent"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mb-3 flex flex-col gap-2">
          <label className="flex items-center gap-2 text-xs">
            形式
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as ReportFormat)}
              className="h-7 flex-1 rounded border border-border bg-background px-1 text-xs"
            >
              <option value="markdown">Markdown (.md)</option>
              <option value="csv">CSV (.csv)</option>
              <option value="json">JSON (.json)</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={includeExcerpt}
              onChange={(e) => setIncludeExcerpt(e.target.checked)}
            />
            本文抜粋を含める
          </label>
          <p className="text-xs text-muted-foreground">
            出力対象: {scenes.length} シーン ({" "}
            {scenes.reduce((a, s) => a + s.diagnostics.length, 0)} 指摘 )
          </p>
          {error && (
            <p className="rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-600">
              {error}
            </p>
          )}
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-7 rounded border border-border bg-background px-3 text-xs hover:bg-accent"
          >
            キャンセル
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={save}
            className="flex h-7 items-center gap-1 rounded border border-primary bg-primary px-3 text-xs text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" />
            {saving ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
