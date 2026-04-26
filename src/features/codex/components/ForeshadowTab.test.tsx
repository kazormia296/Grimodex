// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ForeshadowTab } from "./ForeshadowTab";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock("@/features/foreshadow/foreshadowStore", () => ({
  useForeshadowStore: vi.fn(),
}));

vi.mock("@/features/foreshadow/api", () => ({
  listForeshadowsByCodexEntry: vi.fn(),
}));

import { useForeshadowStore } from "@/features/foreshadow/foreshadowStore";
import { listForeshadowsByCodexEntry } from "@/features/foreshadow/api";
import type { ForeshadowWithLabel } from "@/features/foreshadow/types";

const mockListForeshadowsByCodexEntry = vi.mocked(listForeshadowsByCodexEntry);
const mockUseForeshadowStore = vi.mocked(useForeshadowStore);

function makeItem(
  overrides: Partial<ForeshadowWithLabel> = {},
): ForeshadowWithLabel {
  return {
    id: "f1",
    projectId: "p1",
    title: "Aの裏切り",
    intent: null,
    notes: null,
    payoffSceneId: null,
    payoffFromPos: null,
    payoffToPos: null,
    payoffConfirmed: false,
    abandoned: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    label: "seeded",
    setupCount: 2,
    ...overrides,
  };
}

describe("ForeshadowTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseForeshadowStore.mockReturnValue({ load: vi.fn() } as never);
  });

  it("shows loading state initially", () => {
    mockListForeshadowsByCodexEntry.mockReturnValue(new Promise(() => {}));
    render(<ForeshadowTab codexEntryId="codex1" />);
    expect(screen.getByTestId("foreshadow-tab-loading")).toBeInTheDocument();
  });

  it("shows empty state when no foreshadows are linked", async () => {
    mockListForeshadowsByCodexEntry.mockResolvedValue([]);
    render(<ForeshadowTab codexEntryId="codex1" />);
    expect(
      await screen.findByTestId("foreshadow-tab-empty"),
    ).toBeInTheDocument();
  });

  it("displays linked foreshadows with title and label", async () => {
    mockListForeshadowsByCodexEntry.mockResolvedValue([makeItem()]);
    render(<ForeshadowTab codexEntryId="codex1" />);
    expect(await screen.findByText("Aの裏切り")).toBeInTheDocument();
  });

  it("calls listForeshadowsByCodexEntry with the correct codexEntryId", async () => {
    mockListForeshadowsByCodexEntry.mockResolvedValue([]);
    render(<ForeshadowTab codexEntryId="codex-xyz" />);
    await screen.findByTestId("foreshadow-tab-empty");
    expect(mockListForeshadowsByCodexEntry).toHaveBeenCalledWith("codex-xyz");
  });
});
