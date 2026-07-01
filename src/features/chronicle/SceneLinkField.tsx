import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";

export interface SceneOption {
  id: string;
  title: string;
}

/**
 * リンク時のプロパティ優先方向。
 * - "event": イベントの日付/POV/場所をシーンへ写して合わせる（イベント優先）。
 * - "scene": 関連付けのみ。シーン側のプロパティはそのまま保持（シーン優先）。
 */
export type SceneLinkMode = "event" | "scene";

export interface SceneLinkFieldProps {
  /** プロジェクトの全シーン（読み順）。候補ピッカーの母集合。 */
  scenes: SceneOption[];
  /** このイベントに現在リンク済みのシーン id。 */
  linkedSceneIds: string[];
  onLink: (sceneId: string, mode: SceneLinkMode) => void;
  onUnlink: (sceneId: string) => void;
  /** ピル(タイトル)クリックで該当シーンを開く。未指定ならクリック不可の表示のみ。 */
  onOpenScene?: (sceneId: string) => void;
}

/**
 * 追加候補（未リンク & タイトル部分一致）を読み順のまま返す純関数。
 * クエリは trim + 小文字化して大小・前後空白を無視した部分一致で絞る。
 */
export function filterLinkableScenes(
  scenes: SceneOption[],
  linkedSceneIds: string[],
  query: string,
): SceneOption[] {
  const linked = new Set(linkedSceneIds);
  const q = query.trim().toLowerCase();
  return scenes.filter((s) => {
    if (linked.has(s.id)) return false;
    if (!q) return true;
    return s.title.toLowerCase().includes(q);
  });
}

/**
 * イベント⇔シーンの手動リンク UI（インスペクタ内）。リンク済みをチップで並べて
 * ×で解除、「シーンを追加」で検索付きの候補リストを開いてクリックでリンクする。
 * ポータル無しのフロー配置なので overflow でクリップされず happy-dom でも素直にテスト可能。
 */
export function SceneLinkField({
  scenes,
  linkedSceneIds,
  onLink,
  onUnlink,
  onOpenScene,
}: SceneLinkFieldProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // 既定は「イベント優先」（このイベントの日付/POV/場所をシーンへ合わせる）。
  const [mode, setMode] = useState<SceneLinkMode>("event");

  const titleOf = useMemo(() => {
    const m = new Map(scenes.map((s) => [s.id, s.title]));
    return (id: string) =>
      m.get(id) || t("chronicle.untitledScene", "無題のシーン");
  }, [scenes, t]);

  const candidates = useMemo(
    () => filterLinkableScenes(scenes, linkedSceneIds, query),
    [scenes, linkedSceneIds, query],
  );

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] text-muted-foreground">
        {t("chronicle.linkedScenes", "参照シーン")}
      </span>

      {linkedSceneIds.length === 0 ? (
        <span
          data-testid="no-linked-scenes"
          className="text-[11px] text-muted-foreground/70"
        >
          {t("chronicle.noLinkedScenes", "参照シーンなし")}
        </span>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {linkedSceneIds.map((id) => (
            <span
              key={id}
              data-testid="linked-scene"
              className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-card py-0.5 pe-0.5 ps-2 text-xs"
            >
              {onOpenScene ? (
                <button
                  type="button"
                  data-testid="open-linked-scene"
                  data-scene-id={id}
                  onClick={() => onOpenScene(id)}
                  title={t(
                    "chronicle.openSceneHint",
                    "該当シーンをエディタで開く",
                  )}
                  className="truncate rounded text-start hover:text-primary hover:underline"
                >
                  {titleOf(id)}
                </button>
              ) : (
                <span className="truncate">{titleOf(id)}</span>
              )}
              <button
                type="button"
                data-testid="unlink-scene"
                data-scene-id={id}
                onClick={() => onUnlink(id)}
                aria-label={`${t("chronicle.unlinkScene", "リンクを外す")}: ${titleOf(
                  id,
                )}`}
                className="inline-flex size-4 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-1">
        <button
          type="button"
          data-testid="link-scene-toggle"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="inline-flex h-7 w-fit items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-xs hover:bg-accent"
        >
          <Plus className="size-3.5" />
          {t("chronicle.linkScene", "シーンを追加")}
        </button>

        {open && (
          <div className="flex flex-col gap-1 rounded-lg border border-border bg-card p-1.5">
            {/* リンク時のプロパティ優先方向（既定=イベント優先で日付/POV/場所を合わせる）。 */}
            <div
              className="flex items-center gap-1 text-[11px]"
              role="radiogroup"
              aria-label={t("chronicle.linkModeLabel", "リンク時の優先")}
            >
              {(["event", "scene"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  data-testid={`link-mode-${m}`}
                  role="radio"
                  aria-checked={mode === m}
                  onClick={() => setMode(m)}
                  className={`rounded px-1.5 py-0.5 ${
                    mode === m
                      ? "bg-primary/15 text-foreground"
                      : "text-muted-foreground hover:bg-accent"
                  }`}
                >
                  {m === "event"
                    ? t("chronicle.linkModeEvent", "イベント優先")
                    : t("chronicle.linkModeScene", "シーン優先")}
                </button>
              ))}
            </div>
            <input
              data-testid="link-scene-search"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("chronicle.linkSceneSearch", "シーンを検索…")}
              aria-label={t("chronicle.linkSceneSearch", "シーンを検索…")}
              className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground"
            />
            {candidates.length === 0 ? (
              <span
                data-testid="no-matching-scenes"
                className="px-1 py-1.5 text-[11px] text-muted-foreground/70"
              >
                {t("chronicle.noMatchingScenes", "該当するシーンがありません")}
              </span>
            ) : (
              <ul className="max-h-40 overflow-auto">
                {candidates.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      data-testid="link-scene-candidate"
                      data-scene-id={s.id}
                      onClick={() => onLink(s.id, mode)}
                      className="flex w-full items-center rounded-md px-2 py-1 text-start text-xs hover:bg-accent"
                    >
                      <span className="truncate">
                        {s.title ||
                          t("chronicle.untitledScene", "無題のシーン")}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
