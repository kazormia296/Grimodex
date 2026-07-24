// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ExportDialog } from "./ExportDialog";
import type { TreeNodeData } from "@/features/tree/treeStore";

// ---------------------------------------------------------------------------
// mocks
// ---------------------------------------------------------------------------

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// AnimatedOverlay は motion/react + portal を含むため素通しの殻に差し替える
vi.mock("@/components/ui/animated-overlay", () => ({
  AnimatedOverlay: ({
    open,
    children,
  }: {
    open: boolean;
    children: React.ReactNode;
  }) => (open ? <div data-testid="overlay">{children}</div> : null),
}));

const NODES = [
  {
    id: "scene-1",
    parentId: null,
    nodeType: "scene",
    sortOrder: "a0",
    title: "第一話",
  },
] as unknown as TreeNodeData[];

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: (selector: (s: unknown) => unknown) =>
    selector({ nodes: NODES, expandedIds: [] }),
}));

vi.mock("@/db/client", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => [],
      }),
    }),
  },
}));

vi.mock("@/db/schema", () => ({
  treeNodes: { id: "id", content: "content", projectId: "projectId" },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
}));

vi.mock("@/features/editor/sceneContentStore", () => ({
  useSceneContentStore: {
    getState: () => ({ liveContent: {} }),
  },
}));

const settingsData = new Map<string, string>();
const fakeSettingsStore = {
  get: (key: string, fallback = "") => settingsData.get(key) ?? fallback,
  getBoolean: (_key: string, fallback = false) => fallback,
  getNumber: (_key: string, fallback = 0) => fallback,
  set: (key: string, value: string) => {
    settingsData.set(key, value);
  },
};
vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: Object.assign(
    (selector?: (s: unknown) => unknown) =>
      selector ? selector(fakeSettingsStore) : fakeSettingsStore,
    { getState: () => fakeSettingsStore },
  ),
}));

vi.mock("@/features/project/api", () => ({
  getProject: async () => null,
}));

vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "project-1",
}));

vi.mock("@/lib/exportFile", () => ({
  saveTextFile: async () => null,
}));

vi.mock("./ExportSettingsPanel", () => ({
  ExportSettingsPanel: () => <div data-testid="export-settings-panel" />,
}));

vi.mock("@/features/timelapse/TimelapseExportSection", () => ({
  TimelapseExportSection: () => <div data-testid="timelapse-section" />,
}));

vi.mock("@/features/attribution/provenance", () => ({
  buildProvenanceBreakdown: async () => ({ totals: { ai: 0 }, scenes: [] }),
}));

vi.mock("@/features/attribution/provenanceAnalytics", () => ({
  loadProvenanceAnalytics: async () => null,
}));

vi.mock("@/features/attribution/exportReport", () => ({
  exportProvenanceDisclosureHtml: () => "",
  exportProvenanceDisclosureJson: () => "",
  exportProvenanceDisclosureMarkdown: () => "",
}));

vi.mock("@/features/codex/mentionNameResolver", () => ({
  currentCodexMentionResolver: () => undefined,
}));

vi.mock("@/features/vivliostyle/VivliostyleExportSection", () => ({
  VivliostyleExportSection: () => <div data-testid="vivliostyle-section" />,
}));

beforeEach(() => {
  settingsData.clear();
});

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("ExportDialog", () => {
  it("タブが 4 つ（テキスト/開示/動画/本の書き出し）表示される", () => {
    render(<ExportDialog open onClose={vi.fn()} />);

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((el) => el.textContent)).toEqual([
      "timelapse.tabTextExport",
      "attribution.report",
      "timelapse.tabVideoExport",
      "vivliostyle.tab",
    ]);
  });

  it("本の書き出しタブで Vivliostyle セクションが表示され、共通フッターは出ない", () => {
    render(<ExportDialog open onClose={vi.fn()} />);

    // text モードでは共通フッターのエクスポートボタンがある
    expect(screen.getByText("export.dialog.export")).toBeInTheDocument();

    fireEvent.click(screen.getByText("vivliostyle.tab"));

    expect(screen.getByTestId("vivliostyle-section")).toBeInTheDocument();
    // 共通フッター（コピー/エクスポート）は book モードでは描画しない
    expect(screen.queryByText("export.dialog.export")).toBeNull();
    expect(screen.queryByText("export.dialog.copy")).toBeNull();
    // テキストモードの設定パネルも出ていない
    expect(screen.queryByTestId("export-settings-panel")).toBeNull();
  });

  it("modeRequest=book で開くと本の書き出しタブが選択される", () => {
    render(
      <ExportDialog
        open
        onClose={vi.fn()}
        modeRequest={{ mode: "book", seq: 1 }}
      />,
    );

    expect(screen.getByTestId("vivliostyle-section")).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "vivliostyle.tab" }),
    ).toHaveAttribute("aria-selected", "true");
  });

  it("タブを切り替えても text モードに戻れる", () => {
    render(
      <ExportDialog
        open
        onClose={vi.fn()}
        modeRequest={{ mode: "book", seq: 1 }}
      />,
    );

    fireEvent.click(screen.getByText("timelapse.tabTextExport"));
    expect(screen.getByTestId("export-settings-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("vivliostyle-section")).toBeNull();
    expect(screen.getByText("export.dialog.export")).toBeInTheDocument();
  });

  it("ダイアログ既開時でも modeRequest の seq 変化でタブが切り替わる", () => {
    const { rerender } = render(<ExportDialog open onClose={vi.fn()} />);
    expect(screen.getByTestId("export-settings-panel")).toBeInTheDocument();

    // 開いたまま「本の書き出し」要求
    rerender(
      <ExportDialog
        open
        onClose={vi.fn()}
        modeRequest={{ mode: "book", seq: 1 }}
      />,
    );
    expect(screen.getByTestId("vivliostyle-section")).toBeInTheDocument();

    // 手動で text タブに移動した後、同じ mode の再要求（seq のみ増加）でも
    // book タブへ戻る
    fireEvent.click(screen.getByText("timelapse.tabTextExport"));
    expect(screen.queryByTestId("vivliostyle-section")).toBeNull();
    rerender(
      <ExportDialog
        open
        onClose={vi.fn()}
        modeRequest={{ mode: "book", seq: 2 }}
      />,
    );
    expect(screen.getByTestId("vivliostyle-section")).toBeInTheDocument();
  });

  it("閉じて再度開いたとき、過去の modeRequest は再適用されない（前回タブ維持）", () => {
    const { rerender } = render(
      <ExportDialog
        open
        onClose={vi.fn()}
        modeRequest={{ mode: "book", seq: 1 }}
      />,
    );
    // book タブ → 手動で text タブへ
    fireEvent.click(screen.getByText("timelapse.tabTextExport"));

    // 閉じる → タブ指定なしの経路（ツールバー等）で再度開く
    rerender(
      <ExportDialog
        open={false}
        onClose={vi.fn()}
        modeRequest={{ mode: "book", seq: 1 }}
      />,
    );
    rerender(
      <ExportDialog
        open
        onClose={vi.fn()}
        modeRequest={{ mode: "book", seq: 1 }}
      />,
    );

    // 古い要求で book に引き戻されず、前回の text タブが維持される
    expect(screen.getByTestId("export-settings-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("vivliostyle-section")).toBeNull();
  });
});
