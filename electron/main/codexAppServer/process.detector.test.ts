import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createNodeCliProcessRunner: vi.fn(),
  detectCliBinaryMain: vi.fn(),
}));

vi.mock("../cliAi.js", async () => {
  const actual =
    await vi.importActual<typeof import("../cliAi.js")>("../cliAi.js");
  return {
    ...actual,
    createNodeCliProcessRunner: mocks.createNodeCliProcessRunner,
    detectCliBinaryMain: mocks.detectCliBinaryMain,
  };
});

interface DetectorRunner {
  disposeAll: ReturnType<typeof vi.fn>;
  quiesceForProfileEgress: ReturnType<typeof vi.fn>;
}

function createRunner(
  quiesceForProfileEgress: () => Promise<void>,
): DetectorRunner {
  return {
    disposeAll: vi.fn(),
    quiesceForProfileEgress: vi.fn(quiesceForProfileEgress),
  };
}

describe("Codex default executable detector lifecycle", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("waits for the detector runner child close after an early rejection", async () => {
    let resolveChildClose!: () => void;
    const childClosed = new Promise<void>((resolve) => {
      resolveChildClose = resolve;
    });
    const runner = createRunner(() => childClosed);
    mocks.createNodeCliProcessRunner.mockReturnValue(runner);
    mocks.detectCliBinaryMain.mockRejectedValue(
      new Error("detector probe failed"),
    );

    const { CodexAppServerProcess } = await import("./process.js");
    const process = new CodexAppServerProcess({
      authorizeExecutable: async () => true,
      codexHomeDir: "/tmp/grimodex-codex",
    });
    let settled = false;
    const starting = process.start().finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(runner.disposeAll).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(runner.quiesceForProfileEgress).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    resolveChildClose();
    await expect(starting).rejects.toThrow("detector probe failed");
    expect(settled).toBe(true);
  });

  it("propagates a detector runner close-barrier failure", async () => {
    const runner = createRunner(async () => {
      throw new Error("detector child close was not observed");
    });
    mocks.createNodeCliProcessRunner.mockReturnValue(runner);
    mocks.detectCliBinaryMain.mockResolvedValue(null);

    const { CodexAppServerProcess } = await import("./process.js");
    const process = new CodexAppServerProcess({
      authorizeExecutable: async () => true,
      codexHomeDir: "/tmp/grimodex-codex",
    });

    await expect(process.start()).rejects.toThrow(
      "detector child close was not observed",
    );
    expect(runner.disposeAll).toHaveBeenCalledOnce();
    expect(runner.quiesceForProfileEgress).toHaveBeenCalledOnce();
  });
});
