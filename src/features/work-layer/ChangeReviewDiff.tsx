import { useTranslation } from "react-i18next";

const LABEL_CLASS =
  "border-t border-border py-2 pr-3 text-left align-top font-mono text-[8px] font-normal uppercase tracking-[0.12em] text-muted-foreground";
const VALUE_CLASS = "border-t border-border px-3 py-2 align-top text-xs";

export function ChangeReviewDiff() {
  const { t } = useTranslation();

  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[35rem] border-collapse text-left">
        <caption className="sr-only">
          {t("workLayer.review.diffCaption", "V1とV2のフィールド別差分")}
        </caption>
        <thead>
          <tr>
            <th scope="col" className="w-20 pb-2" />
            <th
              scope="col"
              className="pb-2 pr-3 font-mono text-[8px] font-normal tracking-[0.12em] text-muted-foreground"
            >
              {t("workLayer.review.versions.accepted", "承認済み · V1")}
            </th>
            <th
              scope="col"
              className="pb-2 pl-3 font-mono text-[8px] tracking-[0.12em]"
            >
              {t("workLayer.review.versions.proposal", "PROPOSAL · V2")}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row" className={LABEL_CLASS}>
              {t("workLayer.review.fields.title", "タイトル")}
            </th>
            <td className={`${VALUE_CLASS} text-muted-foreground`}>
              {t("workLayer.review.values.title", "脱獄")}
            </td>
            <td className={`${VALUE_CLASS} text-muted-foreground`}>
              {t("workLayer.review.values.title", "脱獄")}{" "}
              <span className="font-mono text-[8px] tracking-[0.08em] opacity-60">
                {t("workLayer.review.unchanged", "変更なし")}
              </span>
            </td>
          </tr>
          <tr>
            <th scope="row" className={LABEL_CLASS}>
              {t("workLayer.review.fields.method", "手段")}
            </th>
            <td className={VALUE_CLASS}>
              <del className="text-muted-foreground">
                {t(
                  "workLayer.review.values.methodOld",
                  "青い剣で錠を斬り、牢を破る",
                )}
              </del>
            </td>
            <td className={VALUE_CLASS}>
              <span
                data-change-bar="true"
                className="inline-block border-l-[3px] border-foreground pl-2 font-medium"
              >
                {t(
                  "workLayer.review.values.methodNew",
                  "拾った鍵で錠を開け、牢を出る",
                )}
              </span>
            </td>
          </tr>
          <tr>
            <th scope="row" className={LABEL_CLASS}>
              {t("workLayer.review.fields.period", "時期")}
            </th>
            <td className={`${VALUE_CLASS} text-muted-foreground`}>
              {t("workLayer.review.values.period", "3年霜月 · 確定")}
            </td>
            <td className={`${VALUE_CLASS} text-muted-foreground`}>
              {t("workLayer.review.values.period", "3年霜月 · 確定")}{" "}
              <span className="font-mono text-[8px] tracking-[0.08em] opacity-60">
                {t("workLayer.review.unchanged", "変更なし")}
              </span>
            </td>
          </tr>
          <tr>
            <th scope="row" className={LABEL_CLASS}>
              {t("workLayer.review.fields.notes", "補足")}
            </th>
            <td className={VALUE_CLASS}>
              <del className="text-muted-foreground">
                {t(
                  "workLayer.review.values.notesOld",
                  "剣の呪いが解けたことを示す",
                )}
              </del>
            </td>
            <td className={`${VALUE_CLASS} text-muted-foreground`}>
              —{" "}
              <span className="rounded-sm border border-foreground/30 px-1 py-0.5 font-mono text-[8px] tracking-[0.1em]">
                {t("workLayer.review.removed", "REMOVED")}
              </span>
            </td>
          </tr>
          <tr>
            <th scope="row" className={LABEL_CLASS}>
              EVIDENCE
            </th>
            <td className={VALUE_CLASS}>
              <span className="font-serif text-muted-foreground">
                {t(
                  "workLayer.review.evidence.oldExcerpt",
                  "「彼女は青い剣を鞘から抜いた」",
                )}
              </span>
              <span className="mt-1 block font-mono text-[8px] font-bold tracking-[0.1em]">
                {t("workLayer.review.evidence.missing", "MISSING")}
              </span>
              <span className="font-mono text-[8px] text-muted-foreground">
                {t("workLayer.review.evidence.oldAnchor", "v48 に一致なし")}
              </span>
            </td>
            <td className={VALUE_CLASS}>
              <span className="font-serif">
                {t(
                  "workLayer.review.evidence.newExcerpt",
                  "「アリスは鍵を拾い、地下牢を出た」",
                )}
              </span>
              <span className="mt-1 block font-mono text-[8px] tracking-[0.1em] text-muted-foreground">
                {t("workLayer.review.evidence.newAnchor", "¶2 · ANCHORED")}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
