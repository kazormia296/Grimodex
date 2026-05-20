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

const PROJECT_ID = "default-project";

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
  await useTreeStore.getState().loadTree(PROJECT_ID);
  await useCodexStore.getState().loadEntries();
  await useSnippetStore.getState().loadEntries();
  await useTrashBinStore.getState().loadItems(PROJECT_ID);
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
  useKouetsuStore.setState({
    activeTab: "issues",
    activeIssuesScope: "current",
  });
  useLintStore.setState({
    currentSceneId: "scene-1",
    rawDiagnostics: [
      {
        rule_id: "ja/sentence-too-long",
        severity: "warning",
        message: "一文が長く、情景と行動が同じ段落に詰まっています",
        range: { start: 28, end: 86 },
        fix: {
          label: "二文に分ける",
          replacement:
            "廃社は思っていたより小さかった。記憶の中では鬱蒼とした杉に囲まれていた。",
          range: { start: 28, end: 86 },
        },
      },
      {
        rule_id: "ja/ambiguous-subject",
        severity: "error",
        message: "記憶が誰のものか、直前の文だけでは曖昧です",
        range: { start: 148, end: 166 },
      },
    ],
    diagnostics: [
      {
        rule_id: "ja/sentence-too-long",
        severity: "warning",
        message: "一文が長く、情景と行動が同じ段落に詰まっています",
        range: { start: 28, end: 86 },
        fix: {
          label: "二文に分ける",
          replacement:
            "廃社は思っていたより小さかった。記憶の中では鬱蒼とした杉に囲まれていた。",
          range: { start: 28, end: 86 },
        },
      },
      {
        rule_id: "ja/ambiguous-subject",
        severity: "error",
        message: "記憶が誰のものか、直前の文だけでは曖昧です",
        range: { start: 148, end: 166 },
      },
    ],
    lastSceneText:
      "朱音は鳥居の手前で立ち止まった。十年ぶりだった。廃社は思っていたより小さかった。祭壇の奥に、赤いものがあった。朱紐だった。",
    isLinting: false,
    lastErrorMessage: null,
  });
  useAnnotationStore.getState().setAnnotations("scene-1", [
    {
      id: "ann-akahimo-wet",
      projectId: "default-project",
      runId: "run-screenshot-kouetsu",
      anchorType: "scene_range",
      sceneId: "scene-1",
      rangeStart: 130,
      rangeEnd: 150,
      textSnapshot: "朱紐は乾いていた",
      category: "consistency_anchor",
      persona: "整合性チェック",
      severity: "error",
      content:
        "Codexでは朱紐は雨に濡れると墨のように黒ずむ設定ですが、このシーンでは雨ざらしのまま乾いています。",
      authorRole: "ai",
      parentId: null,
      status: "open",
      metadata: JSON.stringify({
        codex_ref: {
          entry_id: "codex-akahimo",
          entry_name: "朱紐",
          source_field: "content",
          expected_value: "雨に濡れると黒ずむ",
          found_value: "雨ざらしでも乾いている",
          found_text: "朱紐は乾いていた",
          found_context:
            "朱紐は乾いていた。雨ざらしのはずなのに、濡れていなかった。",
          confidence: "high",
          llm_reason:
            "物理的な状態が設定と逆になっており、読者が意図的な異常かミスか判別できないため。",
          dismiss_key: "codex-akahimo:wetness:scene-1",
          detected_by_model: "openrouter/anthropic/claude-sonnet-4.6",
        },
      }),
      createdAt: now,
      updatedAt: now,
    },
  ]);
}
