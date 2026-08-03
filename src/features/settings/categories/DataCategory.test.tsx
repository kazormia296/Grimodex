// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetQuiescenceLeasesForTests,
  acquireQuiescenceLease,
} from "@/application/lifecycle/quiescenceLease";
import { DataCategory } from "./DataCategory";

const chatMock = vi.hoisted(() => ({
  clearProjectChatHistory: vi.fn(async () => {}),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/tauri", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@/features/workspace/store", () => ({
  useWorkspaceStore: (
    selector: (state: { activeWorkspacePath: string }) => unknown,
  ) => selector({ activeWorkspacePath: "/workspace" }),
}));
vi.mock("@/features/chat/chatStore", () => ({
  useChatStore: (selector: (state: typeof chatMock) => unknown) =>
    selector(chatMock),
}));
vi.mock("@/features/codex/mentionRescanQueue", () => ({
  enqueueRescan: vi.fn(),
  useRescanStore: (
    selector: (state: {
      isRunning: boolean;
      progress: number;
      total: number;
    }) => unknown,
  ) => selector({ isRunning: false, progress: 0, total: 0 }),
}));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "project-1",
}));
vi.mock("../dataApi", () => ({
  getProjectDataStats: vi.fn(async () => ({ sceneCount: 0, totalChars: 0 })),
}));
vi.mock("../exportUtils", () => ({
  exportCodexJson: vi.fn(async () => "{}"),
}));
vi.mock("../components/SettingSection", () => ({
  SettingSection: ({ children }: { children: ReactNode }) => (
    <section>{children}</section>
  ),
}));
vi.mock("../components/SettingRow", () => ({
  SettingRow: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/SettingToggle", () => ({
  SettingToggle: () => null,
}));
vi.mock("../components/SettingSlider", () => ({
  SettingSlider: () => null,
}));
vi.mock("@/features/workspace/IntegrityCheckDialog", () => ({
  IntegrityCheckSection: () => null,
}));
vi.mock("./SemanticIndexSection", () => ({
  SemanticIndexSection: () => null,
}));
vi.mock("./BackupRestoreSection", () => ({
  BackupRestoreSection: () => null,
}));
vi.mock("@/features/external-mount/components/MountListDialog", () => ({
  MountListDialog: () => null,
}));
vi.mock("@/runtime/runtimeCapabilitiesContext", () => ({
  CapabilityGate: ({ children }: { children: ReactNode }) => children,
}));

describe("DataCategory Chat history lifecycle admission", () => {
  beforeEach(() => {
    _resetQuiescenceLeasesForTests();
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetQuiescenceLeasesForTests();
  });

  it("disables the clear action while a destructive lifecycle is active", async () => {
    render(<DataCategory />);
    const button = screen.getByTestId("clear-chat-history-button");
    expect(button).toBeEnabled();

    let lease!: ReturnType<typeof acquireQuiescenceLease>;
    act(() => {
      lease = acquireQuiescenceLease("project-load");
    });

    await waitFor(() => expect(button).toBeDisabled());
    expect(chatMock.clearProjectChatHistory).not.toHaveBeenCalled();

    act(() => lease.release());
    await waitFor(() => expect(button).toBeEnabled());
  });
});
