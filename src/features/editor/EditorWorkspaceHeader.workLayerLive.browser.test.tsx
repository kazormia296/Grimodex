/**
 * Work Layer の live データ（件数と入口だけ）を出しても、ヘッダーの寸法が変わらないこと（実 Chromium）。
 *
 * ADR 014 の守ること 8（常に出ている領域を増やさない）と、ロードマップの Project Focus の節の
 * 「Header／Drawer変更はreal Chromium geometry testを必要とし、closed stateでEditor寸法を変えない」
 * に当たる。Pulse が出ていない状態を基準に、live の Pulse が出た状態（数が小さい・部分合計・桁が大きい）で次を確かめる。
 * - ヘッダーの寸法、左右のレールの位置と幅、中央スロットの位置と幅が変わらない。
 * - 中央スロットはヘッダーの中心のまま。
 * - Pulse は左右のレールに重ならず、中央スロットの外にはみ出さない。
 *
 * happy-dom は flex の実寸も container query も media query も計算しない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { page } from "vitest/browser";
import { EditorWorkspaceHeader } from "./EditorWorkspaceHeader";
import { WorkLayerProvider } from "@/features/work-layer/WorkLayerContext";
import type {
  WorkLayerLiveEntry,
  WorkLayerModel,
  WorkLayerPort,
} from "@/features/work-layer/types";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useProjectStore } from "@/features/project/projectStore";
import { PROJECT_ID } from "@/features/project/constants";
import type { Project } from "@/features/project/api";
import type { RuntimeCapabilities } from "@/runtime/runtimeCapabilities";

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

const STATES: Record<string, readonly WorkLayerLiveEntry[] | null> = {
  // 基準：Pulse が出ていない（Provider に何も無い）。
  none: null,
  small: [
    { id: "codex-candidates", status: "ready", count: 3 },
    { id: "stale-proposals", status: "ready", count: 2 },
  ],
  partial: [
    { id: "codex-candidates", status: "not-counted", count: null },
    { id: "stale-proposals", status: "ready", count: 99 },
  ],
  wide: [
    { id: "codex-candidates", status: "ready", count: 12345 },
    { id: "stale-proposals", status: "not-counted", count: null },
  ],
};

function modelOf(entries: readonly WorkLayerLiveEntry[]): WorkLayerModel {
  return {
    scopeId: PROJECT_ID,
    liveEntries: entries,
    focus: null,
    attention: [],
    disposedAttention: [],
    system: { state: "idle", label: "idle" },
  };
}

async function renderHeader(width: number, entries: StateEntries) {
  await page.viewport(width, 720);
  const port: WorkLayerPort | null =
    entries == null
      ? null
      : {
          kind: "live",
          scopeKey: PROJECT_ID,
          load: async () => modelOf(entries),
        };
  const result = render(
    <div style={{ position: "fixed", top: 0, left: 0, width, height: 48 }}>
      <WorkLayerProvider port={port}>
        <EditorWorkspaceHeader
          runtimeCapabilities={CAPABILITIES}
          screenshotPanelId={null}
          panelWindow={false}
          phoneWorkspace={false}
          editorZenMode={false}
          mac={false}
          onOpenTransfer={() => {}}
          onOpenSnapshot={() => {}}
          onToggleExport={() => {}}
          onOpenSettings={() => {}}
        />
      </WorkLayerProvider>
    </div>,
  );
  if (entries != null) {
    await vi.waitFor(() =>
      expect(
        result.container.querySelector('[data-testid="work-pulse"]'),
      ).not.toBeNull(),
    );
  }
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  return result;
}

type StateEntries = readonly WorkLayerLiveEntry[] | null;

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

function box(element: Element): Box {
  const r = element.getBoundingClientRect();
  return {
    left: r.left,
    right: r.right,
    top: r.top,
    bottom: r.bottom,
    width: r.width,
    height: r.height,
  };
}

function geometry(container: HTMLElement) {
  const q = (selector: string) => {
    const element = container.querySelector(selector);
    expect(element, selector).not.toBeNull();
    return element!;
  };
  const pulse = container.querySelector('[data-testid="work-pulse"]');
  return {
    header: box(q("[data-header-bar]")),
    leftRail: box(q('[data-header-rail="left"]')),
    center: box(q("[data-header-center]")),
    rightRail: box(q('[data-header-rail="right"]')),
    pulse: pulse == null ? null : box(pulse),
  };
}

function expectSameBox(actual: Box, expected: Box, label: string) {
  for (const key of [
    "left",
    "right",
    "top",
    "bottom",
    "width",
    "height",
  ] as const) {
    expect(
      Math.abs(actual[key] - expected[key]),
      `${label}.${key}: ${actual[key]} vs ${expected[key]}`,
    ).toBeLessThan(0.5);
  }
}

beforeEach(() => {
  useWorkspaceStore.setState({
    activeWorkspacePath: "/work/current",
    workspaceOpenRequestInProgress: false,
    workspaceSwitchInProgress: false,
    globalSettings: null,
    activeWorkspaceName: "短編",
  });
  useProjectStore.setState({
    projectLoadStatus: "ready",
    degradedParticipants: [],
    refreshProjects: async () => {},
    currentProjectId: PROJECT_ID,
    projects: [{ id: PROJECT_ID, title: "番外編" } as Project],
  });
});

afterEach(() => {
  cleanup();
});

describe("EditorWorkspaceHeader with live Work Layer data (real Chromium)", () => {
  for (const width of WIDTHS) {
    it(`does not change the header's geometry when a live Pulse appears at ${width}px`, async () => {
      const baselineView = await renderHeader(width, STATES.none!);
      const baseline = geometry(baselineView.container);
      expect(baseline.pulse).toBeNull();
      cleanup();

      for (const name of ["small", "partial", "wide"] as const) {
        const view = await renderHeader(width, STATES[name]!);
        const live = geometry(view.container);
        const label = `${name}@${width}`;

        // ヘッダーと左右のレールの寸法・位置は、Pulse の有無で変わらない（中央スロットは、Pulse が無いと空で
        // 高さ 0 になるので、箱そのものは比べない。下で、中心がヘッダーの中心のままであることを見る）。
        expectSameBox(live.header, baseline.header, `${label} header`);
        expectSameBox(live.leftRail, baseline.leftRail, `${label} leftRail`);
        expectSameBox(live.rightRail, baseline.rightRail, `${label} rightRail`);

        // 中央スロットはヘッダーの中心のまま。
        const centerOffset =
          live.center.left +
          live.center.width / 2 -
          (live.header.left + live.header.width / 2);
        expect(Math.abs(centerOffset), `${label} centerOffset`).toBeLessThan(1);

        // Pulse は出ていて、左右のレールに重ならず、中央スロットの外にはみ出さない。
        expect(live.pulse, `${label} pulse`).not.toBeNull();
        const pulse = live.pulse!;
        expect(
          pulse.left,
          `${label} pulse vs left rail`,
        ).toBeGreaterThanOrEqual(live.leftRail.right - 0.5);
        expect(pulse.right, `${label} pulse vs right rail`).toBeLessThanOrEqual(
          live.rightRail.left + 0.5,
        );
        expect(pulse.left, `${label} pulse in slot`).toBeGreaterThanOrEqual(
          live.center.left - 0.5,
        );
        expect(pulse.right, `${label} pulse in slot`).toBeLessThanOrEqual(
          live.center.right + 0.5,
        );
        expect(pulse.height, `${label} pulse height`).toBeLessThanOrEqual(
          live.header.height,
        );
        cleanup();
      }
    });
  }
});
