/**
 * 実際のヘッダー（EditorWorkspaceHeader）の左レールの実寸（実 Chromium）。
 *
 * ロゴ・統合メニュー・元に戻す／やり直す・書き出し、中央の WorkPulse、右レールの
 * 中身まで本物を描き、窓の幅ごとに次を確かめる。
 * - 統合メニューの名前がボタンの外に描かれず、「元に戻す」に重ならない。
 * - 左レールの中身がレールからはみ出さない。中央のスロットはヘッダーの中心。
 * - 1280px 以上（mac なし）はフォルダ名と題名の両方が最小幅以上で見える。
 * - 800／1080px はフォルダ名を隠し、題名が 21px 以上見える（クリックできる中心）。
 * - ロゴは 1680px 未満で本の記号、以上で字まで。どちらも自然な寸法のまま。
 *
 * happy-dom は flex の実寸も container query も media query も計算しない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { page, userEvent } from "vitest/browser";
import { EditorWorkspaceHeader } from "./EditorWorkspaceHeader";
import { WorkLayerProvider } from "@/features/work-layer/WorkLayerContext";
import { WORK_LAYER_FIXTURE } from "@/features/work-layer/workLayerFixture";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useProjectStore } from "@/features/project/projectStore";
import { PROJECT_ID } from "@/features/project/constants";
import type { Project } from "@/features/project/api";
import type { RuntimeCapabilities } from "@/runtime/runtimeCapabilities";

// 右レールの WindowControls は Electron／Tauri でだけ描かれる。Electron として
// 描かせ、窓の操作（IPC）だけを止める。
vi.mock("@/lib/shell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/shell")>()),
  isElectron: () => true,
}));
vi.mock("@/lib/windowControls", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/windowControls")>()),
  isWindowMaximized: async () => false,
  onWindowResized: async () => () => {},
}));

const CAPABILITIES = {
  localFileImport: true,
  genericProjectTransfer: true,
} as RuntimeCapabilities;

const WIDTHS = [800, 1080, 1280, 1440, 1680, 1920] as const;
const LOGO_HEIGHT = 24;
const FULL_LOGO_WIDTH = (LOGO_HEIGHT * 47.95644) / 8.269779;
const MARK_LOGO_WIDTH = (LOGO_HEIGHT * 9.6) / 8.269779;

const NAMES = {
  long: {
    folder: "長編シリーズ_2026秋_改稿用フォルダ",
    title: "異世界で始める魔導書の修復師 第二部 王都崩壊編の別案と没シーン集",
  },
  short: { folder: "短編", title: "番外編" },
} as const;

function setNames(folder: string, title: string) {
  useWorkspaceStore.setState({ activeWorkspaceName: folder });
  useProjectStore.setState({
    currentProjectId: PROJECT_ID,
    projects: [{ id: PROJECT_ID, title } as Project],
  });
}

async function renderHeader(width: number, mac: boolean) {
  await page.viewport(width, 720);
  const result = render(
    <div style={{ position: "fixed", top: 0, left: 0, width, height: 48 }}>
      <WorkLayerProvider initialModel={WORK_LAYER_FIXTURE}>
        <EditorWorkspaceHeader
          runtimeCapabilities={CAPABILITIES}
          screenshotPanelId={null}
          panelWindow={false}
          phoneWorkspace={false}
          editorZenMode={false}
          mac={mac}
          onOpenTransfer={() => {}}
          onOpenSnapshot={() => {}}
          onToggleExport={() => {}}
          onOpenSettings={() => {}}
        />
      </WorkLayerProvider>
    </div>,
  );
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  return result;
}

const em = (el: Element) => parseFloat(getComputedStyle(el).fontSize);
const shown = (el: Element) => getComputedStyle(el).display !== "none";

/** span のうち、button の矩形（overflow で切り取る範囲）の中に見えている幅。 */
function visibleWidth(span: Element, button: Element): number {
  if (!shown(span)) return 0;
  const s = span.getBoundingClientRect();
  const b = button.getBoundingClientRect();
  return Math.max(0, Math.min(s.right, b.right) - Math.max(s.left, b.left));
}

/** 実寸の読み取り。報告用の数値もここから取る。 */
function measureHeader(container: HTMLElement) {
  const q = <T extends Element = HTMLElement>(selector: string) =>
    container.querySelector<T & HTMLElement>(selector)!;
  const header = q("[data-header-bar]");
  const rail = q('[data-header-rail="left"]');
  const center = q("[data-header-center]");
  const trigger = q('[data-testid="workspace-menu-trigger"]');
  const folder = trigger.querySelector("span")!;
  const title = q('[data-testid="project-menu-trigger"]');
  const undo = q('[data-testid="history-undo"]');
  const redo = q('[data-testid="history-redo"]');
  const exportButton = q('[data-tour-target="export-button"]');
  const logo = Array.from(rail.querySelectorAll("svg")).find(shown)!;
  const railRect = rail.getBoundingClientRect();
  const railContentRight =
    railRect.right - parseFloat(getComputedStyle(rail).paddingRight);
  const headerRect = header.getBoundingClientRect();
  const centerRect = center.getBoundingClientRect();
  return {
    header,
    rail,
    trigger,
    folder,
    title,
    undo,
    redo,
    exportButton,
    logo,
    numbers: {
      railWidth: railRect.width,
      logoVariant: logo.getAttribute("data-logo-variant"),
      logoWidth: logo.getBoundingClientRect().width,
      triggerWidth: trigger.getBoundingClientRect().width,
      folderShown: shown(folder),
      folderVisible: visibleWidth(folder, trigger),
      titleVisible: visibleWidth(title, trigger),
      triggerToUndo:
        undo.getBoundingClientRect().left -
        trigger.getBoundingClientRect().right,
      railSpare: railContentRight - exportButton.getBoundingClientRect().right,
      undoWidth: undo.getBoundingClientRect().width,
      centerOffset:
        centerRect.left +
        centerRect.width / 2 -
        (headerRect.left + headerRect.width / 2),
    },
  };
}

