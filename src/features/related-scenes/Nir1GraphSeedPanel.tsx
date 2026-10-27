import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { upsertScenePin } from "@/features/codex/sceneCodexPinsApi";
import { Nir1GraphText, nir1GraphDisplayText } from "./Nir1GraphPathEvidence";
import { selectNir1GraphSeed } from "./nir1GraphSeed";
import {
  readNir1GraphSeedEntryName,
  selectNir1GraphSeedCandidates,
  type Nir1GraphSeedCandidate,
  type Nir1GraphSeedCandidateReason,
} from "./nir1GraphSeedCandidates";
import { ensureNir1GraphTranslations } from "./nir1GraphTranslations";

ensureNir1GraphTranslations();

type SeedView =
  | { readonly kind: "seed"; readonly name: string | null }
  | {
      readonly kind: "candidates";
      readonly candidates: readonly Nir1GraphSeedCandidate[];
    }
  // The Scene is not a live scene of the project (archived, missing): nothing
  // to offer, and no "pin it in the Matrix" hint either (DR-SEEDSUG-2).
  | { readonly kind: "none" };

const REASON_KEY: Record<Nir1GraphSeedCandidateReason, string> = {
  pov: "relatedScenes.graph.seedReasonPov",
  "beat-actor": "relatedScenes.graph.seedReasonBeatActor",
  body: "relatedScenes.graph.seedReasonBody",
};

interface Props {
  readonly projectId: string;
  readonly sceneId: string;
  /** 表示中の問い合わせの世代。新しい問い合わせごとに読み直す（前の表示は残す）。 */
  readonly queryGeneration: number;
  /**
   * pin を書けた後（この panel が外れた後でも呼ぶ）。Related Scenes は、active な
   * Scene がまだ `sceneId` ならこの seed で問い合わせ直す（DR-SEEDSUG-3）。
   */
  readonly onPinned: (sceneId: string) => void;
}

/**
 * Graph 節の起点の表示と、起点の候補（DR-SEEDSUG-1〜3）。lazy chunk で、
 * `NIR1_GRAPH_UI_ENABLED` が on のときだけ Related Scenes が要求する。
 *
 * 起点は `selectNir1GraphSeed`（hook が begin に渡すのと同じ関数）で決める。起点が
 * 無いときだけ候補を読む（読むだけで保存しない）。pin は作者がボタンを押したときだけ
 * 既存の `upsertScenePin` で書く。読めなければ何も描かない（Raw／IR の行は変わらない）。
 */
export default function Nir1GraphSeedPanel({
  projectId,
  sceneId,
  queryGeneration,
  onPinned,
}: Props) {
  const { t } = useTranslation();
  const headingId = useId();
  const key = `${projectId}\u0000${sceneId}`;
  const [view, setView] = useState<{
    readonly key: string;
    readonly view: SeedView;
  } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    const read = async (): Promise<SeedView> => {
      const seed = await selectNir1GraphSeed(projectId, sceneId);
      if (seed !== null)
        return {
          kind: "seed",
          name: await readNir1GraphSeedEntryName(projectId, seed),
        };
      const candidates = await selectNir1GraphSeedCandidates(
        projectId,
        sceneId,
      );
      return candidates === null
        ? { kind: "none" }
        : { kind: "candidates", candidates };
    };
    read().then(
      (value) => {
        if (live) setView({ key, view: value });
      },
      () => {
        // A fixed outcome only: nothing is drawn, nothing is logged.
        if (live) setView(null);
      },
    );
    return () => {
      live = false;
    };
  }, [key, projectId, sceneId, queryGeneration]);

  if (view === null || view.key !== key) return null;
  const shown = view.view;
  if (shown.kind === "none") return null;
  if (shown.kind === "seed")
    return shown.name === null ? null : (
      <p
        data-testid="nir1-graph-seed"
        className="flex min-w-0 gap-1 px-3 py-1 text-[11px] text-muted-foreground"
      >
        <span className="shrink-0">{t("relatedScenes.graph.seedLabel")}</span>
        <Nir1GraphText
          value={shown.name}
          className="min-w-0 truncate text-foreground"
        />
      </p>
    );

  const pinAsSeed = (entryId: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const target = sceneId;
    const at = key;
    setPending(entryId);
    setFailedKey(null);
    upsertScenePin(target, entryId).then(
      () => {
        inFlight.current = false;
        // Only this panel's own state stops with it: the query may have reset
        // (and unmounted the panel) while the pin was written, and still has to
        // run again with the new seed (the parent checks the active Scene).
        if (mounted.current) setPending(null);
        onPinned(target);
      },
      () => {
        inFlight.current = false;
        if (!mounted.current) return;
        setPending(null);
        setFailedKey(at);
      },
    );
  };

  return (
    <div
      role="group"
      aria-labelledby={headingId}
      data-testid="nir1-graph-seed-candidates"
      className="px-3 py-2 text-[11px]"
    >
      <p id={headingId} className="font-medium text-foreground">
        {t("relatedScenes.graph.seedCandidatesHeading")}
      </p>
      {shown.candidates.length === 0 ? (
        <p className="mt-0.5 text-muted-foreground">
          {t("relatedScenes.graph.seedNone")}
        </p>
      ) : (
        <>
          <p className="mt-0.5 text-muted-foreground">
            {t("relatedScenes.graph.seedCandidatesHint")}
          </p>
          <ul className="mt-1 flex flex-col gap-1">
            {shown.candidates.map((candidate) => (
              <li
                key={candidate.entryId}
                data-testid="nir1-graph-seed-candidate"
                data-nir1-seed-reason={candidate.reason}
                className="flex min-w-0 items-center gap-2"
              >
                <Nir1GraphText
                  value={candidate.name}
                  className="min-w-0 flex-1 truncate text-foreground"
                />
                <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                  {t(REASON_KEY[candidate.reason])}
                </span>
                <button
                  type="button"
                  data-testid="nir1-graph-seed-use"
                  aria-label={t("relatedScenes.graph.seedUseLabel", {
                    name: nir1GraphDisplayText(candidate.name),
                  })}
                  aria-busy={pending === candidate.entryId || undefined}
                  // Not `disabled`: the focus stays on the button while the pin is
                  // written and after a failure (DR-SEEDSUG-3). `inFlight` stops
                  // a second write.
                  aria-disabled={pending !== null || undefined}
                  onClick={() => pinAsSeed(candidate.entryId)}
                  className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-primary hover:bg-primary/10 aria-disabled:cursor-default aria-disabled:opacity-50"
                >
                  {t("relatedScenes.graph.seedUse")}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {failedKey === key && (
        <p
          role="alert"
          data-testid="nir1-graph-seed-pin-failed"
          className="mt-1 text-destructive"
        >
          {t("relatedScenes.graph.seedPinFailed")}
        </p>
      )}
    </div>
  );
}
