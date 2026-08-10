// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RecoveryShell } from "./RecoveryShell";
import type { RecoveryShellState } from "./types";

const restoreRecoveryCandidateMock = vi.hoisted(() => vi.fn());

vi.mock("./api", () => ({
  exportSafeModeDiagnostics: vi.fn(),
  listRecoveryCandidates: vi.fn(),
  quarantineLiveDatabase: vi.fn(),
  restoreRecoveryCandidate: restoreRecoveryCandidateMock,
  verifyRecoveryCandidate: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

describe("RecoveryShell", () => {
  it("renders recovery candidates and restores by opaque id only", async () => {
    const user = userEvent.setup();
    const recovery: RecoveryShellState = {
      mode: "recovery-required",
      workspacePath: "/workspace/novel",
      reason: "RECOVERY_REQUIRED: migration failed",
      errorCode: "MIGRATION_REPLACE_FAILED",
      snapshotId: "rc_snapshot_1",
      candidates: [
        {
          id: "rc_snapshot_1",
          kind: "migration-snapshot",
          createdAt: "2026-08-10T12:00:00Z",
          schemaVersion: 42,
          appVersion: "0.7.0",
          sizeBytes: 8192,
          checksumStatus: "unverified",
        },
      ],
    };
    restoreRecoveryCandidateMock.mockResolvedValueOnce(undefined);

    render(<RecoveryShell recovery={recovery} />);

    expect(screen.getByText("migration-snapshot")).toBeInTheDocument();
    expect(screen.getByText("2026-08-10T12:00:00Z")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("unverified")).toBeInTheDocument();
    expect(
      screen.getByText(/normal workspace panels are unavailable/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /create quarantine copy/i }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /restore/i }));

    expect(restoreRecoveryCandidateMock).toHaveBeenCalledWith("rc_snapshot_1");
  });
});
