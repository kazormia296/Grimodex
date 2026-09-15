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

    const { CodexAppServerProcess, CodexAppServerTerminationUnconfirmedError } =
      await import("./process.js");
    const process = new CodexAppServerProcess({
      authorizeExecutable: async () => true,
      codexHomeDir: "/tmp/grimodex-codex",
    });

    await expect(process.start()).rejects.toBeInstanceOf(
      CodexAppServerTerminationUnconfirmedError,
    );
    expect(runner.disposeAll).toHaveBeenCalledOnce();
    expect(runner.quiesceForProfileEgress).toHaveBeenCalledOnce();
  });

  it("awaits the close barrier when disposeAll throws and preserves both causes", async () => {
    let rejectChildClose!: (cause: Error) => void;
    const childClose = new Promise<void>((_resolve, reject) => {
      rejectChildClose = reject;
    });
    const disposeError = new Error("detector dispose failed");
    const barrierError = new Error("detector child close was not observed");
    const runner = createRunner(() => childClose);
    runner.disposeAll.mockImplementation(() => {
      throw disposeError;
    });
    mocks.createNodeCliProcessRunner.mockReturnValue(runner);
    mocks.detectCliBinaryMain.mockResolvedValue(null);

    const { CodexAppServerProcess } = await import("./process.js");
    const process = new CodexAppServerProcess({
      authorizeExecutable: async () => true,
      codexHomeDir: "/tmp/grimodex-codex",
    });
    let settled = false;
    const starting = process.start().catch((cause: unknown) => {
      settled = true;
      return cause;
    });

    await vi.waitFor(() =>
      expect(runner.quiesceForProfileEgress).toHaveBeenCalledOnce(),
    );
    expect(settled).toBe(false);

    rejectChildClose(barrierError);
    const failure = await starting;
    expect(failure).toMatchObject({
      name: "CodexAppServerTerminationUnconfirmedError",
      message: "Codex CLI detector child termination was not confirmed",
    });
    expect(failure).toHaveProperty("cause");
    expect((failure as Error & { cause: unknown }).cause).toMatchObject({
      name: "AggregateError",
      errors: expect.arrayContaining([disposeError, barrierError]),
    });
  });

  it("bounds a detector barrier that never settles", async () => {
    const runner = createRunner(() => new Promise<void>(() => {}));
    mocks.createNodeCliProcessRunner.mockReturnValue(runner);
    mocks.detectCliBinaryMain.mockResolvedValue(null);

    const { CodexAppServerProcess, CodexAppServerTerminationUnconfirmedError } =
      await import("./process.js");
    const process = new CodexAppServerProcess({
      authorizeExecutable: async () => true,
      codexHomeDir: "/tmp/grimodex-codex",
      forceKillAfterMs: 1,
    });
    const timeout = Symbol("detector timeout");
    const result = await Promise.race([
      process.start().then(
        () => null,
        (cause: unknown) => cause,
      ),
      new Promise<typeof timeout>((resolve) => {
        setTimeout(() => resolve(timeout), 250);
      }),
    ]);

    expect(result).not.toBe(timeout);
    expect(result).toBeInstanceOf(CodexAppServerTerminationUnconfirmedError);
  });

  it("keeps a dispose failure non-typed when the close barrier succeeds", async () => {
    const disposeError = new Error("detector dispose failed");
    const runner = createRunner(async () => {});
    runner.disposeAll.mockImplementation(() => {
      throw disposeError;
    });
    mocks.createNodeCliProcessRunner.mockReturnValue(runner);
    mocks.detectCliBinaryMain.mockResolvedValue(null);

    const { CodexAppServerProcess, CodexAppServerTerminationUnconfirmedError } =
      await import("./process.js");
    const process = new CodexAppServerProcess({
      authorizeExecutable: async () => true,
      codexHomeDir: "/tmp/grimodex-codex",
    });

    const failure = await process.start().catch((cause: unknown) => cause);
    expect(failure).toBe(disposeError);
    expect(failure).not.toBeInstanceOf(
      CodexAppServerTerminationUnconfirmedError,
    );
    expect(runner.quiesceForProfileEgress).toHaveBeenCalledOnce();
  });
});
