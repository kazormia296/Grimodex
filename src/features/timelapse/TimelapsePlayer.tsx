import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, ShieldCheck, ShieldAlert } from "lucide-react";
import type { ChangeEvent } from "@/db/schema";
import { useCurrentProjectId } from "@/features/project/projectStore";
import { loadProjectChangeEvents } from "./queryEvents";
import type { Domain } from "./recorder";
import { verifyChain, type VerifyResult } from "./hashChain";

// Kept in sync with the canonical `Domain` union in recorder.ts. The
// `satisfies readonly Domain[]` check makes tsc fail if a stale/invalid name is
// left here (element must be a Domain); new members should be appended.
const ALL_DOMAINS = [
  "editor",
  "codex",
  "snippet",
  "grid",
  "map",
  "synopsis",
  "intent",
  "beat",
  "chat",
  "layout",
  "event",
  "plot",
  "foreshadow",
  "review",
  "labels",
  "abtest",
  "prompt",
  "import",
  "mount",
  "trash",
  "settings",
  "project",
  "lint",
  "attribution",
  "revision",
  "prose",
] as const satisfies readonly Domain[];

/**
 * 執筆タイムラプス Player (P5 minimum-viable).
 *
 * Goals for this surface:
 * - Verify the chain on demand so users can self-attest "log is contiguous".
 * - Let the user scrub through the recorded event list and inspect each
 *   event's domain/op/payload.
 * - Filter by domain to focus on Editor / Map / Grid etc.
 *
 * Full visual playback (Editor canvas re-render through replayEngine, Map
 * frame-by-frame, AuthorshipMark overlay) is deferred to P7 — this surface
 * keeps the player data-driven so we can wire those renderers later without
 * reshaping the UI.
 */
export function TimelapsePlayer() {
  const { t } = useTranslation();
  const projectId = useCurrentProjectId();
  const [events, setEvents] = useState<ChangeEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [enabledDomains, setEnabledDomains] = useState<Set<Domain>>(
    new Set(ALL_DOMAINS),
  );
  const [position, setPosition] = useState(0);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);

  const reload = useCallback(async () => {
    if (!projectId) return;
    setIsLoading(true);
    setVerifyResult(null);
    try {
      const rows = await loadProjectChangeEvents(projectId);
      setEvents(rows);
      setPosition(rows.length);
    } catch (e) {
      console.error("[timelapse] load failed", e);
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const visibleEvents = useMemo(
    () => events.filter((ev) => enabledDomains.has(ev.domain as Domain)),
    [events, enabledDomains],
  );

  const cursor = Math.min(position, visibleEvents.length);
  const currentEvent = cursor > 0 ? visibleEvents[cursor - 1] : null;

  const toggleDomain = (d: Domain) => {
    setEnabledDomains((prev) => {
      const next = new Set(prev);
      if (next.has(d)) next.delete(d);
      else next.add(d);
      return next;
    });
  };

  const runVerify = useCallback(async () => {
    if (events.length === 0) {
      setVerifyResult({ ok: true });
      return;
    }
    const r = await verifyChain(events);
    setVerifyResult(r);
  }, [events]);

  return (
    <div
      className="flex h-full flex-col gap-3 p-3"
      data-testid="timelapse-player"
    >
      <header className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t("timelapse.title")}</h3>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={runVerify}
            disabled={isLoading || events.length === 0}
            className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
            title={t("timelapse.verifyTitle")}
          >
            {verifyResult?.ok === false ? (
              <ShieldAlert className="h-3 w-3 text-destructive" />
            ) : (
              <ShieldCheck className="h-3 w-3" />
            )}
            {t("timelapse.verify")}
          </button>
          <button
            type="button"
            onClick={reload}
            disabled={isLoading}
            className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3 w-3 ${isLoading ? "animate-spin" : ""}`}
            />
            {t("timelapse.refresh")}
          </button>
        </div>
      </header>

      {verifyResult && (
        <div
          className={`rounded px-2 py-1 text-xs ${
            verifyResult.ok
              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : "bg-destructive/10 text-destructive"
          }`}
          role="status"
        >
          {verifyResult.ok
            ? t("timelapse.verifyOk", { count: events.length })
            : t("timelapse.verifyBroken", {
                seq: verifyResult.brokenAt ?? 0,
                reason: verifyResult.reason ?? "",
              })}
        </div>
      )}

      <div className="flex flex-wrap gap-1">
        {ALL_DOMAINS.map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => toggleDomain(d)}
            className={`rounded px-2 py-0.5 text-xs transition-colors ${
              enabledDomains.has(d)
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent"
            }`}
            data-testid={`timelapse-filter-${d}`}
          >
            {d}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="tabular-nums w-16">
          {cursor} / {visibleEvents.length}
        </span>
        <input
          type="range"
          min={0}
          max={visibleEvents.length}
          value={cursor}
          onChange={(e) => setPosition(Number(e.target.value))}
          className="flex-1"
          aria-label={t("timelapse.scrub")}
          data-testid="timelapse-scrubber"
        />
      </div>

      <div className="flex-1 overflow-auto rounded border border-border bg-background/30">
        {currentEvent ? (
          <div className="p-2 text-xs font-mono whitespace-pre-wrap break-all">
            <div>
              <span className="text-muted-foreground">seq:</span>{" "}
              {currentEvent.sequence}
            </div>
            <div>
              <span className="text-muted-foreground">timestamp:</span>{" "}
              {new Date(currentEvent.timestamp).toISOString()}
            </div>
            <div>
              <span className="text-muted-foreground">domain:</span>{" "}
              {currentEvent.domain}
            </div>
            <div>
              <span className="text-muted-foreground">opType:</span>{" "}
              {currentEvent.opType}
            </div>
            <div>
              <span className="text-muted-foreground">entityId:</span>{" "}
              {currentEvent.entityId ?? "—"}
            </div>
            <div className="mt-1">
              <span className="text-muted-foreground">payload:</span>
            </div>
            <pre className="mt-0.5 max-h-48 overflow-auto rounded bg-muted/60 p-1">
              {prettyPrint(currentEvent.payload)}
            </pre>
          </div>
        ) : (
          <p className="p-3 text-xs text-muted-foreground">
            {events.length === 0
              ? t("timelapse.noEvents")
              : t("timelapse.scrubHint")}
          </p>
        )}
      </div>
    </div>
  );
}

function prettyPrint(payload: string): string {
  try {
    return JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    return payload;
  }
}
