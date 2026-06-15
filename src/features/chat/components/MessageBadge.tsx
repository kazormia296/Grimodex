import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { BookOpen, Bookmark, StopCircle } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import type { CodexEntry } from "@/features/codex/api";
import { listCodexEntriesByMessageId } from "@/features/codex/api";
import type { Snippet } from "@/features/snippets/api";
import { listSnippetsByMessageId } from "@/features/snippets/api";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { DURATIONS, EASINGS, useReducedMotion } from "@/lib/animation";

interface MessageBadgeProps {
  messageId: string;
  stopped?: boolean;
}

interface BadgeData {
  codexEntries: CodexEntry[];
  snippetEntries: Snippet[];
}

interface DropdownState {
  type: "codex" | "snippet";
  top: number;
  left: number;
}

/**
 * messageId → 抽出バッジデータのモジュールキャッシュ。
 *
 * ChatPanel の仮想化 (3ab21233) でメッセージ行は scroll out/in のたびに
 * remount するため、素朴に mount 毎フェッチすると履歴スクロールの往復で
 * codex+snippet 各 1 本の DB クエリ (Tauri IPC) がバーストする。codex/snippet
 * ストアの ID 集合キーで検証し、抽出の追加/削除 (= ID 集合の変化、削除反映は
 * 0c27e08e の契約) では従来どおり再フェッチする。挿入順 eviction で上限。
 */
interface BadgeCacheEntry {
  codexKey: string;
  snippetKey: string;
  data: BadgeData | null;
}
const badgeCache = new Map<string, BadgeCacheEntry>();
const BADGE_CACHE_MAX = 300;

/** Test-only: reset the module cache between tests. */
export function _clearMessageBadgeCache(): void {
  badgeCache.clear();
}

function openCodexEntry(id: string) {
  useLayoutStore.getState().showPanel("codex");
  useCodexStore.getState().requestSelectEntry(id);
}

function openSnippetEntry(id: string) {
  useLayoutStore.getState().showPanel("snippets");
  useSnippetStore.getState().requestSelectEntry(id);
}

