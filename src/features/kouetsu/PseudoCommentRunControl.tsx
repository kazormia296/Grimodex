import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { useAiSettingsStore } from "@/features/chat/store";
import { useAiGate } from "@/features/ai-policy/useAiGate";
import {
  personaDefsForLang,
  personaRequiresTargetProfile,
  personasForLang,
} from "@/features/post-effect/pseudoCommentPayloadBuilder";
import { fetchProjectContext } from "@/features/project/contextAtoms";
import { useCurrentProject } from "@/features/project/projectStore";
import { usePseudoCommentRun } from "./usePseudoCommentRun";

interface Props {
  /** 実行完了時に呼ぶ。CommentsTab の annotation-only reload を渡す。 */
  onCompleted: () => Promise<void> | void;
}

/**
 * 疑似コメント（読者ペルソナによる本文横コメント）の実行導線。
 * ペルソナ選択 + 生成ボタンのみを持つ薄いヘッダ部品で、CommentsTab のヘッダに置く。
 * スレッド表示は CommentsTab が一元的に行うため、このコンポーネントは持たない
 * （旧 CurrentScenePseudoCommentView から実行部分だけを切り出したもの）。
 * 対象は常にアクティブシーン。シーン未選択時は生成ボタンを無効化する。
 */
export function PseudoCommentRunControl({ onCompleted }: Props) {
  const { t } = useTranslation();
  // project 言語で読者ペルソナ集合 (ja/en) と校閲プロンプトを切替える。
  const lang = useCurrentProject()?.language ?? "ja";
  const personaDefs = personaDefsForLang(lang);
  const personas = personasForLang(lang);
  // 対象は常にアクティブシーン。activeSceneId は string 既定("")なので falsy 判定。
  const sceneId = useTreeStore((s) => s.activeSceneId);
  const [persona, setPersona] = useState<string>(personas[0]);
  // genre は全ペルソナの brief に、targetReaders は「ターゲット読者層」ペルソナの
  // 実体として注入する。targetReaders 空のとき同ペルソナは選択不可にする。
  const [genre, setGenre] = useState<string | null>(null);
  const [targetReaders, setTargetReaders] = useState<string | null>(null);
  const analysisGate = useAiGate("analysis");
  // 実行ロジック（payload 構築〜invoke〜完了後の scene 反映）はフックへ委譲。
  const { running, run } = usePseudoCommentRun({
    sceneId,
    persona,
    genre,
    targetReaders,
    lang,
    onCompleted,
  });

  useEffect(() => {
    if (!useAiSettingsStore.getState().settings) {
      void useAiSettingsStore.getState().loadSettings();
    }
  }, []);

  // genre / 想定読者プロフィールを取得 (ペルソナ brief 注入 + ターゲット読者層の
  // 選択可否判定)。project 単位の値なのでマウント時に 1 度だけ取る。
  useEffect(() => {
    let cancelled = false;
    void fetchProjectContext().then((ctx) => {
      if (cancelled) return;
      setGenre(ctx?.genre ?? null);
      setTargetReaders(ctx?.targetReaders ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const hasTargetProfile = Boolean(targetReaders?.trim());

  // 選択中ペルソナが (a) 現在の言語のペルソナ集合に存在しない (lang 切替) か、
  // (b) プロフィール必須かつ未設定 になったら、その言語の先頭ペルソナへ戻す。
  // 判定はレジストリ (personaDefsForLang) を単一の真実源にする。
  useEffect(() => {
    const list = personasForLang(lang);
    if (
      !list.includes(persona) ||
      (!hasTargetProfile && personaRequiresTargetProfile(persona, lang))
    ) {
      setPersona(list[0]);
    }
  }, [hasTargetProfile, persona, lang]);

  const disabled =
    running || !sceneId || analysisGate.presentation !== "enabled";

  return (
    <div className="flex w-full min-w-0 items-center gap-1.5">
      <select
        value={persona}
        onChange={(e) => setPersona(e.target.value)}
        className="min-w-0 max-w-40 flex-1 truncate rounded border border-border bg-background px-1.5 py-0.5 text-xs outline-none"
      >
        {personaDefs.map((d) => {
          const locked = Boolean(d.requiresTargetProfile) && !hasTargetProfile;
          return (
            <option
              key={d.label}
              value={d.label}
              disabled={locked}
              title={
                locked
                  ? t("kouetsu.pseudoComment.targetProfileRequired")
                  : undefined
              }
            >
              {locked
                ? `${d.label}${t("kouetsu.pseudoComment.requiresTargetProfile")}`
                : d.label}
            </option>
          );
        })}
      </select>
      {/* analysis がポリシーで OFF のときは生成ボタンを隠す（ペルソナ選択は残す）。 */}
      {analysisGate.presentation !== "hidden" && (
        <button
          type="button"
          disabled={disabled}
          title={
            !sceneId
              ? t("kouetsu.selectScene")
              : (analysisGate.tooltip ?? t("kouetsu.pseudoComment.runTooltip"))
          }
          onClick={() => void run()}
          className={cn(
            "flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-2 py-0.5 text-xs",
            "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {running ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Sparkles size={12} />
          )}
          <span>{t("kouetsu.pseudoComment.generateButton")}</span>
        </button>
      )}
    </div>
  );
}
