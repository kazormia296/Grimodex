import { useState } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Sparkles, Loader2 } from "lucide-react";
import { SettingSection } from "../components/SettingSection";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { blockIfUnlicensed } from "@/features/license/gate";
import { debugLog, errorDetail } from "@/lib/debugLog";
import {
  listCodexEntries,
  updateCodexEntry,
  type CodexEntry,
} from "@/features/codex/api";
import { parseAliases } from "@/features/codex/codexMatcher";
import {
  parseReadings,
  serializeReadings,
  surfacesForEntry,
  needsAiReading,
  type ReadingMap,
} from "@/features/codex/reading";
import { inferReadings, YOMI_MAX_ENTRIES } from "@/features/codex/codexYomi";
import { listCodexTypes } from "@/features/codex/typeApi";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { isJapaneseProjectLanguage } from "@/features/ime/language";

interface WorkItem {
  id: string;
  category: string;
  surfaces: string[]; // 読み未設定の漢字表記
  readings: ReadingMap; // 既存読み (非破壊マージ用)
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

/**
 * 既存 Codex エントリの漢字表記のうち読み未設定のものを AI で一括推定して登録する
 * (docs/Grimodex_IME連携設計書.md §3.3 バックフィル)。エントリ単位で 1 プロンプトに畳み、
 * YOMI_MAX_ENTRIES ごとに逐次実行する。undo 履歴を汚さないため store.update ではなく
 * updateCodexEntry を直呼びする。
 */
export function ReadingsBackfillSection() {
  const { t } = useTranslation();
  const projectLanguage = useSettingsStore((s) => s.projectLanguage);
  const enabled = isJapaneseProjectLanguage(projectLanguage);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  });

  const run = async () => {
    if (!enabled) return;
    const projectId = getCurrentProjectId();
    if (!projectId) return;
    // 先頭で 1 回だけ policy を検査する。ここで弾かないと chunk 毎に
    // inferReadings が blockIfPolicyOff でエラートーストを連発しつつ空 Map を返し、
    // 最後に success(count:0) を出す矛盾トーストになる (レビュー指摘)。
    if (blockIfPolicyOff("knowledgeWrite") || blockIfUnlicensed()) return;
    setRunning(true);
    setProgress({ done: 0, total: 0 });
    try {
      const [entries, types] = await Promise.all([
        listCodexEntries(projectId),
        listCodexTypes(projectId),
      ]);
      const labelBySlug = new Map(types.map((ty) => [ty.slug, ty.label]));

      const work: WorkItem[] = [];
      for (const e of entries as CodexEntry[]) {
        const readings = parseReadings(e.readings);
        const surfaces = surfacesForEntry(e.name, parseAliases(e.aliases));
        const need = surfaces.filter(
          (s) => needsAiReading(s) && !(readings[s]?.length ?? 0),
        );
        if (need.length > 0) {
          work.push({
            id: e.id,
            category: labelBySlug.get(e.type) ?? e.type,
            surfaces: need,
            readings,
          });
        }
      }

      if (work.length === 0) {
        toast.info(t("codex.readings.backfillNone"));
        return;
      }
      setProgress({ done: 0, total: work.length });

      let written = 0;
      for (const batch of chunk(work, YOMI_MAX_ENTRIES)) {
        const byId = new Map(batch.map((w) => [w.id, w]));
        const results = await inferReadings(
          batch.map((w) => ({
            id: w.id,
            category: w.category,
            surfaces: w.surfaces,
          })),
        );
        // 推定結果を各エントリの既存読みへ非破壊マージして保存。
        for (const [id, list] of results) {
          const w = byId.get(id);
          if (!w || list.length === 0) continue;
          const next = { ...w.readings };
          let added = 0;
          for (const { surface, yomi } of list) {
            if (!(next[surface]?.length ?? 0)) {
              next[surface] = [yomi];
              added++;
            }
          }
          if (added === 0) continue;
          try {
            // 戻り値 undefined = 0 行マッチ (実行中に対象が削除された等) = 未永続化。
            // written に数えると成功トーストが過大報告になる (レビュー指摘)。
            const saved = await updateCodexEntry(projectId, id, {
              readings: serializeReadings(next),
            });
            if (saved) written += added;
          } catch (err) {
            debugLog.error("ReadingsBackfill", "save failed", errorDetail(err));
          }
        }
        setProgress((p) => ({ ...p, done: p.done + batch.length }));
      }

      // 開いている Codex パネルへ反映: entries 再読込後、選択中エントリを新しい
      // オブジェクトへ張り替える。張り替えないと詳細ペインが stale な readings を
      // 表示し、続く手動読み編集が blind-write でバックフィル分を消す (レビュー指摘)。
      const store = useCodexStore.getState();
      // entries はパネルの表示・検索状態により空/部分集合でも、completionTargets は
      // 自動ルビが読む全件キャッシュ。実書き込み後は表示有無に関係なく再同期する。
      if (written > 0) {
        await store.loadEntries();
        const s2 = useCodexStore.getState();
        const sel = s2.selectedEntry;
        if (sel) {
          const fresh = s2.entries.find((e) => e.id === sel.id);
          if (fresh) s2.setSelectedEntry(fresh);
        }
      }
      toast.success(t("codex.readings.backfillDone", { count: written }));
    } catch (err) {
      debugLog.error("ReadingsBackfill", "run failed", errorDetail(err));
      toast.error(t("codex.readings.backfillFailed"));
    } finally {
      setRunning(false);
    }
  };

  if (!enabled) return null;

  return (
    <SettingSection title={t("codex.readings.backfillTitle")}>
      <p className="mb-2 text-xs text-muted-foreground">
        {t("codex.readings.backfillDesc")}
      </p>
      <button
        type="button"
        data-testid="readings-backfill-run"
        onClick={() => void run()}
        disabled={running}
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1 text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        {running ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Sparkles className="h-3.5 w-3.5" />
        )}
        {running && progress.total > 0
          ? t("codex.readings.backfillRunning", {
              done: progress.done,
              total: progress.total,
            })
          : t("codex.readings.backfillRun")}
      </button>
    </SettingSection>
  );
}
