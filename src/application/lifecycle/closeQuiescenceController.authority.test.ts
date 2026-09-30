import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuiescenceLease } from "./quiescenceLease";

const acquireLease = vi.hoisted(() => vi.fn());

vi.mock("@/features/timelapse/genesisQuiescence", () => ({
  acquireQuiescenceLeaseAfterTimelapseGenesis: acquireLease,
}));

import { createCloseQuiescenceController } from "./closeQuiescenceController";
import {
  clearQuiescenceDiagnostics,
  getQuiescenceDiagnostics,
} from "./quiescenceDiagnostics";

function fakeLease(overrides: Partial<QuiescenceLease> = {}): QuiescenceLease {
  return {
    reason: "window-close",
    transition: null,
    openControlledReadPhase: vi.fn(),
    sealMutationAdmissionForControlledRead: vi.fn(),
    openTargetReadPhase: vi.fn(),
    sealReadsForAuthorityCommit: vi.fn(),
    release: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  acquireLease.mockReset();
  clearQuiescenceDiagnostics();
});

describe("close authority phase attribution", () => {
  it("attributes a discard target-read failure to authority-quiescence", async () => {
    const authorityError = new Error("target read authority failed");
    const lease = fakeLease({
      openTargetReadPhase: vi.fn(() => {
        throw authorityError;
      }),
    });
    acquireLease.mockResolvedValue(lease);
    const onFailure = vi.fn();
    const controller = createCloseQuiescenceController({
      hasImmediateVeto: () => false,
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      onFailure,
    });

    controller.discardAndClose();
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledOnce());

    expect(onFailure.mock.calls[0]?.[0]).toBe(authorityError);
    expect(onFailure.mock.calls[0]?.[1]).toBe("authority-quiescence");
    expect(getQuiescenceDiagnostics()).toEqual([
      { closePhase: "authority-quiescence", errorName: "Error" },
    ]);
  });

  it("attributes a discard read-seal failure to authority-quiescence", async () => {
    const authorityError = new Error("read seal failed");
    const lease = fakeLease({
      sealReadsForAuthorityCommit: vi.fn(() => {
        throw authorityError;
      }),
    });
    acquireLease.mockResolvedValue(lease);
    const onFailure = vi.fn();
    const controller = createCloseQuiescenceController({
      hasImmediateVeto: () => false,
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      onFailure,
    });

    controller.discardAndClose();
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledOnce());

    expect(onFailure.mock.calls[0]?.[0]).toBe(authorityError);
    expect(onFailure.mock.calls[0]?.[1]).toBe("authority-quiescence");
  });

  it("does not enter native-close until the authority phase has sealed reads", async () => {
    const order: string[] = [];
    const lease = fakeLease({
      openTargetReadPhase: vi.fn(() => order.push("open")),
      sealReadsForAuthorityCommit: vi.fn(() => order.push("seal")),
    });
    acquireLease.mockResolvedValue(lease);
    const close = vi.fn(async () => {
      order.push("close");
    });
    const controller = createCloseQuiescenceController({
      hasImmediateVeto: () => false,
      flush: vi.fn(async () => {}),
      close,
      onFailure: vi.fn(),
    });

    controller.discardAndClose();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());

    expect(order).toEqual(["open", "seal", "close"]);
    expect(lease.release).toHaveBeenCalledWith({
      disposition: "renderer-teardown",
    });
  });

  it("keeps genesis failures in genesis-prelude before acquiring authority", async () => {
    const genesisError = new Error("genesis prelude failed");
    acquireLease.mockRejectedValue(genesisError);
    const onFailure = vi.fn();
    const controller = createCloseQuiescenceController({
      hasImmediateVeto: () => false,
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      onFailure,
    });

    controller.discardAndClose();
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledOnce());

    expect(onFailure.mock.calls[0]?.[0]).toBe(genesisError);
    expect(onFailure.mock.calls[0]?.[1]).toBe("genesis-prelude");
  });
});
