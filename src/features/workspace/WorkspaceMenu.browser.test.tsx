/**
 * ヘッダーの左のレールが足りないときの縮み方（実 Chromium）。
 * ロゴは縮めず、ワークスペース名のほうを省略する。以前はロゴの svg が縮み、
 * 長いワークスペース名でロゴだけが小さくなっていた。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { GrimodexLogo } from "@/components/GrimodexLogo";
import { HeaderBarLayout } from "@/components/HeaderBarLayout";
import { WorkspaceMenu } from "./WorkspaceMenu";
import { useWorkspaceStore } from "./store";

const LOGO_HEIGHT = 24;

function renderHeader(width: number) {
  return render(
    <div style={{ position: "fixed", top: 0, left: 0, width, height: 48 }}>
      <HeaderBarLayout
        left={
          <>
            <GrimodexLogo
              height={LOGO_HEIGHT}
              className="shrink-0 text-foreground"
            />
            <WorkspaceMenu />
            {/* プロジェクト名など、縮まない後続の要素の代わり。 */}
            <div style={{ flex: "0 0 auto", width: 176, height: 24 }} />
          </>
        }
        center={null}
        right={null}
      />
    </div>,
  );
}

const nextFrame = () =>
  new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

describe("header logo with a long workspace name (real Chromium)", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      activeWorkspaceName: "GrimodexWorkspaceWithAVeryLongFolderName",
    });
  });

  it("keeps the logo at its natural size and truncates the workspace name instead", async () => {
    const wide = renderHeader(3000);
    await nextFrame();
    const naturalWidth = wide.container
      .querySelector("svg")!
      .getBoundingClientRect().width;
    wide.unmount();
    expect(naturalWidth).toBeGreaterThan(LOGO_HEIGHT * 3);

    // 左のレールは 1/3 の 400px。ロゴ＋名前（最大 160px）＋176px は入り切らない。
    const { container } = renderHeader(1200);
    await nextFrame();
    const logo = container.querySelector("svg")!.getBoundingClientRect();
    expect(logo.width).toBeCloseTo(naturalWidth, 0);
    expect(logo.height).toBeCloseTo(LOGO_HEIGHT, 0);

    // 名前が縮んで、左のレールからはみ出さない（中央の表示に重ならない）。
    const rail = container
      .querySelector('[data-header-rail="left"]')!
      .getBoundingClientRect();
    const trigger = container
      .querySelector('[data-testid="workspace-menu-trigger"]')!
      .getBoundingClientRect();
    expect(trigger.right).toBeLessThanOrEqual(rail.right - 176 + 0.5);
    const name = container.querySelector<HTMLElement>(
      '[data-testid="workspace-menu-trigger"] > span',
    )!;
    expect(name.clientWidth).toBeLessThan(160);
    expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
  });
});