export function MessageBadge({ messageId, stopped }: MessageBadgeProps) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const [data, setData] = useState<BadgeData | null>(null);
  const [dropdown, setDropdown] = useState<DropdownState | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // キーは id だけでなく updatedAt も含める: バッジのドロップダウンは fetch
  // スナップショットの name/title を表示するため、id 集合のみだと rename 後も
  // キャッシュにヒットし続けて旧ラベルが残る (旧実装は remount 毎の無条件
  // 再フェッチで拾えていた)。updatedAt 込みなら編集で必ずミスして再読みする。
  const codexEntryIdKey = useCodexStore((s) =>
    s.entries.map((e) => `${e.id}:${e.updatedAt}`).join(","),
  );
  const snippetEntryIdKey = useSnippetStore((s) =>
    s.entries.map((e) => `${e.id}:${e.updatedAt}`).join(","),
  );

  useEffect(() => {
    // remount (仮想化の scroll in) / ストア不変の再実行はキャッシュで返し、
    // DB クエリを発行しない。ID 集合や updatedAt が変わった (抽出追加/削除/
    // 編集/プロジェクト切替) ときだけミスして再フェッチする。
    const cached = badgeCache.get(messageId);
    if (
      cached &&
      cached.codexKey === codexEntryIdKey &&
      cached.snippetKey === snippetEntryIdKey
    ) {
      setData(cached.data);
      return;
    }
    let cancelled = false;
    async function load() {
      const [codexEntries, snippetEntries] = await Promise.all([
        listCodexEntriesByMessageId(messageId),
        listSnippetsByMessageId(messageId),
      ]);
      const data =
        codexEntries.length > 0 || snippetEntries.length > 0
          ? { codexEntries, snippetEntries }
          : null;
      // キャッシュはリクエスト時点のキーで記録する。解決までにストアが
      // 変わっていれば dep 変化で effect が再走し、キー不一致で再フェッチ
      // される。cancelled でも結果自体はそのキーに対して有効なので記録する。
      badgeCache.delete(messageId);
      if (badgeCache.size >= BADGE_CACHE_MAX) {
        const oldest = badgeCache.keys().next().value;
        if (oldest !== undefined) badgeCache.delete(oldest);
      }
      badgeCache.set(messageId, {
        codexKey: codexEntryIdKey,
        snippetKey: snippetEntryIdKey,
        data,
      });
      if (!cancelled) setData(data);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [messageId, codexEntryIdKey, snippetEntryIdKey]);

  // ドロップダウン外クリック・Escape で閉じる
  useEffect(() => {
    if (!dropdown) return;
    function onMouseDown(e: MouseEvent) {
      if (!dropdownRef.current?.contains(e.target as Node)) {
        setDropdown(null);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setDropdown(null);
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [dropdown]);

  function handleBadgeClick(e: React.MouseEvent, type: "codex" | "snippet") {
    e.stopPropagation();
    // 同じバッジを再クリックで閉じる
    if (dropdown?.type === type) {
      setDropdown(null);
      return;
    }
    const entries =
      type === "codex"
        ? (data?.codexEntries ?? [])
        : (data?.snippetEntries ?? []);
    if (entries.length === 0) return;
    // 1件のみなら直接開く
    if (entries.length === 1) {
      if (type === "codex") openCodexEntry(entries[0].id);
      else openSnippetEntry(entries[0].id);
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDropdown({ type, top: rect.bottom + 4, left: rect.left });
  }

  function handleDropdownSelect(type: "codex" | "snippet", id: string) {
    setDropdown(null);
    if (type === "codex") openCodexEntry(id);
    else openSnippetEntry(id);
  }

  const transition = reduced
    ? { duration: 0 }
    : { duration: DURATIONS.fast, ease: EASINGS.easeOut };

  const dropdownItems =
    dropdown?.type === "codex"
      ? (data?.codexEntries ?? []).map((e) => ({ id: e.id, label: e.name }))
      : (data?.snippetEntries ?? []).map((s) => ({
          id: s.id,
          label: s.title,
        }));

  if (!data && !stopped) return null;

  return (
    <>
      <div className="mt-1 flex flex-wrap gap-1">
        <AnimatePresence>
          {stopped && (
            <motion.span
              key="stopped"
              data-testid={`badge-stopped-${messageId}`}
              className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-700 dark:bg-amber-900 dark:text-amber-300"
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.85 }}
              transition={transition}
            >
              <StopCircle className="h-2.5 w-2.5" />{" "}
              {t("chat.messageBadge.stopped")}
            </motion.span>
          )}
          {data && data.codexEntries.length > 0 && (
            <motion.button
              key="codex"
              type="button"
              data-testid={`badge-codex-${messageId}`}
              className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] text-blue-700 transition-colors hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:hover:bg-blue-800"
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.85 }}
              transition={transition}
              onClick={(e) => handleBadgeClick(e, "codex")}
            >
              <BookOpen className="h-2.5 w-2.5" />
              {t("chat.context.codexExtracted", {
                count: data.codexEntries.length,
              })}
            </motion.button>
          )}
          {data && data.snippetEntries.length > 0 && (
            <motion.button
              key="snippet"
              type="button"
              data-testid={`badge-snippet-${messageId}`}
              className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[10px] text-green-700 transition-colors hover:bg-green-200 dark:bg-green-900 dark:text-green-300 dark:hover:bg-green-800"
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.85 }}
              transition={transition}
              onClick={(e) => handleBadgeClick(e, "snippet")}
            >
              <Bookmark className="h-2.5 w-2.5" />
              {t("chat.context.snippetSaved", {
                count: data.snippetEntries.length,
              })}
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      {dropdown &&
        createPortal(
          <div
            ref={dropdownRef}
            style={{ top: dropdown.top, left: dropdown.left }}
            className="fixed z-50 min-w-[180px] max-w-[260px] rounded-md border border-border bg-popover py-1 shadow-lg"
          >
            <p className="border-b border-border px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {dropdown.type === "codex"
                ? t("chat.messageBadge.codexEntries")
                : t("chat.messageBadge.snippets")}
            </p>
            {dropdownItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className="w-full truncate px-3 py-1.5 text-left text-xs text-foreground hover:bg-accent"
                onClick={() => handleDropdownSelect(dropdown.type, item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
