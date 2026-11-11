/**
 * 統合メニュー（「フォルダ名 / 題名」）の縮み方（実 Chromium）。
 * happy-dom は flex の実寸も container query も計算しないので、ここで実寸を見る。
 *
 * ヘッダーと同じく、メニューと後ろの固定分（元に戻す・やり直す・書き出しの 132px。
 * ここでは gap と 1 つの箱で代用）を名前付きの container（header-menu）に入れて描く。
 * - 足りないときはフォルダ名が先に縮む。フォルダ名は 3.5em、題名は 3em を下回らない。
 * - container の内容幅が 288px 未満なら、フォルダ名と「/」を隠して題名だけにする。
 * - どの幅でも、名前は button の外に描かれず、button は後ろの要素に重ならない。
 * - トリガーは中身の幅で、上限 320px。
 * 実際のヘッダー全体の幅ごとの検査は EditorWorkspaceHeader.browser.test.tsx。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GrimodexLogo } from "@/components/GrimodexLogo";
import { HeaderBarLayout } from "@/components/HeaderBarLayout";
import { WorkspaceMenu } from "./WorkspaceMenu";
import { useWorkspaceStore } from "./store";
import { useProjectStore } from "@/features/project/projectStore";
import { PROJECT_ID } from "@/features/project/constants";
import type { Project } from "@/features/project/api";

const LOGO_HEIGHT = 24;
/** メニューの後ろの固定分：gap 12 ＋ 120（元に戻す・やり直す・書き出しと間の gap）。 */
const AFTER_MENU = 120;
const LONG_FOLDER = "GrimodexWorkspaceWithAVeryLongFolderName";
const LONG_TITLE = "異世界で始める魔導書の修復師 第二部";
const TITLE = "星屑の記録";

function setNames(folder: string, title: string) {
  useWorkspaceStore.setState({ activeWorkspaceName: folder });
  useProjectStore.setState({
    currentProjectId: PROJECT_ID,
    projects: [{ id: PROJECT_ID, title } as Project],
  });
}

const nextFrame = () =>
  new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

/** ヘッダーの wrapper と同じ形の container（内容幅 = width）。 */
async function renderInMenuGroup(width: number) {
  const result = render(
    <div
      className="@container/header-menu flex min-w-0 items-center gap-3"
      style={{ position: "fixed", top: 0, left: 0, width, height: 48 }}
    >
      <WorkspaceMenu />
      <div
        data-test-next
        style={{ flex: "0 0 auto", width: AFTER_MENU, height: 24 }}
      />
    </div>,
  );
  await nextFrame();
  return result;
}

function parts(container: HTMLElement) {
  const trigger = container.querySelector<HTMLElement>(
    '[data-testid="workspace-menu-trigger"]',
  )!;
  const [folder, slash] = Array.from(trigger.querySelectorAll("span"));
  const title = container.querySelector<HTMLElement>(
    '[data-testid="project-menu-trigger"]',
  )!;
  const next = container.querySelector<HTMLElement>("[data-test-next]");
  return { trigger, folder, slash, title, next };
}

const em = (el: Element) => parseFloat(getComputedStyle(el).fontSize);
const truncated = (el: HTMLElement) => el.scrollWidth > el.clientWidth;
const shown = (el: HTMLElement) => getComputedStyle(el).display !== "none";
const appRegion = (el: Element) =>
  getComputedStyle(el).getPropertyValue("-webkit-app-region");

/** span のうち、button の矩形（overflow で切り取る範囲）の中に見えている幅。 */
function visibleWidth(span: HTMLElement, button: HTMLElement): number {
  if (!shown(span)) return 0;
  const s = span.getBoundingClientRect();
  const b = button.getBoundingClientRect();
  return Math.max(0, Math.min(s.right, b.right) - Math.max(s.left, b.left));
}

/** 名前は button の外に描かれず、button は後ろの要素に重ならない。 */
function expectContained(container: HTMLElement) {
  const { trigger, next } = parts(container);
  expect(getComputedStyle(trigger).overflowX).toBe("hidden");
  if (next) {
    expect(trigger.getBoundingClientRect().right).toBeLessThanOrEqual(
      next.getBoundingClientRect().left + 0.5,
    );
  }
}

