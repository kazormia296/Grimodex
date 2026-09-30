import { describe, expect, it, vi } from "vitest";
import {
  createQuiescenceProviderId,
  flushQuiescenceProviderStage,
  QuiescenceProviderStageError,
  registerQuiescenceProvider,
  type QuiescenceProviderId,
  type QuiescenceProviderFlushOptions,
} from "./quiescenceProviders";

function provider(
  id: string,
  flush: () => Promise<void>,
): Parameters<typeof registerQuiescenceProvider>[0] {
  return {
    id: createQuiescenceProviderId(id),
    stage: "timelapse",
    flush,
  };
}

describe("quiescence provider registry", () => {
  it("validates stable ids before they enter the registry", () => {
    expect(createQuiescenceProviderId("valid-provider-1")).toBe(
      "valid-provider-1",
    );
    expect(() => createQuiescenceProviderId("UpperCase")).toThrow(
      /\[a-z0-9-\]/,
    );
    expect(() => createQuiescenceProviderId("provider with spaces")).toThrow();
    expect(() => createQuiescenceProviderId("p".repeat(65))).toThrow();
    expect(() =>
      registerQuiescenceProvider({
        id: "unsafe_id" as unknown as QuiescenceProviderId,
        stage: "timelapse",
        flush: async () => {},
      }),
    ).toThrow(/\[a-z0-9-\]/);
  });

  it("runs every provider in registration order and preserves every rejection", async () => {
    const order: string[] = [];
    const first = new Error("first secret");
    const second = { secret: "non-error payload" };
    const nested = new AggregateError(["nested secret"], "nested failure");
    const unregister = [
      registerQuiescenceProvider(
        provider("test-all-run-first", async () => {
          order.push("first");
          throw first;
        }),
      ),
      registerQuiescenceProvider(
        provider("test-all-run-second", async () => {
          order.push("second");
          throw second;
        }),
      ),
      registerQuiescenceProvider(
        provider("test-all-run-third", async () => {
          order.push("third");
          throw nested;
        }),
      ),
    ];

    try {
      const caught = await flushQuiescenceProviderStage("timelapse").catch(
        (error: unknown) => error,
      );
      expect(caught).toBeInstanceOf(QuiescenceProviderStageError);
      const error = caught as QuiescenceProviderStageError;
      expect(order).toEqual(["first", "second", "third"]);
      expect(error.errors).toEqual([first, second, nested]);
      expect(
        error.providerFailures.map((failure) => failure.providerId),
      ).toEqual([
        "test-all-run-first",
        "test-all-run-second",
        "test-all-run-third",
      ]);
      expect(
        error.providerFailures.map((failure) => failure.originalError),
      ).toEqual([first, second, nested]);
      expect(error.errors[0]).toBe(first);
      expect(error.errors[1]).toBe(second);
      expect(error.errors[2]).toBe(nested);
      expect(error.providerFailures[0]?.originalError).toBe(first);
      expect(error.providerFailures[1]?.originalError).toBe(second);
      expect(error.providerFailures[2]?.originalError).toBe(nested);
    } finally {
      unregister.reverse().forEach((remove) => remove());
    }
  });

  it("keeps a revoked rejection by reference and still flushes later providers", async () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const later = vi.fn(async () => {});
    const unregister = [
      registerQuiescenceProvider(
        provider("test-revoked-first", async () => {
          throw revoked.proxy;
        }),
      ),
      registerQuiescenceProvider(provider("test-revoked-later", later)),
    ];

    try {
      const caught = await flushQuiescenceProviderStage("timelapse").catch(
        (error: unknown) => error,
      );
      expect(caught).toBeInstanceOf(QuiescenceProviderStageError);
      const error = caught as QuiescenceProviderStageError;
      expect(later).toHaveBeenCalledOnce();
      expect(error.errors[0]).toBe(revoked.proxy);
      expect(error.providerFailures[0]?.originalError).toBe(revoked.proxy);
    } finally {
      unregister.reverse().forEach((remove) => remove());
    }
  });

  it("fails fast on duplicate stage/id while an old unregister cannot remove the replacement", async () => {
    const firstFlush = vi.fn(async () => {});
    const replacementFlush = vi.fn(async () => {});
    const first = provider("test-duplicate-key", firstFlush);
    const unregisterFirst = registerQuiescenceProvider(first);
    expect(() =>
      registerQuiescenceProvider(
        provider("test-duplicate-key", async () => {}),
      ),
    ).toThrow(/Duplicate quiescence provider registration/);

    unregisterFirst();
    const unregisterReplacement = registerQuiescenceProvider(
      provider("test-duplicate-key", replacementFlush),
    );
    unregisterFirst();

    try {
      await flushQuiescenceProviderStage("timelapse");
      expect(firstFlush).not.toHaveBeenCalled();
      expect(replacementFlush).toHaveBeenCalledOnce();
    } finally {
      unregisterReplacement();
    }
  });

  it("resolves without a diagnostic error when every provider succeeds", async () => {
    const flush = vi.fn(async () => {});
    const unregister = registerQuiescenceProvider(
      provider("test-success", flush),
    );
    try {
      await expect(
        flushQuiescenceProviderStage("timelapse"),
      ).resolves.toBeUndefined();
      expect(flush).toHaveBeenCalledOnce();
    } finally {
      unregister();
    }
  });

  it("passes a preexisting-draft permit through the provider stage", async () => {
    const flush = vi.fn(
      async (_options?: QuiescenceProviderFlushOptions) => {},
    );
    const unregister = registerQuiescenceProvider(
      provider("test-preexisting-draft", flush),
    );
    try {
      await flushQuiescenceProviderStage("timelapse", {
        preexistingDraft: true,
      });
      expect(flush).toHaveBeenCalledWith({ preexistingDraft: true });
    } finally {
      unregister();
    }
  });
});
