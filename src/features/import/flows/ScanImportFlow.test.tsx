// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  applyScanImportPlanMock,
  blockIfUnlicensedMock,
  buildScanImportPlanMock,
} = vi.hoisted(() => ({
  applyScanImportPlanMock: vi.fn(),
  blockIfUnlicensedMock: vi.fn(),
  buildScanImportPlanMock: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/features/license/gate", () => ({
  blockIfUnlicensed: blockIfUnlicensedMock,
}));
vi.mock("../scan/scanImportPlan", () => ({
  buildScanImportPlan: buildScanImportPlanMock,
}));
vi.mock("../scan/applyScanImportPlan", () => ({
  applyScanImportPlan: applyScanImportPlanMock,
  ScanImportApplyError: class ScanImportApplyError extends Error {},
}));
vi.mock("../scan/scanImportOperations", () => ({
  createScanImportOperationsForPlan: vi.fn(() => ({})),
}));

import { ScanImportFlow } from "./ScanImportFlow";

afterEach(cleanup);

describe("ScanImportFlow licensing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    blockIfUnlicensedMock.mockReturnValue(true);
    buildScanImportPlanMock.mockReturnValue({
      projectTitle: "Imported novel",
      nodes: [],
      codexEntries: [],
      events: [],
      findings: [],
      warnings: [],
    });
  });

  it("does not create a staging project when writes are unlicensed", async () => {
    const { container } = render(<ScanImportFlow onClose={vi.fn()} />);
    const file = new File(["{}"], "novel.scan.json", {
      type: "application/json",
    });
    Object.defineProperty(file, "text", {
      value: vi.fn(async () => "{}"),
    });
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    fireEvent.change(input!, { target: { files: [file] } });
    await screen.findByText("Imported novel");

    fireEvent.click(
      screen.getByRole("button", { name: "import.scan.importButton" }),
    );

    await waitFor(() => expect(blockIfUnlicensedMock).toHaveBeenCalledOnce());
    expect(applyScanImportPlanMock).not.toHaveBeenCalled();
  });
});