/**
 * `-webkit-app-region` は継承されない。Chromium は内側の箱の drag／no-drag で
 * 外側の箱を上書きするので、要素自身から祖先へたどって最初に値を持つ箱を見る。
 */
function effectiveAppRegion(el: Element): string {
  for (let node: Element | null = el; node; node = node.parentElement) {
    const value = appRegion(node);
    if (value && value !== "none") return value;
  }
  return "none";
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
  setNames(LONG_FOLDER, TITLE);
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.shell;
});

describe("unified header menu sizing (real Chromium)", () => {
  it("keeps the logo at its natural size and shrinks the menu instead", async () => {
    const wide = render(<GrimodexLogo height={LOGO_HEIGHT} />);
    await nextFrame();
    const naturalWidth = wide.container
      .querySelector("svg")!
      .getBoundingClientRect().width;
    wide.unmount();
    expect(naturalWidth).toBeGreaterThan(LOGO_HEIGHT * 3);

    // 左レールは 360px。ロゴ＋長い名前＋後ろの固定分は入り切らない。
    const { container } = render(
      <div style={{ position: "fixed", top: 0, left: 0, width: 1200 }}>
        <HeaderBarLayout
          left={
            <>
              <GrimodexLogo
                height={LOGO_HEIGHT}
                className="shrink-0 text-foreground"
              />
              <div className="@container/header-menu flex min-w-0 flex-1 items-center gap-3">
                <WorkspaceMenu />
                <div
                  data-test-next
                  style={{ flex: "0 0 auto", width: AFTER_MENU, height: 24 }}
                />
              </div>
            </>
          }
          center={null}
          right={null}
        />
      </div>,
    );
    await nextFrame();
    const logo = container.querySelector("svg")!.getBoundingClientRect();
    expect(logo.width).toBeCloseTo(naturalWidth, 0);
    expect(logo.height).toBeCloseTo(LOGO_HEIGHT, 0);
    expectContained(container);
    const { title, trigger } = parts(container);
    expect(visibleWidth(title, trigger)).toBeGreaterThanOrEqual(21);
  });

  it("shows both the folder name and the title when there is room", async () => {
    setNames("mynovel", TITLE);
    const { container } = await renderInMenuGroup(1000);
    const { folder, slash, title, trigger } = parts(container);
    expect(shown(folder)).toBe(true);
    expect(shown(slash)).toBe(true);
    expect(truncated(folder)).toBe(false);
    expect(truncated(title)).toBe(false);
    expect(folder.getBoundingClientRect().right).toBeLessThanOrEqual(
      title.getBoundingClientRect().left,
    );
    // 中身に合わせた幅（固定幅ではない）。
    expect(trigger.getBoundingClientRect().width).toBeLessThan(200);
    expectContained(container);
  });

  it("shrinks the folder name first, keeping the title whole", async () => {
    // メニューに使える幅は約 200px。
    const { container } = await renderInMenuGroup(200 + 12 + AFTER_MENU);
    const { folder, title, trigger } = parts(container);
    expect(shown(folder)).toBe(true);
    expect(truncated(folder)).toBe(true);
    expect(folder.getBoundingClientRect().width).toBeGreaterThanOrEqual(
      3.5 * em(folder) - 0.5,
    );
    expect(truncated(title)).toBe(false);
    expect(visibleWidth(title, trigger)).toBeCloseTo(
      title.getBoundingClientRect().width,
      0,
    );
    expectContained(container);
  });

  it("fits both minimum widths inside the button right at the 288px threshold", async () => {
    // フォルダ名を出す最小の幅。「!」付きでも、名前は切り取られずに収まる。
    setNames(LONG_FOLDER, LONG_TITLE);
    useProjectStore.setState({
      projectLoadStatus: "degraded",
      degradedParticipants: ["last-active-project"],
    });
    const { container } = await renderInMenuGroup(288);
    const { folder, title, trigger } = parts(container);
    expect(shown(folder)).toBe(true);
    expect(folder.getBoundingClientRect().width).toBeGreaterThanOrEqual(
      3.5 * em(folder) - 0.5,
    );
    expect(title.getBoundingClientRect().width).toBeGreaterThanOrEqual(
      3 * em(title) - 0.5,
    );
    // どの名前も button の中に収まる（切り取りに頼らない）。
    const button = trigger.getBoundingClientRect();
    for (const span of Array.from(trigger.querySelectorAll("span"))) {
      const rect = span.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(button.left - 0.5);
      expect(rect.right).toBeLessThanOrEqual(button.right + 0.5);
    }
    expectContained(container);
  });

  it("does not leave a gap for names shorter than the minimum widths", async () => {
    setNames("短編", "番外");
    const { container } = await renderInMenuGroup(1000);
    const { folder, title } = parts(container);
    expect(folder.getBoundingClientRect().width).toBeLessThan(
      3.5 * em(folder) - 1,
    );
    expect(title.getBoundingClientRect().width).toBeLessThan(3 * em(title) - 1);
  });

  it("shows only the title when the menu group is under 288px", async () => {
    const { container } = await renderInMenuGroup(287);
    const { folder, slash, title, trigger } = parts(container);
    // DOM には残し、CSS で隠す（journey はフォルダ名の span の文字を読む）。
    expect(folder.textContent).toBe(LONG_FOLDER);
    expect(shown(folder)).toBe(false);
    expect(shown(slash)).toBe(false);
    expect(visibleWidth(title, trigger)).toBeGreaterThanOrEqual(21);
    expectContained(container);
  });

  it("squeezes the title, not the caret, when only about 55px remain", async () => {
    // 800px の窓（メニューに残る幅 約 55px）と同じくらい。題名が縮んで ▾ は
    // button の中に残り、後ろの要素には重ならない。
    setNames(LONG_FOLDER, LONG_TITLE);
    const { container } = await renderInMenuGroup(55 + 12 + AFTER_MENU);
    const { folder, title, trigger } = parts(container);
    expect(shown(folder)).toBe(false);
    expect(visibleWidth(title, trigger)).toBeGreaterThanOrEqual(21);
    const caret = trigger.querySelector("span:last-of-type")!;
    const contentRight =
      trigger.getBoundingClientRect().right -
      parseFloat(getComputedStyle(trigger).paddingRight);
    expect(caret.textContent).toBe("▾");
    expect(caret.getBoundingClientRect().right).toBeLessThanOrEqual(
      contentRight + 0.5,
    );
    expectContained(container);
  });

  it("caps the trigger at 320px for long names", async () => {
    setNames(
      "長編シリーズ_2026秋_改稿用_バックアップ",
      "異世界で始める魔導書の修復師 第二部 改稿版",
    );
    const { container } = await renderInMenuGroup(1200);
    const { trigger, folder, title } = parts(container);
    expect(trigger.getBoundingClientRect().width).toBeLessThanOrEqual(320.5);
    expect(shown(folder)).toBe(true);
    expect(truncated(folder)).toBe(true);
    expect(title.getBoundingClientRect().width).toBeGreaterThanOrEqual(
      3 * em(title) - 0.5,
    );
    expectContained(container);
  });

  it("keeps the open panel out of the Electron window drag region", async () => {
    document.documentElement.dataset.shell = "electron";
    const { container } = render(
      <div style={{ position: "fixed", top: 0, left: 0, width: 1200 }}>
        <HeaderBarLayout left={<WorkspaceMenu />} center={null} right={null} />
      </div>,
    );
    await nextFrame();
    const rail = container.querySelector<HTMLElement>(
      '[data-header-rail="left"]',
    )!;
    expect(appRegion(rail)).toBe("drag");
    fireEvent.click(parts(container).trigger);
    await nextFrame();
    const panel = container.querySelector<HTMLElement>(
      '[data-testid="workspace-menu-dropdown"]',
    )!;
    const heading = container.querySelector<HTMLElement>(
      "[data-workspace-menu-heading]",
    )!;
    const hint = panel.querySelector<HTMLElement>("p")!;
    expect(appRegion(panel)).toBe("no-drag");
    // 見出しと補足（button ではない部分）が、左レールの drag に落ちない。
    expect(appRegion(heading)).toBe("none");
    expect(effectiveAppRegion(heading)).toBe("no-drag");
    expect(effectiveAppRegion(hint)).toBe("no-drag");
    expect(panel.getBoundingClientRect().width).toBeCloseTo(320, 0);
  });
});
