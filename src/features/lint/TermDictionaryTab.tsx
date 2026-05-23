import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Copy,
  Download,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  useTermDictionaryStore,
  type TermDictionaryRow,
} from "./termDictionaryStore";
import { useTranslation } from "react-i18next";
import { TableRowSkeletonRows } from "@/components/ui/skeleton-patterns";

type EditingState = {
  id: string | null;
  preferred: string;
  variantsRaw: string;
  severity: "warning" | "info";
  note: string;
  enabled: boolean;
};

const EMPTY_EDIT: EditingState = {
  id: null,
  preferred: "",
  variantsRaw: "",
  severity: "warning",
  note: "",
  enabled: true,
};

export function TermDictionaryTab() {
  const { t } = useTranslation();
  const rows = useTermDictionaryStore((s) => s.rows);
  const isLoaded = useTermDictionaryStore((s) => s.isLoaded);
  const searchQuery = useTermDictionaryStore((s) => s.searchQuery);
  const sortBy = useTermDictionaryStore((s) => s.sortBy);
  const load = useTermDictionaryStore((s) => s.load);
  const upsert = useTermDictionaryStore((s) => s.upsert);
  const remove = useTermDictionaryStore((s) => s.remove);
  const duplicate = useTermDictionaryStore((s) => s.duplicate);
  const toggleEnabled = useTermDictionaryStore((s) => s.toggleEnabled);
  const setSearchQuery = useTermDictionaryStore((s) => s.setSearchQuery);
  const setSortBy = useTermDictionaryStore((s) => s.setSortBy);

  const [editing, setEditing] = useState<EditingState | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    if (!isLoaded) void load().catch(() => {});
  }, [isLoaded, load]);

  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      if (r.preferred.toLowerCase().includes(q)) return true;
      if (r.variants.some((v) => v.toLowerCase().includes(q))) return true;
      if (r.note?.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [rows, searchQuery]);

  const openNew = () => {
    setErrors([]);
    setEditing({ ...EMPTY_EDIT });
  };

  const openEdit = (row: TermDictionaryRow) => {
    setErrors([]);
    setEditing({
      id: row.id,
      preferred: row.preferred,
      variantsRaw: row.variants.join(", "),
      severity: row.severity,
      note: row.note ?? "",
      enabled: row.enabled,
    });
  };

  const save = async () => {
    if (!editing) return;
    const variants = editing.variantsRaw
      .split(/[,、]/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    const result = await upsert(
      {
        preferred: editing.preferred,
        variants,
        severity: editing.severity,
        note: editing.note || null,
        enabled: editing.enabled,
      },
      editing.id ?? undefined,
    );
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setEditing(null);
    setErrors([]);
  };

  return (
    <div className="flex h-full flex-col gap-3 p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={openNew}
          className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-accent"
        >
          <Plus className="h-3.5 w-3.5" /> 追加
        </button>
        <button
          type="button"
          disabled
          className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground"
          title="Phase 2 で実装予定"
        >
          <Upload className="h-3.5 w-3.5" /> CSV インポート
          <span className="ml-1 text-[10px]">[未実装]</span>
        </button>
        <button
          type="button"
          disabled
          className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground"
          title="Phase 2 で実装予定"
        >
          <Download className="h-3.5 w-3.5" /> エクスポート
          <span className="ml-1 text-[10px]">[未実装]</span>
        </button>
        <div className="ml-auto flex items-center gap-2">
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="検索"
            className="h-7 w-40 rounded border border-border bg-background px-2 text-xs"
          />
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
            className="h-7 rounded border border-border bg-background px-1 text-xs"
          >
            <option value="sortOrder">手動並び順</option>
            <option value="preferred">推奨表記</option>
            <option value="updatedAt">更新日</option>
            <option value="severity">Severity</option>
          </select>
        </div>
      </div>

      {!isLoaded ? (
        <div
          className="overflow-hidden rounded border border-border"
          aria-label={t("common.loadingContent")}
        >
          <table className="w-full text-xs">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="w-8 px-2 py-1.5" />
                <th className="px-2 py-1.5">推奨表記</th>
                <th className="px-2 py-1.5">許容しない表記</th>
                <th className="w-20 px-2 py-1.5">Severity</th>
                <th className="w-14 px-2 py-1.5 text-center">ON</th>
                <th className="w-24 px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              <TableRowSkeletonRows testId="term-dictionary-loading" />
            </tbody>
          </table>
        </div>
      ) : filteredRows.length === 0 ? (
        <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">
          {rows.length === 0 ? "用語辞書はまだ空です。" : "該当エントリなし。"}
        </div>
      ) : (
        <div className="overflow-hidden rounded border border-border">
          <table className="w-full text-xs">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="w-8 px-2 py-1.5" />
                <th className="px-2 py-1.5">推奨表記</th>
                <th className="px-2 py-1.5">許容しない表記</th>
                <th className="w-20 px-2 py-1.5">Severity</th>
                <th className="w-14 px-2 py-1.5 text-center">ON</th>
                <th className="w-24 px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row) => (
                <tr
                  key={row.id}
                  className={cn(
                    "border-t border-border hover:bg-accent/30",
                    !row.enabled && "text-muted-foreground",
                  )}
                >
                  <td className="px-2 py-1.5">
                    {row.aliasCollision.length > 0 && (
                      <span
                        title={`Codex「${row.aliasCollision.join("」「")}」の alias と衝突、Codex 側が優先されます`}
                        aria-label="Codex alias collision"
                      >
                        <AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 font-medium">
                    <button
                      type="button"
                      onClick={() => openEdit(row)}
                      className="text-left hover:underline"
                    >
                      {row.preferred}
                    </button>
                  </td>
                  <td className="px-2 py-1.5">
                    <span className="text-muted-foreground">
                      {row.variants.join(", ")}
                    </span>
                    {row.note && (
                      <span className="ml-2 text-[10px] text-muted-foreground/70">
                        📝 {row.note}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    <span
                      className={cn(
                        "rounded px-1 py-0.5 text-[10px] uppercase",
                        row.severity === "warning"
                          ? "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400"
                          : "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
                      )}
                    >
                      {row.severity}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    <input
                      type="checkbox"
                      checked={row.enabled}
                      onChange={(e) =>
                        void toggleEnabled(row.id, e.target.checked)
                      }
                    />
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <button
                      type="button"
                      onClick={() => void duplicate(row.id)}
                      className="rounded p-1 hover:bg-accent"
                      title="複製"
                    >
                      <Copy className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (
                          window.confirm(`「${row.preferred}」を削除しますか？`)
                        ) {
                          void remove(row.id);
                        }
                      }}
                      className="rounded p-1 hover:bg-accent"
                      title="削除"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <div className="rounded border border-border bg-muted/20 p-3">
          <div className="mb-2 flex items-center justify-between">
            <h5 className="font-semibold">
              {editing.id ? "エントリを編集" : "新しいエントリ"}
            </h5>
          </div>
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-xs">
              推奨表記
              <input
                value={editing.preferred}
                onChange={(e) =>
                  setEditing({ ...editing, preferred: e.target.value })
                }
                className="h-7 rounded border border-border bg-background px-2"
                placeholder="ウェブ"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              許容しない表記（カンマ区切り）
              <input
                value={editing.variantsRaw}
                onChange={(e) =>
                  setEditing({ ...editing, variantsRaw: e.target.value })
                }
                className="h-7 rounded border border-border bg-background px-2"
                placeholder="web, Web, ウエブ"
              />
            </label>
            <div className="flex items-center gap-3 text-xs">
              <label className="flex items-center gap-1">
                Severity
                <select
                  value={editing.severity}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      severity: e.target.value as "warning" | "info",
                    })
                  }
                  className="h-7 rounded border border-border bg-background px-1"
                >
                  <option value="warning">warning</option>
                  <option value="info">info</option>
                </select>
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={editing.enabled}
                  onChange={(e) =>
                    setEditing({ ...editing, enabled: e.target.checked })
                  }
                />
                有効
              </label>
            </div>
            <label className="flex flex-col gap-1 text-xs">
              メモ（任意）
              <input
                value={editing.note}
                onChange={(e) =>
                  setEditing({ ...editing, note: e.target.value })
                }
                className="h-7 rounded border border-border bg-background px-2"
                placeholder="企画書 §3.2 で決定"
              />
            </label>
            {errors.length > 0 && (
              <ul className="rounded border border-red-300 bg-red-50 p-2 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400">
                {errors.map((e, i) => (
                  <li key={i}>・{e}</li>
                ))}
              </ul>
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void save()}
                className="rounded border border-border bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90"
              >
                保存
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(null);
                  setErrors([]);
                }}
                className="rounded border border-border px-3 py-1 text-xs hover:bg-accent"
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
