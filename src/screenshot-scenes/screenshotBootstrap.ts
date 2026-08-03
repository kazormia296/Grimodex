/**
 * LP / マーケ用の Playwright 撮影ステージ向けに、データをロードし UI 状態を整える。
 */
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useKouetsuStore } from "@/features/kouetsu/kouetsuStore";
import { useLintStore } from "@/features/lint/lintStore";
import type { PanelId } from "@/features/layout/panelIds";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { useTrashBinStore } from "@/features/trash-bin/trashBinStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { useAttributionStore } from "@/features/attribution/attributionStore";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { getScreenshotLanguage } from "./screenshotMode";
import { SCREENSHOT_SEED_CONTENT } from "./screenshotSeedContent";

export function getScreenshotCaptureId(): string | null {
  try {
    return localStorage.getItem("grimodex:screenshot-capture");
  } catch {
    return null;
  }
}

export function getScreenshotPanelId(): PanelId | null {
  try {
    return localStorage.getItem("grimodex:screenshot-panel") as PanelId | null;
  } catch {
    return null;
  }
}

export function getScreenshotPresetId(): string {
  try {
    return (
      localStorage.getItem("grimodex:screenshot-preset") ?? "builtin:default"
    );
  } catch {
    return "builtin:default";
  }
}

export function isScreenshotCapture(): boolean {
  return Boolean(getScreenshotCaptureId());
}

/**
 * Sidebar が無いレイアウトでは loadTree が呼ばれないため、
 * 撮影時はエディタ起動直後に一元ロードする。
 */
export async function bootstrapScreenshotWorkspace(): Promise<void> {
  const projectId = getCurrentProjectId();
  useTrashBinStore.getState().resetForProject(projectId);
  await useTreeStore.getState().loadTree(projectId);
  await useCodexStore.getState().loadEntries();
  await useSnippetStore.getState().loadEntries();
  await useTrashBinStore.getState().loadItems(projectId);
}

export function markScreenshotStageReady(): void {
  if (typeof document === "undefined") return;
  document.body.dataset.screenshotReady = "true";
}

export function clearScreenshotStageReady(): void {
  if (typeof document === "undefined") return;
  delete document.body.dataset.screenshotReady;
}

/**
 * プリセット／パネルに応じて選択・Lit／校閲デモ状態を適用する。
 */
export function applyScreenshotUiState(): void {
  if (!getScreenshotCaptureId()) return;

  const panelId = getScreenshotPanelId();
  const presetId = getScreenshotPresetId();

  useTreeStore.getState().setActiveScene("scene-1");

  const presetWantsCodexAkahimo =
    presetId === "builtin:default" ||
    presetId === "builtin:plan" ||
    presetId === "builtin:chat-main" ||
    presetId === "builtin:codex-main" ||
    presetId === "builtin:review";

  const panelWantsCodexAkahimo =
    panelId === "codex" || panelId === "codex-quick";

  if (presetWantsCodexAkahimo || panelWantsCodexAkahimo) {
    useCodexStore.getState().requestSelectEntry("codex-akahimo");
  }

  if (panelId === "snippets") {
    useSnippetStore.getState().requestSelectEntry("snippet-akahimo-reunion");
  }

  // 単体 attribution パネル時はエディタが無いので「シーン」帰属は計算できない → プロジェクト一覧を表示
  if (panelId === "attribution") {
    useAttributionStore.getState().setScope("project");
  }

  const needsKouetsuDemo =
    presetId === "builtin:review" || panelId === "kouetsu";

  if (!needsKouetsuDemo) return;

  const now = new Date().toISOString();
  const c = SCREENSHOT_SEED_CONTENT[getScreenshotLanguage()];
  const { lint, annotations } = c;
  useKouetsuStore.setState({
    activeTab: "issues",
    scope: { type: "scene" },
    statusFilter: "open",
  });
  const lintDiagnostics = [
    {
      rule_id: lint.diag1.ruleId,
      severity: "warning" as const,
      message: lint.diag1.message,
      range: { start: lint.diag1.rangeStart, end: lint.diag1.rangeEnd },
      fix: {
        label: lint.diag1.fixLabel,
        replacement: lint.diag1.fixReplacement,
        range: { start: lint.diag1.rangeStart, end: lint.diag1.rangeEnd },
      },
    },
    {
      rule_id: lint.diag2.ruleId,
      severity: "error" as const,
      message: lint.diag2.message,
      range: { start: lint.diag2.rangeStart, end: lint.diag2.rangeEnd },
    },
  ];
  useLintStore.setState({
    currentSceneId: "scene-1",
    rawDiagnostics: lintDiagnostics,
    diagnostics: lintDiagnostics,
    lastSceneText: lint.lastSceneText,
    isLinting: false,
    lastErrorMessage: null,
  });
  const compassDry = annotations.compassDry;
  useAnnotationStore.getState().setAnnotations("scene-1", [
    {
      id: "ann-akahimo-wet",
      projectId: getCurrentProjectId(),
      runId: "run-screenshot-kouetsu",
      anchorType: "scene_range",
      sceneId: "scene-1",
      rangeStart: compassDry.rangeStart,
      rangeEnd: compassDry.rangeEnd,
      textSnapshot: compassDry.textSnapshot,
      category: "consistency_anchor",
      persona: compassDry.persona,
      severity: "error",
      content: compassDry.content,
      authorRole: "ai",
      parentId: null,
      status: "open",
      metadata: JSON.stringify({
        codex_ref: {
          entry_id: "codex-akahimo",
          entry_name: compassDry.entryName,
          source_field: "content",
          expected_value: compassDry.expectedValue,
          found_value: compassDry.foundValue,
          found_text: compassDry.foundText,
          found_context: compassDry.foundContext,
          confidence: "high",
          llm_reason: compassDry.llmReason,
          dismiss_key: compassDry.dismissKey,
          detected_by_model: "qwen3:30b",
        },
      }),
      createdAt: now,
      updatedAt: now,
    },
  ]);
}