beforeEach(() => {
  useWorkspaceStore.setState({
    activeWorkspacePath: "/work/current",
    workspaceOpenRequestInProgress: false,
    workspaceSwitchInProgress: false,
    globalSettings: null,
  });
  useProjectStore.setState({
    projectLoadStatus: "ready",
    degradedParticipants: [],
    refreshProjects: async () => {},
  });
});

afterEach(() => {
  cleanup();
});

describe("EditorWorkspaceHeader left rail (real Chromium)", () => {
  for (const mac of [false, true]) {
    for (const width of WIDTHS) {
      for (const size of ["long", "short"] as const) {
        it(`keeps the left rail inside its bounds at ${width}px (mac: ${mac}, ${size} names)`, async () => {
          setNames(NAMES[size].folder, NAMES[size].title);
          const { container } = await renderHeader(width, mac);
          const m = measureHeader(container);
          const { numbers } = m;

          // 名前は button の外に描かれない（切り取られる）。button は「元に戻す」に重ならない。
          expect(getComputedStyle(m.trigger).overflowX).toBe("hidden");
          expect(numbers.triggerToUndo).toBeGreaterThanOrEqual(-0.5);
          // 左レールの中身はレールからはみ出さない。
          expect(numbers.railSpare).toBeGreaterThanOrEqual(-0.5);
          // 中央のスロットはヘッダーの中心（HeaderBarLayout の invariant）。
          expect(Math.abs(numbers.centerOffset)).toBeLessThan(1);

          // ロゴは窓幅で出し分け、どちらも自然な寸法のまま。
          if (width >= 1680) {
            expect(numbers.logoVariant).toBe("full");
            expect(numbers.logoWidth).toBeCloseTo(FULL_LOGO_WIDTH, 0);
          } else {
            expect(numbers.logoVariant).toBe("mark");
            expect(numbers.logoWidth).toBeLessThan(40);
            expect(numbers.logoWidth).toBeCloseTo(MARK_LOGO_WIDTH, 0);
          }
          expect(m.logo.getBoundingClientRect().height).toBeCloseTo(
            LOGO_HEIGHT,
            0,
          );

          if (mac) return;
          // ▾ は button の中に全部見える（名前のほうが縮む）。
          const caret = m.trigger.querySelector("span:last-of-type")!;
          expect(caret.textContent).toBe("▾");
          expect(caret.getBoundingClientRect().right).toBeLessThanOrEqual(
            m.trigger.getBoundingClientRect().right -
              parseFloat(getComputedStyle(m.trigger).paddingRight) +
              0.5,
          );
          if (width >= 1280) {
            // フォルダ名と題名の両方が最小幅以上で見え、切り取りも要らない。
            expect(numbers.folderShown).toBe(true);
            expect(numbers.folderVisible).toBeGreaterThanOrEqual(
              Math.min(
                3.5 * em(m.folder) - 0.5,
                m.folder.getBoundingClientRect().width,
              ),
            );
            expect(numbers.titleVisible).toBeGreaterThanOrEqual(
              Math.min(
                3 * em(m.title) - 0.5,
                m.title.getBoundingClientRect().width,
              ),
            );
            expect(m.title.getBoundingClientRect().right).toBeLessThanOrEqual(
              m.trigger.getBoundingClientRect().right + 0.5,
            );
            expect(numbers.undoWidth).toBeCloseTo(32, 0);
            expect(m.redo.getBoundingClientRect().width).toBeCloseTo(32, 0);
          } else {
            // フォルダ名は隠し（DOM には残る）、題名はクリックできる幅で見える。
            expect(numbers.folderShown).toBe(false);
            expect(m.folder.textContent).toBe(NAMES[size].folder);
            expect(numbers.titleVisible).toBeGreaterThanOrEqual(21);
          }
        });
      }
    }
  }

  it("keeps the trigger's own focus outline unclipped", async () => {
    setNames(NAMES.long.folder, NAMES.long.title);
    const { container } = await renderHeader(1280, false);
    const { trigger } = measureHeader(container);
    // overflow-hidden は子の名前を切るだけで、button 自身の輪郭は切らない。
    // 輪郭を切りうる祖先（ヘッダーまで）が overflow を持たないことも見る。
    trigger.focus();
    await userEvent.keyboard("{Shift>}{/Shift}");
    expect(trigger).toHaveFocus();
    expect(getComputedStyle(trigger).outlineStyle).not.toBe("none");
    for (
      let node = trigger.parentElement;
      node && !node.hasAttribute("data-header-bar");
      node = node.parentElement
    ) {
      expect(getComputedStyle(node).overflowX).toBe("visible");
    }
  });
});
