import { useTranslation } from "react-i18next";
import type { SaggyRun, TensionPoint } from "./tensionSeries";

interface Props {
  series: TensionPoint[];
  saggy: SaggyRun[];
  onSelectScene: (sceneId: string) => void;
}

const W = 100;
const H = 40;
const PAD = 2;

function xFor(i: number, n: number): number {
  if (n <= 1) return W / 2;
  return PAD + (i * (W - 2 * PAD)) / (n - 1);
}
function yFor(t: number): number {
  return H - PAD - t * (H - 2 * PAD);
}

export function TensionCurve({ series, saggy, onSelectScene }: Props) {
  const { t } = useTranslation();
  const n = series.length;

  const segments: string[] = [];
  let cur: string[] = [];
  series.forEach((p, i) => {
    if (p.tension === null) {
      if (cur.length > 1) segments.push(cur.join(" "));
      cur = [];
    } else {
      cur.push(`${xFor(i, n).toFixed(2)},${yFor(p.tension).toFixed(2)}`);
    }
  });
  if (cur.length > 1) segments.push(cur.join(" "));

  return (
    <div className="rounded border border-border p-2">
      <div className="mb-1 text-[10px] font-medium text-muted-foreground">
        {t("kouetsu.tension.title")}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-20 w-full"
        role="img"
        aria-label={t("kouetsu.tension.title")}
      >
        {saggy.map((run, idx) => {
          const x0 = xFor(run.startIdx, n);
          const x1 = xFor(run.endIdx, n);
          return (
            <rect
              key={`sag-${idx}`}
              data-testid={`tension-saggy-${idx}`}
              x={x0}
              y={PAD}
              width={Math.max(0.5, x1 - x0)}
              height={H - 2 * PAD}
              className="fill-yellow-500/10"
            />
          );
        })}
        {series.map((p, i) =>
          p.isChapterEnd && i < n - 1 ? (
            <line
              key={`div-${p.sceneId}`}
              x1={(xFor(i, n) + xFor(i + 1, n)) / 2}
              x2={(xFor(i, n) + xFor(i + 1, n)) / 2}
              y1={PAD}
              y2={H - PAD}
              className="stroke-border"
              strokeWidth={0.3}
              strokeDasharray="1 1"
            />
          ) : null,
        )}
        {segments.map((pts, i) => (
          <polyline
            key={`seg-${i}`}
            points={pts}
            className="fill-none stroke-primary"
            strokeWidth={0.6}
          />
        ))}
        {series.map((p, i) =>
          p.tension === null ? null : (
            <g key={p.sceneId}>
              {p.isChapterEnd && (
                <circle
                  data-testid={`tension-chapterend-${p.sceneId}`}
                  cx={xFor(i, n)}
                  cy={yFor(p.tension)}
                  r={1.6}
                  className={
                    p.tension >= 0.6 ? "fill-orange-500" : "fill-sky-500"
                  }
                />
              )}
              <circle
                data-testid={`tension-point-${p.sceneId}`}
                cx={xFor(i, n)}
                cy={yFor(p.tension)}
                r={1}
                className="cursor-pointer fill-primary hover:fill-primary/70"
                onClick={() => onSelectScene(p.sceneId)}
              >
                <title>{`${p.title}: ${p.tension.toFixed(2)}`}</title>
              </circle>
            </g>
          ),
        )}
      </svg>
      <div className="mt-0.5 flex gap-2 text-[9px] text-muted-foreground">
        <span>{t("kouetsu.tension.saggy")}</span>
        <span>{t("kouetsu.tension.chapterHook")}</span>
      </div>
    </div>
  );
}
