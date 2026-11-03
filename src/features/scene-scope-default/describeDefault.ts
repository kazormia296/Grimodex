/**
 * Display names of Scope refs and of a project default (rev2 §7.2;
 * PR-2 review P2-1/P2-2). A ref is stored as written and never translated;
 * only the known main-line refs get a display name. A default is described by
 * its actual value, so a default outside the main line is never called "main
 * line".
 */
import { MAIN_LINE_REFS, type ScopeDefaultAxes } from "@/lib/sceneScopeDefault";
// Registers this feature's lazy strings (DR-SDEF-52).
import "./sceneScopeDefaultTranslations";

type Translate = (key: string, options?: Record<string, unknown>) => string;

const KNOWN_REF_LABELS: Record<string, string> = {
  [MAIN_LINE_REFS.timeline]: "editor.sceneDetail.refTimelineMain",
  [MAIN_LINE_REFS.worldline]: "editor.sceneDetail.refWorldlinePrime",
  [MAIN_LINE_REFS.narrativeLayer]: "editor.sceneDetail.refLayerManuscript",
};

export function scopeRefLabel(ref: string, t: Translate): string {
  const key = Object.hasOwn(KNOWN_REF_LABELS, ref)
    ? KNOWN_REF_LABELS[ref]
    : undefined;
  return key ? t(key) : ref;
}

export function isMainLineAxes(axes: {
  timeline: { kind: string; ref?: string };
  worldline: { kind: string; ref?: string };
  narrativeLayer: { kind: string; ref?: string };
}): boolean {
  return (
    axes.timeline.kind === "exact" &&
    axes.timeline.ref === MAIN_LINE_REFS.timeline &&
    axes.worldline.kind === "exact" &&
    axes.worldline.ref === MAIN_LINE_REFS.worldline &&
    axes.narrativeLayer.kind === "exact" &&
    axes.narrativeLayer.ref === MAIN_LINE_REFS.narrativeLayer
  );
}

/** "本筋" for the main line; otherwise the three axes as written. */
export function describeScopeDefault(
  axes: ScopeDefaultAxes,
  t: Translate,
): string {
  if (isMainLineAxes(axes)) return t("settings.project.sceneScopeMainLine");
  return [axes.timeline, axes.worldline, axes.narrativeLayer]
    .map((axis) => scopeRefLabel(axis.ref, t))
    .join(" / ");
}
